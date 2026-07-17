import { describe, it, expect } from 'vitest'
import type { EDL } from '../edl/types'
import type { Word } from '../transcript/types'
import { createEdl } from '../edl/edl'
import { runAgent, type AgentReply, type AgentTransport } from './run'

const SOURCE = { id: 's1', url: 'blob:test', duration: 10 }

function ranges(edl: EDL): Array<[number, number]> {
  return edl.segments.map((seg) => [seg.start, seg.end])
}

function timed(...specs: Array<[string, number, number]>): Word[] {
  return specs.map(([text, start, end]) => ({ text, start, end }))
}

// Fixture: a 2s silence (gap 2–4) and one filler word ("um", 1–2).
const TRANSCRIPT = {
  words: timed(['Hello', 0, 1], ['um', 1, 2], ['world', 4, 5]),
}

function toolUse(name: string, input: unknown, id: string): AgentReply {
  return { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' }
}

function endTurn(text: string): AgentReply {
  return {
    content: text === '' ? [] : [{ type: 'text', text }],
    stop_reason: 'end_turn',
  }
}

// A transport that replays scripted replies in order (clamping to the last one),
// and records a JSON snapshot of the messages it was handed on each call.
function scripted(replies: AgentReply[]): {
  transport: AgentTransport
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  let i = 0
  const transport: AgentTransport = (messages) => {
    calls.push(JSON.parse(JSON.stringify(messages)) as unknown[])
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    return Promise.resolve(reply)
  }
  return { transport, calls }
}

// Pull the parsed tool_result payloads out of a messages snapshot.
function toolResultPayloads(messages: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result'
      ) {
        out.push(
          JSON.parse((block as { content: string }).content) as Record<
            string,
            unknown
          >,
        )
      }
    }
  }
  return out
}

describe('runAgent', () => {
  it('runs a tool, threads the result, and reports client-side numbers', async () => {
    const { transport, calls } = scripted([
      // keep_gap_ms: 0 keeps the round numbers below AND proves the loop passes
      // it through — with the 250ms default the removed seconds would be 1.75.
      toolUse('remove_silences', { threshold_ms: 600, keep_gap_ms: 0 }, 'tu_1'),
      endTurn('Removed the silence.'),
    ])

    const result = await runAgent(
      'remove the silences',
      createEdl(SOURCE),
      TRANSCRIPT,
      transport,
    )

    expect(ranges(result.edl)).toEqual([
      [0, 2],
      [4, 10],
    ])
    expect(result.keptBefore).toBeCloseTo(10)
    expect(result.keptAfter).toBeCloseTo(8)
    expect(result.iterations).toBe(2)
    expect(result.text).toBe('Removed the silence.')
    expect(result.toolsRun).toHaveLength(1)
    expect(result.toolsRun[0].name).toBe('remove_silences')
    expect(result.toolsRun[0].removed_seconds).toBeCloseTo(2)

    // The new kept duration was fed back to the model on the second call.
    expect(toolResultPayloads(calls[1])).toEqual([
      { ok: true, removed_count: 1, removed_seconds: 2, new_kept_duration: 8 },
    ])
  })

  it('threads the working EDL across turns so later tools see earlier cuts', async () => {
    const { transport } = scripted([
      // keep_gap_ms: 0 keeps the round numbers below AND proves the loop passes
      // it through — with the 250ms default the removed seconds would be 1.75.
      toolUse('remove_silences', { threshold_ms: 600, keep_gap_ms: 0 }, 'tu_1'),
      toolUse('remove_filler_words', {}, 'tu_2'),
      endTurn('Done.'),
    ])

    const result = await runAgent('clean it up', createEdl(SOURCE), TRANSCRIPT, transport)

    // Silence [2,4] then filler "um" [1,2] both removed from the one working EDL.
    expect(ranges(result.edl)).toEqual([
      [0, 1],
      [4, 10],
    ])
    expect(result.keptAfter).toBeCloseTo(7)
    expect(result.iterations).toBe(3)
    expect(result.toolsRun.map((t) => t.name)).toEqual([
      'remove_silences',
      'remove_filler_words',
    ])
  })

  it('dispatches remove_stumbles and feeds the result back', async () => {
    // "the the cat": an immediate repeat; the range ends at the kept "the".
    const transcript = {
      words: timed(['the', 0, 1], ['the', 1, 2], ['cat', 2, 3]),
    }
    const { transport, calls } = scripted([
      toolUse('remove_stumbles', {}, 'tu_1'),
      endTurn('Cleaned up the stumbles.'),
    ])

    const result = await runAgent(
      'remove my stumbles',
      createEdl(SOURCE),
      transcript,
      transport,
    )

    expect(ranges(result.edl)).toEqual([[1, 10]])
    expect(result.toolsRun.map((t) => t.name)).toEqual(['remove_stumbles'])
    expect(toolResultPayloads(calls[1])).toEqual([
      { ok: true, removed_count: 1, removed_seconds: 1, new_kept_duration: 9 },
    ])
  })

  it('dispatches generate_captions and reports captions_count', async () => {
    const { transport, calls } = scripted([
      toolUse('generate_captions', {}, 'tu_1'),
      endTurn('Captions added.'),
    ])

    const result = await runAgent(
      'add captions',
      createEdl(SOURCE),
      TRANSCRIPT,
      transport,
    )

    // The kept 2s pause (um ends 2, world starts 4) breaks the line in two.
    expect(result.edl.captions.map((c) => c.text)).toEqual(['Hello um', 'world'])
    expect(ranges(result.edl)).toEqual([[0, 10]]) // nothing removed
    expect(result.toolsRun.map((t) => t.name)).toEqual(['generate_captions'])
    expect(toolResultPayloads(calls[1])).toEqual([
      {
        ok: true,
        removed_count: 0,
        removed_seconds: 0,
        new_kept_duration: 10,
        captions_count: 2,
      },
    ])
  })

  it('captions generated after cuts reflect the final edit', async () => {
    const { transport, calls } = scripted([
      toolUse('remove_silences', { threshold_ms: 600, keep_gap_ms: 0 }, 'tu_1'),
      toolUse('generate_captions', {}, 'tu_2'),
      endTurn('Tightened and captioned.'),
    ])

    const result = await runAgent(
      'tighten this up and add captions',
      createEdl(SOURCE),
      TRANSCRIPT,
      transport,
    )

    // The silence [2,4] is gone, so the output gap between "um" and "world" is
    // ~0 and the words share ONE caption spanning the cut (output-time chunking
    // against the WORKING EDL, not the original).
    expect(ranges(result.edl)).toEqual([
      [0, 2],
      [4, 10],
    ])
    expect(result.edl.captions.map((c) => c.text)).toEqual(['Hello um world'])
    expect(toolResultPayloads(calls[2])).toEqual([
      { ok: true, removed_count: 1, removed_seconds: 2, new_kept_duration: 8 },
      {
        ok: true,
        removed_count: 0,
        removed_seconds: 0,
        new_kept_duration: 8,
        captions_count: 1,
      },
    ])
  })

  it('stops at the iteration cap when the model keeps calling tools', async () => {
    const { transport } = scripted([
      toolUse('remove_silences', { threshold_ms: 600, keep_gap_ms: 0 }, 'tu'),
    ])

    const result = await runAgent('loop', createEdl(SOURCE), TRANSCRIPT, transport)

    expect(result.iterations).toBe(6)
    // First call removed the gap; re-removals are safe no-ops, so it's stable.
    expect(result.keptAfter).toBeCloseTo(8)
  })

  it('reports an unknown tool back without throwing or editing', async () => {
    const { transport, calls } = scripted([
      toolUse('bogus_tool', {}, 'tu_x'),
      endTurn(''),
    ])

    const result = await runAgent('do magic', createEdl(SOURCE), TRANSCRIPT, transport)

    expect(result.toolsRun).toHaveLength(0)
    expect(result.keptAfter).toBeCloseTo(10)
    const payloads = toolResultPayloads(calls[1])
    expect(payloads).toHaveLength(1)
    expect(payloads[0].ok).toBe(false)
  })

  it('is a no-op when the model ends without calling a tool', async () => {
    const edl = createEdl(SOURCE)
    const { transport } = scripted([endTurn('Nothing to do.')])

    const result = await runAgent('hello', edl, TRANSCRIPT, transport)

    expect(result.edl).toBe(edl)
    expect(result.toolsRun).toEqual([])
    expect(result.iterations).toBe(1)
    expect(result.keptBefore).toBeCloseTo(10)
    expect(result.keptAfter).toBeCloseTo(10)
  })

  it('sends the command and transcript context in the first message', async () => {
    const { transport, calls } = scripted([endTurn('ok')])
    await runAgent('remove the silences', createEdl(SOURCE), TRANSCRIPT, transport)

    const firstMessage = (calls[0][0] as { content: string }).content
    expect(firstMessage).toContain('remove the silences')
    expect(firstMessage).toContain('Hello: 0.00-1.00')
  })
})
