// The client-side agent loop — the orchestrator half of the stateless-relay
// design. It owns the Anthropic-format `messages` array and a WORKING copy of the
// EDL; the proxy only relays one call at a time. On each `tool_use` the matching
// pure executor runs against the working EDL (so the next turn sees the effect),
// a tool_result is fed back, and we POST again — until Claude stops or the cap.
//
// Numbers are CLIENT-side and authoritative (tools run, kept duration
// before→after, computed here from the EDL). Claude's text is narration only.
//
// The caller commits the returned EDL ONCE via the existing `commitEdl`, so the
// whole command is a single Undo.

import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import { totalKeptDuration } from '../edl/edl'
import {
  DEFAULT_SILENCE_MS,
  cutSegment,
  removeFillerWords,
  removeSilences,
  removeStumbles,
  trimToDuration,
  type ToolResult,
} from './tools'

// What the proxy relays back: Claude's raw content blocks + the stop reason.
export type AgentReply = { content: unknown; stop_reason: unknown }

// A transport from `messages` to a relayed reply. Injectable so the loop can be
// driven offline in tests; defaults to the real `/api/agent` POST.
export type AgentTransport = (messages: unknown[]) => Promise<AgentReply>

export type AgentToolRun = {
  name: string
  removed_count: number
  removed_seconds: number
}

export type AgentRunResult = {
  edl: EDL
  toolsRun: AgentToolRun[]
  keptBefore: number
  keptAfter: number
  iterations: number
  text: string
}

// One Anthropic message. `content` is a string (the first user turn), Claude's
// echoed-back content blocks (assistant turn), or our tool_result blocks (user
// turn) — all we do with it is serialize it back to the proxy.
type ChatMessage = { role: 'user' | 'assistant'; content: unknown }

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

// Cap on round-trips so a confused model can't loop forever.
const MAX_ITERATIONS = 6

function isToolUse(block: unknown): block is ToolUseBlock {
  if (typeof block !== 'object' || block === null) {
    return false
  }
  const b = block as { type?: unknown; id?: unknown; name?: unknown }
  return (
    b.type === 'tool_use' &&
    typeof b.id === 'string' &&
    typeof b.name === 'string'
  )
}

// Concatenate any text blocks in a content array (Claude's narration).
function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join(' ').trim()
}

// Build the first user message: the command plus a compact context block (the
// transcript as "<text>: <start>-<end>" lines + current kept duration). The
// proxy owns the system prompt; the client owns the messages and this context.
function buildFirstMessage(
  command: string,
  edl: EDL,
  transcript: Transcript,
): string {
  const lines = transcript.words
    .map((w) => `${w.text}: ${w.start.toFixed(2)}-${w.end.toFixed(2)}`)
    .join('\n')
  const kept = totalKeptDuration(edl).toFixed(2)
  return (
    `Command: ${command}\n\n` +
    `Current kept duration: ${kept}s\n\n` +
    `Transcript (word: start-end in source seconds):\n${lines}`
  )
}

// Dispatch a selected tool to its pure executor, narrowing Claude's untyped
// `input` per tool. Returns null for an unknown tool or invalid arguments, so
// the loop can report the failure back to Claude instead of throwing.
function runTool(
  name: string,
  input: unknown,
  edl: EDL,
  transcript: Transcript,
): ToolResult | null {
  const args = (typeof input === 'object' && input !== null ? input : {}) as {
    start?: unknown
    end?: unknown
    threshold_ms?: unknown
    keep_gap_ms?: unknown
    words?: unknown
    target_seconds?: unknown
  }

  switch (name) {
    case 'cut_segment': {
      if (typeof args.start !== 'number' || typeof args.end !== 'number') {
        return null
      }
      return cutSegment(edl, transcript, { start: args.start, end: args.end })
    }
    case 'remove_silences': {
      const threshold_ms =
        typeof args.threshold_ms === 'number'
          ? args.threshold_ms
          : DEFAULT_SILENCE_MS
      const keep_gap_ms =
        typeof args.keep_gap_ms === 'number' ? args.keep_gap_ms : undefined
      return removeSilences(edl, transcript, { threshold_ms, keep_gap_ms })
    }
    case 'remove_filler_words': {
      const words = Array.isArray(args.words)
        ? args.words.filter((w): w is string => typeof w === 'string')
        : undefined
      return removeFillerWords(edl, transcript, { words })
    }
    case 'remove_stumbles': {
      return removeStumbles(edl, transcript)
    }
    case 'trim_to_duration': {
      if (typeof args.target_seconds !== 'number') {
        return null
      }
      return trimToDuration(edl, transcript, {
        target_seconds: args.target_seconds,
      })
    }
    default:
      return null
  }
}

async function postAgent(messages: unknown[]): Promise<AgentReply> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!res.ok) {
    let detail = `The agent request failed (HTTP ${res.status}).`
    try {
      const data: unknown = await res.json()
      if (
        typeof data === 'object' &&
        data !== null &&
        typeof (data as { error?: unknown }).error === 'string'
      ) {
        detail = (data as { error: string }).error
      }
    } catch {
      // Body was not JSON; keep the generic message.
    }
    throw new Error(detail)
  }
  const data: unknown = await res.json()
  if (typeof data !== 'object' || data === null) {
    throw new Error('Received a malformed response from the agent.')
  }
  const { content, stop_reason } = data as {
    content: unknown
    stop_reason: unknown
  }
  return { content, stop_reason }
}

/**
 * Run one natural-language command. Threads a working EDL through the model's
 * turns and returns it (uncommitted) along with the client-computed summary. The
 * caller commits the EDL once and renders the summary. `transport` defaults to
 * the real proxy POST; tests inject a stub.
 */
export async function runAgent(
  command: string,
  edl: EDL,
  transcript: Transcript,
  transport: AgentTransport = postAgent,
): Promise<AgentRunResult> {
  const keptBefore = totalKeptDuration(edl)
  let working = edl
  const toolsRun: AgentToolRun[] = []
  const messages: ChatMessage[] = [
    { role: 'user', content: buildFirstMessage(command, edl, transcript) },
  ]
  let text = ''
  let iterations = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations++
    const reply = await transport(messages)
    messages.push({ role: 'assistant', content: reply.content })
    text = textOf(reply.content) || text

    if (reply.stop_reason !== 'tool_use' || !Array.isArray(reply.content)) {
      break
    }

    const toolResults: ToolResultBlock[] = []
    for (const block of reply.content) {
      if (!isToolUse(block)) {
        continue
      }
      const result = runTool(block.name, block.input, working, transcript)
      if (result === null) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error: `Unknown or invalid tool: ${block.name}`,
          }),
        })
        continue
      }
      working = result.edl
      toolsRun.push({
        name: block.name,
        removed_count: result.removed_count,
        removed_seconds: result.removed_seconds,
      })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify({
          ok: true,
          removed_count: result.removed_count,
          removed_seconds: result.removed_seconds,
          new_kept_duration: totalKeptDuration(working),
        }),
      })
    }

    // No actionable tool_use blocks — nothing to send back, so stop.
    if (toolResults.length === 0) {
      break
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return {
    edl: working,
    toolsRun,
    keptBefore,
    keptAfter: totalKeptDuration(working),
    iterations,
    text,
  }
}
