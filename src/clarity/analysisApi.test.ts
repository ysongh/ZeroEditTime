import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../agent/api'
import {
  CLARITY_ANALYSIS_MODE,
  CLARITY_ANALYSIS_TOOL_NAME,
} from './analysis'
import {
  CLARITY_ANALYSIS_TIMEOUT_MS,
  ClarityAnalysisCancelledError,
  analyzeClarityContext,
} from './analysisApi'
import type { ClarityAnalysisContext } from './context'
import { CLARITY_LIMITS } from './limits'

const CONTEXT: ClarityAnalysisContext = {
  currentDurationSeconds: 60,
  settings: {
    targetDurationSeconds: 30,
    audience: 'Developers',
    mustStay: 'Keep the setup and result.',
  },
  sentences: [
    {
      sentenceId: 'sentence:0:1',
      removable: true,
      durationSeconds: 10,
      parts: [{ kind: 'speech', text: 'Install the package.' }],
    },
    {
      sentenceId: 'sentence:2:3',
      removable: true,
      durationSeconds: 10,
      parts: [{ kind: 'speech', text: 'As I mentioned, install the package.' }],
    },
    {
      sentenceId: 'sentence:4:5',
      removable: false,
      durationSeconds: 5,
      parts: [{ kind: 'partial-word' }, { kind: 'cut' }],
    },
  ],
}

const SUGGESTION = {
  sentenceId: 'sentence:2:3',
  reason: 'repeated-explanation',
  explanation: 'The preceding sentence already explains this step.',
} as const

function reply(input: unknown = { suggestions: [] }) {
  return {
    content: [{
      type: 'tool_use',
      id: 'toolu_clarity',
      name: CLARITY_ANALYSIS_TOOL_NAME,
      input,
    }],
    stop_reason: 'tool_use',
  }
}

function response(input: unknown = { suggestions: [] }): Response {
  return Response.json(reply(input))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('analyzeClarityContext', () => {
  it('sends one whitelisted request through the shared transport without media or credentials', async () => {
    const context = {
      ...CONTEXT,
      videoBase64: 'RAW_VIDEO_SENTINEL',
      apiKey: 'CLIENT_KEY_SENTINEL',
      fullTranscript: 'DELETED_TRANSCRIPT_SENTINEL',
      settings: {
        ...CONTEXT.settings,
        audience: '  Developers  ',
        model: 'CLIENT_MODEL_SENTINEL',
      },
      sentences: CONTEXT.sentences.map((sentence) => ({
        ...sentence,
        sourceRange: { start: 100, end: 200 },
        originalText: 'ORIGINAL_TEXT_SENTINEL',
        parts: sentence.parts.map((part) => ({
          ...part,
          frame: 'RAW_FRAME_SENTINEL',
        })),
      })),
    }
    const before = structuredClone(context)
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(
      response({ suggestions: [SUGGESTION] }),
    )

    await expect(analyzeClarityContext(context, fetchImpl)).resolves.toEqual({
      suggestions: [SUGGESTION],
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/agent')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual({
      mode: CLARITY_ANALYSIS_MODE,
      context: CONTEXT,
    })
    expect(String(init?.body)).not.toContain('SENTINEL')
    expect(String(init?.body)).not.toContain('sourceRange')
    expect(context).toEqual(before)
  })

  it('accepts an empty result without retrying to force the requested duration', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response())

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).resolves.toEqual({
      suggestions: [],
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('normalizes duplicate suggestions in original sentence order', async () => {
    const first = {
      ...SUGGESTION,
      sentenceId: 'sentence:0:1',
      explanation: '  A repeated setup detail.  ',
    }
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response({
      suggestions: [
        SUGGESTION,
        first,
        { ...SUGGESTION, explanation: 'A later duplicate explanation.' },
      ],
    }))

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).resolves.toEqual({
      suggestions: [
        { ...first, explanation: 'A repeated setup detail.' },
        SUGGESTION,
      ],
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('validates the response against its captured input instead of later caller mutations', async () => {
    const pending = deferred<Response>()
    const context = structuredClone(CONTEXT)
    const fetchImpl = vi.fn<FetchLike>().mockReturnValue(pending.promise)
    const analysis = analyzeClarityContext(context, fetchImpl)

    context.sentences[1].sentenceId = 'sentence:2:999'
    context.sentences[1].removable = false
    pending.resolve(response({ suggestions: [SUGGESTION] }))

    await expect(analysis).resolves.toEqual({ suggestions: [SUGGESTION] })
  })

  it.each([
    ['invalid', { ...CONTEXT, currentDurationSeconds: Number.NaN }],
    ['oversized', {
      ...CONTEXT,
      settings: { audience: 'x'.repeat(CLARITY_LIMITS.maxAudienceCharacters + 1) },
    }],
  ])('rejects %s context before any network request or timeout starts', async (_label, context) => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<FetchLike>()

    await expect(analyzeClarityContext(context, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['unknown IDs', { suggestions: [{ ...SUGGESTION, sentenceId: 'sentence:8:9' }] }],
    ['protected IDs', { suggestions: [{ ...SUGGESTION, sentenceId: 'sentence:4:5' }] }],
    ['an unknown reason', { suggestions: [{ ...SUGGESTION, reason: 'cut-it-all' }] }],
    ['timestamps', { suggestions: [{ ...SUGGESTION, start: 0, end: 100 }] }],
    ['replacement text', { suggestions: [{ ...SUGGESTION, replacement: 'New words.' }] }],
    ['a missing explanation', { suggestions: [{ sentenceId: SUGGESTION.sentenceId, reason: SUGGESTION.reason }] }],
    ['a malformed collection', { suggestions: null }],
  ])('rejects results containing %s without retrying', async (_label, input) => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response(input))

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Received a malformed clarity-analysis result.',
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a proposal removing every remaining speech sentence', async () => {
    const context = { ...CONTEXT, sentences: CONTEXT.sentences.slice(0, 2) }
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(response({
      suggestions: context.sentences.map(({ sentenceId }) => ({
        ...SUGGESTION,
        sentenceId,
      })),
    }))

    await expect(analyzeClarityContext(context, fetchImpl)).rejects.toThrow(
      'Received a malformed clarity-analysis result.',
    )
  })

  it.each([
    ['text only', { content: [{ type: 'text', text: 'No cuts.' }], stop_reason: 'end_turn' }],
    ['no tool', { content: [], stop_reason: 'tool_use' }],
    ['the wrong tool', {
      ...reply(),
      content: [{ ...reply().content[0], name: 'cut_segment' }],
    }],
    ['multiple tools', {
      ...reply(),
      content: [...reply().content, ...reply().content],
    }],
    ['a truncated result', { ...reply(), stop_reason: 'max_tokens' }],
    ['unexpected narration', {
      ...reply(),
      content: [{ type: 'text', text: 'Applied these cuts.' }, ...reply().content],
    }],
  ])('rejects %s as a structured response', async (_label, modelReply) => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(Response.json(modelReply))

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Received a malformed clarity-analysis result.',
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([null, '{"content":'])('rejects an empty or invalid JSON response', async (body) => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response(body))

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'Received a malformed response from the agent.',
    )
  })

  it('surfaces relay errors without an automatic retry', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(Response.json(
      { error: 'This recording is too large for one clarity analysis.' },
      { status: 413 },
    ))

    await expect(analyzeClarityContext(CONTEXT, fetchImpl)).rejects.toThrow(
      'This recording is too large for one clarity analysis.',
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([true, false])('settles on timeout even when transport honors abort: %s', async (honorsAbort) => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const add = vi.spyOn(caller.signal, 'addEventListener')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    let transportSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      transportSignal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        if (honorsAbort) {
          transportSignal?.addEventListener('abort', () => {
            reject(new DOMException('Transport stopped.', 'AbortError'))
          })
        }
      })
    })
    const analysis = analyzeClarityContext(
      CONTEXT, fetchImpl, CLARITY_ANALYSIS_TIMEOUT_MS, caller.signal,
    )
    const rejected = expect(analysis).rejects.toThrow('Clarity analysis timed out. Try again.')

    await vi.advanceTimersByTimeAsync(CLARITY_ANALYSIS_TIMEOUT_MS)
    await rejected

    expect(transportSignal?.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('uses the default deadline when a caller supplies an invalid timeout', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<FetchLike>().mockReturnValue(new Promise<Response>(() => {}))
    const analysis = analyzeClarityContext(CONTEXT, fetchImpl, Number.NaN)
    const rejected = expect(analysis).rejects.toThrow('Clarity analysis timed out. Try again.')

    await vi.advanceTimersByTimeAsync(CLARITY_ANALYSIS_TIMEOUT_MS)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects already cancelled work before validation, fetch, or a deadline', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    caller.abort()
    const fetchImpl = vi.fn<FetchLike>()

    await expect(analyzeClarityContext(
      { ...CONTEXT, currentDurationSeconds: Number.NaN },
      fetchImpl,
      CLARITY_ANALYSIS_TIMEOUT_MS,
      caller.signal,
    )).rejects.toEqual(new ClarityAnalysisCancelledError())
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'])('ignores a cancelled request’s late %s after a newer call completes', async (outcome) => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const add = vi.spyOn(caller.signal, 'addEventListener')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const pending = deferred<Response>()
    const fetchImpl = vi.fn<FetchLike>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response())
    const oldSuccess = vi.fn()
    const oldFailure = vi.fn()
    const old = analyzeClarityContext(
      CONTEXT, fetchImpl, CLARITY_ANALYSIS_TIMEOUT_MS, caller.signal,
    )
    const settled = old.then(oldSuccess, oldFailure)

    caller.abort()
    await settled
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const newer = await analyzeClarityContext(CONTEXT, fetchImpl)

    if (outcome === 'success') {
      pending.resolve(response({ suggestions: [SUGGESTION] }))
    } else {
      pending.reject(new Error('Obsolete network failure.'))
    }
    await vi.advanceTimersByTimeAsync(1)

    expect(newer).toEqual({ suggestions: [] })
    expect(oldSuccess).not.toHaveBeenCalled()
    expect(oldFailure).toHaveBeenCalledExactlyOnceWith(new ClarityAnalysisCancelledError())
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'network failure', 'invalid result'])('cleans its listener and deadline after %s', async (outcome) => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const add = vi.spyOn(caller.signal, 'addEventListener')
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const fetchImpl = vi.fn<FetchLike>()
    if (outcome === 'network failure') {
      fetchImpl.mockRejectedValue(new Error('Network unavailable.'))
    } else {
      fetchImpl.mockResolvedValue(response(outcome === 'success' ? { suggestions: [] } : null))
    }
    const analysis = analyzeClarityContext(
      CONTEXT, fetchImpl, CLARITY_ANALYSIS_TIMEOUT_MS, caller.signal,
    )

    if (outcome === 'success') {
      await expect(analysis).resolves.toEqual({ suggestions: [] })
    } else {
      await expect(analysis).rejects.toThrow()
    }

    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchImpl).toHaveBeenCalledOnce()
    caller.abort()
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false)
  })
})
