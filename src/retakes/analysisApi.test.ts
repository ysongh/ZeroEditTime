import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../agent/api'
import {
  RETAKE_ANALYSIS_MODE,
  RETAKE_ANALYSIS_TOOL_NAME,
} from './analysis'
import {
  RETAKE_ANALYSIS_TIMEOUT_MS,
  analyzeRetakeContext,
} from './analysisApi'
import type { RetakeAnalysisContext } from './context'

const CONTEXT: RetakeAnalysisContext = {
  candidate: {
    startSourceMs: 1_000,
    endSourceMs: 2_500,
    text: 'So the workflow um stops halfway through...',
  },
  before: { text: 'The previous sentence is here.' },
  after: { text: 'The following sentence is here.' },
  signals: {
    fillerCount: 3,
    fillerDensity: 0.3,
    longPauseCount: 1,
    longestPauseMs: 2_200,
    stumbleCount: 2,
  },
}

function modelReply(input: unknown): Response {
  return Response.json({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_result',
        name: RETAKE_ANALYSIS_TOOL_NAME,
        input,
      },
    ],
    stop_reason: 'tool_use',
  })
}

describe('analyzeRetakeContext', () => {
  it('posts only one bounded context through the existing secret-free relay', async () => {
    const input = {
      ...CONTEXT,
      fullTranscript: 'FULL_TRANSCRIPT_SENTINEL',
      candidate: {
        ...CONTEXT.candidate,
        privateNote: 'PRIVATE_NOTE_SENTINEL',
      },
      signals: { ...CONTEXT.signals, hiddenMetric: 42 },
    } as RetakeAnalysisContext
    const before = structuredClone(input)
    let requestedInput: RequestInfo | URL | undefined
    let requestedInit: RequestInit | undefined
    const fetchImpl: FetchLike = async (url, init) => {
      requestedInput = url
      requestedInit = init
      return modelReply({
        needsRetake: true,
        reason: 'incomplete-thought',
        severity: 'recommended',
        explanation: '  The thought does not reach a complete point.  ',
        suggestedScript: '  State the workflow as one complete sentence.  ',
        confidence: 0.82,
        modelOwnedId: 'discard-me',
      })
    }

    const result = await analyzeRetakeContext(input, fetchImpl)

    expect(result).toEqual({
      needsRetake: true,
      reason: 'incomplete-thought',
      severity: 'recommended',
      explanation: 'The thought does not reach a complete point.',
      suggestedScript: 'State the workflow as one complete sentence.',
      confidence: 0.82,
    })
    expect(requestedInput).toBe('/api/agent')
    expect(requestedInit?.method).toBe('POST')
    expect(requestedInit?.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(requestedInit?.headers).not.toHaveProperty('Authorization')
    expect(requestedInit?.headers).not.toHaveProperty('x-api-key')
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal)
    expect(requestedInit?.signal?.aborted).toBe(false)
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      mode: RETAKE_ANALYSIS_MODE,
      context: CONTEXT,
    })
    expect(String(requestedInit?.body)).not.toContain(
      'FULL_TRANSCRIPT_SENTINEL',
    )
    expect(String(requestedInit?.body)).not.toContain(
      'PRIVATE_NOTE_SENTINEL',
    )
    expect(input).toEqual(before)
  })

  it('keeps a model negative as an exact no-recommendation result', async () => {
    const fetchImpl: FetchLike = async () =>
      modelReply({
        needsRetake: false,
        confidence: 1.4,
        reason: 'severe-stumble',
        severity: 'strongly-recommended',
        explanation: '  A complete clean version already exists nearby.  ',
        suggestedScript: 'This must not survive.',
        id: 'model-id',
      })

    await expect(analyzeRetakeContext(CONTEXT, fetchImpl)).resolves.toEqual({
      needsRetake: false,
      explanation: 'A complete clean version already exists nearby.',
      confidence: 1,
    })
  })

  it('rejects malformed context before making a request', async () => {
    let calls = 0
    const fetchImpl: FetchLike = async () => {
      calls++
      return modelReply({ needsRetake: false, confidence: 1 })
    }
    const malformed = {
      ...CONTEXT,
      candidate: { ...CONTEXT.candidate, endSourceMs: 500 },
    }

    await expect(
      analyzeRetakeContext(malformed, fetchImpl),
    ).rejects.toThrow('Cannot analyze a malformed retake context.')
    expect(calls).toBe(0)
  })

  it.each([
    [
      'a text-only reply',
      { content: [{ type: 'text', text: 'No retake.' }], stop_reason: 'end_turn' },
    ],
    ['an empty tool reply', { content: [], stop_reason: 'tool_use' }],
    [
      'the wrong tool',
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_wrong',
            name: 'other_tool',
            input: { needsRetake: false, confidence: 1 },
          },
        ],
        stop_reason: 'tool_use',
      },
    ],
    [
      'multiple result tools',
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: RETAKE_ANALYSIS_TOOL_NAME,
            input: { needsRetake: false, confidence: 1 },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: RETAKE_ANALYSIS_TOOL_NAME,
            input: { needsRetake: false, confidence: 1 },
          },
        ],
        stop_reason: 'tool_use',
      },
    ],
    [
      'invalid positive input',
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bad',
            name: RETAKE_ANALYSIS_TOOL_NAME,
            input: { needsRetake: true, confidence: 0.5 },
          },
        ],
        stop_reason: 'tool_use',
      },
    ],
  ])('rejects %s instead of guessing', async (_name, reply) => {
    const fetchImpl: FetchLike = async () => Response.json(reply)

    await expect(analyzeRetakeContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Received a malformed retake-analysis result.',
    )
  })

  it('surfaces the existing relay error message', async () => {
    const fetchImpl: FetchLike = async () =>
      Response.json({ error: 'Retake analysis is unavailable.' }, { status: 502 })

    await expect(analyzeRetakeContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Retake analysis is unavailable.',
    )
  })

  it('rejects an empty successful response body', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, { status: 200 })

    await expect(analyzeRetakeContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Received a malformed response from the agent.',
    )
  })

  it('aborts and reports a controlled error when one analysis times out', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | null | undefined
      const fetchImpl: FetchLike = async (_input, init) => {
        signal = init?.signal
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The request was aborted.', 'AbortError'))
          })
        })
      }

      const analysis = analyzeRetakeContext(CONTEXT, fetchImpl)
      const rejection = expect(analysis).rejects.toThrow(
        'Retake analysis timed out. Try again.',
      )
      await vi.advanceTimersByTimeAsync(RETAKE_ANALYSIS_TIMEOUT_MS)

      await rejection
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the request deadline after an ordinary failure', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl: FetchLike = async () => {
        throw new Error('Network unavailable.')
      }

      await expect(
        analyzeRetakeContext(CONTEXT, fetchImpl),
      ).rejects.toThrow('Network unavailable.')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the request deadline after a successful response', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl: FetchLike = async () =>
        modelReply({ needsRetake: false, confidence: 0.9 })

      await expect(
        analyzeRetakeContext(CONTEXT, fetchImpl),
      ).resolves.toEqual({ needsRetake: false, confidence: 0.9 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
