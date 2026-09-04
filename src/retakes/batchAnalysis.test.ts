import { describe, expect, it } from 'vitest'
import type { Transcript } from '../transcript/types'
import type { RetakeAnalysisResult } from './analysis'
import {
  analyzeRetakes,
  clearRetakeAnalysisSessionCaches,
  type RetakeBatchProgress,
} from './batchAnalysis'
import type { RetakeAnalysisContext } from './context'
import { MAX_RETAKE_ANALYSIS_CANDIDATES } from './costControls'
import { getRetakeRecommendationFreshness } from './freshness'

const FAILED_DASHBOARD = [
  'The',
  'dashboard',
  'lets',
  'you',
  'um',
  'manage',
  'uh',
  'all',
  'er',
  'projects...',
] as const

const CLEAN_DASHBOARD = [
  'The',
  'dashboard',
  'lets',
  'you',
  'manage',
  'all',
  'projects.',
] as const

function sequential(...texts: readonly string[]): Transcript {
  return {
    words: texts.map((text, index) => ({
      text,
      start: index * 0.4,
      end: index * 0.4 + 0.3,
    })),
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const POSITIVE_RESULT: RetakeAnalysisResult = {
  needsRetake: true,
  reason: 'incomplete-thought',
  severity: 'recommended',
  explanation: 'The explanation never reaches a complete point.',
  suggestedScript: 'Explain the dashboard workflow in one complete sentence.',
  confidence: 0.83,
}

const NEGATIVE_RESULT: RetakeAnalysisResult = {
  needsRetake: false,
  explanation: 'Editing can produce a clean result.',
  confidence: 0.91,
}

describe('analyzeRetakes', () => {
  it('returns an empty success without analysis when local screening finds nothing', async () => {
    let calls = 0
    const analyzeContext = async (): Promise<RetakeAnalysisResult> => {
      calls++
      return NEGATIVE_RESULT
    }
    const cleanProgress: RetakeBatchProgress[] = []
    const cleanTranscript = sequential('This', 'section', 'is', 'clear.')
    const cleanBefore = structuredClone(cleanTranscript)

    await expect(
      analyzeRetakes(cleanTranscript, 10_000, {
        analyzeContext,
        onProgress: (progress) => cleanProgress.push(progress),
      }),
    ).resolves.toEqual({
      candidateCount: 0,
      analyzedCount: 0,
      recommendations: [],
    })
    expect(cleanProgress).toEqual([{ completed: 0, total: 0 }])
    expect(cleanTranscript).toEqual(cleanBefore)

    const nearbyCleanTake = sequential(
      ...FAILED_DASHBOARD,
      ...CLEAN_DASHBOARD,
    )
    await expect(
      analyzeRetakes(nearbyCleanTake, 20_000, { analyzeContext }),
    ).resolves.toMatchObject({ candidateCount: 0, recommendations: [] })
    expect(calls).toBe(0)
  })

  it('rejects a missing transcript before progress or analysis begins', async () => {
    const progress: RetakeBatchProgress[] = []
    let calls = 0

    await expect(
      analyzeRetakes(null, 10_000, {
        analyzeContext: async () => {
          calls++
          return NEGATIVE_RESULT
        },
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toThrow(
      'Generate a transcript before checking for retakes.',
    )
    expect(calls).toBe(0)
    expect(progress).toEqual([])
  })

  it('rejects a pre-cancelled batch before progress or analysis begins', async () => {
    const controller = new AbortController()
    const cancellation = new DOMException(
      'A newer retake analysis started.',
      'AbortError',
    )
    controller.abort(cancellation)
    const progress: RetakeBatchProgress[] = []
    let calls = 0

    await expect(
      analyzeRetakes(sequential(...FAILED_DASHBOARD), 10_000, {
        analyzeContext: async () => {
          calls++
          return NEGATIVE_RESULT
        },
        onProgress: (event) => progress.push(event),
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation)

    expect(calls).toBe(0)
    expect(progress).toEqual([])
  })

  it('uses bounded concurrency, reports progress, and keeps source-ordered positives', async () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const before = structuredClone(transcript)
    const contexts: RetakeAnalysisContext[] = []
    const progress: RetakeBatchProgress[] = []
    const decisions: RetakeAnalysisResult[] = [
      {
        ...POSITIVE_RESULT,
        // The batch boundary must ignore any extra timing leaked by an
        // analyzer and retain the locally generated candidate range.
        startSourceMs: 99_000,
        endSourceMs: 100_000,
      } as RetakeAnalysisResult,
      NEGATIVE_RESULT,
    ]
    const decisionsBefore = structuredClone(decisions)
    let active = 0
    let maximumActive = 0

    const result = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: async (context) => {
        const index = contexts.length
        contexts.push(structuredClone(context))
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return decisions[index]
      },
      onProgress: (event) => progress.push(event),
    })

    expect(maximumActive).toBe(2)
    expect(contexts).toHaveLength(2)
    expect(contexts.map((context) => context.candidate)).toEqual([
      {
        startSourceMs: 0,
        endSourceMs: 3_900,
        text: 'The dashboard lets you um manage uh all er projects...',
      },
      {
        startSourceMs: 4_000,
        endSourceMs: 7_900,
        text: 'The dashboard lets you um manage uh all er projects...',
      },
    ])
    expect(contexts[0]).not.toHaveProperty('words')
    expect(contexts[0]).not.toHaveProperty('transcript')
    expect(contexts[0]).not.toHaveProperty('fullTranscript')
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ])
    expect(result).toEqual({
      candidateCount: 2,
      analyzedCount: 2,
      recommendations: [
        {
          id: 'retake_0_3900_incomplete-thought',
          startSourceMs: 0,
          endSourceMs: 3_900,
          reason: 'incomplete-thought',
          severity: 'recommended',
          title: 'Incomplete thought',
          explanation: 'The explanation never reaches a complete point.',
          suggestedScript:
            'Explain the dashboard workflow in one complete sentence.',
          confidence: 0.83,
          status: 'open',
          evidence: { fillerCount: 3 },
          transcriptFingerprints: [
            {
              startSourceMs: 0,
              endSourceMs: 3_900,
              fingerprint: expect.stringMatching(
                /^retake-transcript-v1:\d+:[0-9a-f]{16}$/u,
              ),
            },
          ],
        },
      ],
    })
    expect(
      getRetakeRecommendationFreshness(
        transcript,
        result.recommendations[0],
      ),
    ).toBe('current')
    expect(transcript).toEqual(before)
    expect(decisions).toEqual(decisionsBefore)
  })

  it('revalidates assembled recommendation fields at the final boundary', async () => {
    const result = await analyzeRetakes(
      sequential(...FAILED_DASHBOARD),
      10_000,
      {
        analyzeContext: async () => ({
          ...POSITIVE_RESULT,
          suggestedScript: '   ',
          confidence: 1.7,
        }),
      },
    )

    expect(result.recommendations).toEqual([
      {
        id: 'retake_0_3900_incomplete-thought',
        startSourceMs: 0,
        endSourceMs: 3_900,
        reason: 'incomplete-thought',
        severity: 'recommended',
        title: 'Incomplete thought',
        explanation: 'The explanation never reaches a complete point.',
        confidence: 1,
        status: 'open',
        evidence: { fillerCount: 3 },
        transcriptFingerprints: [
          {
            startSourceMs: 0,
            endSourceMs: 3_900,
            fingerprint: expect.stringMatching(
              /^retake-transcript-v1:\d+:[0-9a-f]{16}$/u,
            ),
          },
        ],
      },
    ])
  })

  it('maps pause and stumble signals into local recommendation evidence', async () => {
    const transcript: Transcript = {
      words: [
        { text: 'We', start: 0, end: 0.2 },
        { text: 'we', start: 0.25, end: 0.45 },
        { text: 'can', start: 0.5, end: 0.7 },
        { text: 'now', start: 0.75, end: 0.95 },
        { text: 'now', start: 1, end: 1.2 },
        { text: 'explain', start: 3.201, end: 3.4 },
        { text: 'this', start: 3.45, end: 3.65 },
        { text: 'clearly.', start: 3.7, end: 4 },
      ],
    }
    const result = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: async () => ({
        needsRetake: true,
        reason: 'severe-stumble',
        severity: 'strongly-recommended',
        explanation: 'The restarts and hesitation leave no natural edit.',
        confidence: 0.9,
      }),
    })

    expect(result.recommendations).toHaveLength(1)
    expect(result.recommendations[0]).toMatchObject({
      evidence: {
        silenceDurationMs: 2_001,
        stumbleCount: 2,
      },
    })
    expect(result.recommendations[0]).not.toHaveProperty('suggestedScript')
  })

  it('enforces the selected-candidate cap before making analyzer calls', async () => {
    const transcript = sequential(
      ...Array.from(
        { length: MAX_RETAKE_ANALYSIS_CANDIDATES + 2 },
        () => FAILED_DASHBOARD,
      ).flat(),
    )
    const progress: RetakeBatchProgress[] = []
    let calls = 0
    let active = 0
    let maximumActive = 0

    const result = await analyzeRetakes(transcript, 100_000, {
      analyzeContext: async () => {
        calls++
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        return NEGATIVE_RESULT
      },
      onProgress: (event) => progress.push(event),
    })

    expect(calls).toBe(MAX_RETAKE_ANALYSIS_CANDIDATES)
    expect(maximumActive).toBe(2)
    expect(result).toEqual({
      candidateCount: MAX_RETAKE_ANALYSIS_CANDIDATES,
      analyzedCount: MAX_RETAKE_ANALYSIS_CANDIDATES,
      recommendations: [],
    })
    expect(progress[0]).toEqual({
      completed: 0,
      total: MAX_RETAKE_ANALYSIS_CANDIDATES,
    })
    expect(progress.at(-1)).toEqual({
      completed: MAX_RETAKE_ANALYSIS_CANDIDATES,
      total: MAX_RETAKE_ANALYSIS_CANDIDATES,
    })
  })

  it('keeps recommendations chronological when concurrent requests finish out of order', async () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const firstRequest = deferred()
    const starts: number[] = []
    const reasons = [
      'incomplete-thought',
      'severe-stumble',
      'long-hesitation',
    ] as const

    const analysis = analyzeRetakes(transcript, 20_000, {
      analyzeContext: async (context) => {
        const index = Math.round(context.candidate.startSourceMs / 4_000)
        starts.push(context.candidate.startSourceMs)
        if (index === 0) await firstRequest.promise
        return {
          needsRetake: true,
          reason: reasons[index],
          severity: 'recommended',
          explanation: `Explanation ${index}.`,
          confidence: 0.8,
        }
      },
    })

    for (let turn = 0; turn < 10 && starts.length < 3; turn++) {
      await Promise.resolve()
    }
    expect(starts).toEqual([0, 4_000, 8_000])
    firstRequest.resolve()

    const result = await analysis
    expect(result.recommendations.map(({ startSourceMs }) => startSourceMs)).toEqual([
      0,
      4_000,
      8_000,
    ])
    expect(result.recommendations.map(({ reason }) => reason)).toEqual(
      reasons,
    )
  })

  it('keeps valid sibling results when one candidate analysis fails', async () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const starts: number[] = []
    const progress: RetakeBatchProgress[] = []

    const result = await analyzeRetakes(transcript, 20_000, {
      analyzeContext: async (context) => {
        starts.push(context.candidate.startSourceMs)
        if (context.candidate.startSourceMs === 0) {
          throw new Error('first request failed')
        }
        return context.candidate.startSourceMs === 4_000
          ? POSITIVE_RESULT
          : NEGATIVE_RESULT
      },
      onProgress: (event) => progress.push(event),
    })

    expect(starts.toSorted((left, right) => left - right)).toEqual([
      0, 4_000, 8_000,
    ])
    expect(result).toMatchObject({
      candidateCount: 3,
      analyzedCount: 2,
      recommendations: [
        {
          startSourceMs: 4_000,
          reason: 'incomplete-thought',
        },
      ],
    })
    expect(progress).toHaveLength(4)
    expect(
      progress.map(
        ({ completed, failed = 0 }) => completed + failed,
      ),
    ).toEqual([0, 1, 2, 3])
    expect(progress.at(-1)).toEqual({
      completed: 2,
      failed: 1,
      total: 3,
    })
  })

  it('cancels the whole batch without caching late results or starting queued work', async () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const controller = new AbortController()
    const cancellation = new DOMException(
      'The transcript was replaced.',
      'AbortError',
    )
    const releaseInFlight = deferred()
    const bothWorkersStarted = deferred()
    const starts: number[] = []
    const receivedSignals: Array<AbortSignal | undefined> = []
    const progress: RetakeBatchProgress[] = []
    let cancellingRun = true
    const analyzeContext = async (
      context: RetakeAnalysisContext,
      signal?: AbortSignal,
    ): Promise<RetakeAnalysisResult> => {
      starts.push(context.candidate.startSourceMs)
      receivedSignals.push(signal)
      if (cancellingRun) {
        if (starts.length === 2) bothWorkersStarted.resolve()
        await releaseInFlight.promise
      }
      return NEGATIVE_RESULT
    }

    const analysis = analyzeRetakes(transcript, 20_000, {
      analyzeContext,
      onProgress: (event) => progress.push(event),
      signal: controller.signal,
    })
    const rejection = expect(analysis).rejects.toBe(cancellation)

    await bothWorkersStarted.promise
    expect(starts).toEqual([0, 4_000])
    expect(receivedSignals).toEqual([
      controller.signal,
      controller.signal,
    ])

    controller.abort(cancellation)
    releaseInFlight.resolve()
    await rejection

    expect(starts).toEqual([0, 4_000])
    expect(progress).toEqual([{ completed: 0, total: 3 }])

    // Neither late in-flight result entered the session cache. A fresh run
    // analyzes all three candidates, including the one cancellation never
    // allowed either worker to dequeue.
    cancellingRun = false
    await expect(
      analyzeRetakes(transcript, 20_000, { analyzeContext }),
    ).resolves.toMatchObject({ candidateCount: 3, analyzedCount: 3 })
    expect(starts).toEqual([0, 4_000, 0, 4_000, 8_000])
    expect(receivedSignals.slice(2)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
  })

  it('keeps an analyzer AbortError isolated while the batch signal is live', async () => {
    const controller = new AbortController()
    const progress: RetakeBatchProgress[] = []
    const result = await analyzeRetakes(
      sequential(...FAILED_DASHBOARD, ...FAILED_DASHBOARD),
      10_000,
      {
        analyzeContext: async (context, signal) => {
          expect(signal).toBe(controller.signal)
          if (context.candidate.startSourceMs === 0) {
            throw new DOMException(
              'The individual request was aborted.',
              'AbortError',
            )
          }
          return NEGATIVE_RESULT
        },
        onProgress: (event) => progress.push(event),
        signal: controller.signal,
      },
    )

    expect(controller.signal.aborted).toBe(false)
    expect(result).toEqual({
      candidateCount: 2,
      analyzedCount: 1,
      recommendations: [],
    })
    expect(progress.at(-1)).toEqual({
      completed: 1,
      failed: 1,
      total: 2,
    })
  })

  it('attempts every candidate and rejects the first source-ordered failure when all fail', async () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const firstRequest = deferred()
    const allStarted = deferred()
    const starts: number[] = []
    const progress: RetakeBatchProgress[] = []

    const analysis = analyzeRetakes(transcript, 20_000, {
      analyzeContext: async (context) => {
        const start = context.candidate.startSourceMs
        starts.push(start)
        if (starts.length === 3) allStarted.resolve()
        if (start === 0) {
          await firstRequest.promise
          throw new Error('first source failure')
        }
        throw new Error(`later failure at ${start}`)
      },
      onProgress: (event) => progress.push(event),
    })
    const rejection = expect(analysis).rejects.toThrow(
      'first source failure',
    )

    await allStarted.promise
    expect(starts.toSorted((left, right) => left - right)).toEqual([
      0, 4_000, 8_000,
    ])

    firstRequest.resolve()
    await rejection
    expect(progress.at(-1)).toEqual({
      completed: 0,
      failed: 3,
      total: 3,
    })
  })

  it('reuses unchanged positive and negative decisions during the session', async () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    const positiveProgress: RetakeBatchProgress[] = []
    let positiveCalls = 0
    const positiveAnalyzer = async (): Promise<RetakeAnalysisResult> => {
      positiveCalls++
      return POSITIVE_RESULT
    }

    const first = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: positiveAnalyzer,
    })
    const second = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: positiveAnalyzer,
      onProgress: (event) => positiveProgress.push(event),
    })

    expect(positiveCalls).toBe(1)
    expect(second).toEqual(first)
    expect(second.recommendations).not.toBe(first.recommendations)
    expect(second.recommendations[0]).not.toBe(first.recommendations[0])
    expect(positiveProgress).toEqual([
      { completed: 0, total: 1 },
      { completed: 1, total: 1 },
    ])
    clearRetakeAnalysisSessionCaches()
    await analyzeRetakes(transcript, 10_000, {
      analyzeContext: positiveAnalyzer,
    })
    expect(positiveCalls).toBe(2)

    let negativeCalls = 0
    const negativeAnalyzer = async (): Promise<RetakeAnalysisResult> => {
      negativeCalls++
      return NEGATIVE_RESULT
    }
    await analyzeRetakes(transcript, 10_000, {
      analyzeContext: negativeAnalyzer,
    })
    const cachedNegative = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: negativeAnalyzer,
    })

    expect(negativeCalls).toBe(1)
    expect(cachedNegative.recommendations).toEqual([])
  })

  it('misses the cache when relevant transcript evidence changes', async () => {
    let calls = 0
    const analyzeContext = async (): Promise<RetakeAnalysisResult> => {
      calls++
      return NEGATIVE_RESULT
    }

    await analyzeRetakes(sequential(...FAILED_DASHBOARD), 10_000, {
      analyzeContext,
    })
    await analyzeRetakes(
      sequential(
        ...FAILED_DASHBOARD.map((word) =>
          word === 'dashboard' ? 'workspace' : word,
        ),
      ),
      10_000,
      { analyzeContext },
    )

    expect(calls).toBe(2)
  })

  it('partitions cached decisions when omitted middle candidate text changes', async () => {
    const words = Array.from({ length: 160 }, (_, index) =>
      index < 48
        ? 'um'
        : index === 80
          ? 'middle-original'
          : index === 159
            ? 'finished.'
            : `word-${index}`,
    )
    const firstTranscript = sequential(...words)
    const secondTranscript = sequential(
      ...words.map((word) =>
        word === 'middle-original' ? 'middle-changed' : word,
      ),
    )
    const contexts: RetakeAnalysisContext[] = []
    let calls = 0
    const analyzeContext = async (
      context: RetakeAnalysisContext,
    ): Promise<RetakeAnalysisResult> => {
      calls++
      contexts.push(structuredClone(context))
      return POSITIVE_RESULT
    }

    const first = await analyzeRetakes(firstTranscript, 100_000, {
      analyzeContext,
    })
    const second = await analyzeRetakes(secondTranscript, 100_000, {
      analyzeContext,
    })

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toEqual(contexts[1])
    expect(calls).toBe(2)
    expect(first.recommendations[0].transcriptFingerprints).not.toEqual(
      second.recommendations[0].transcriptFingerprints,
    )
    expect(
      getRetakeRecommendationFreshness(
        firstTranscript,
        first.recommendations[0],
      ),
    ).toBe('current')
    expect(
      getRetakeRecommendationFreshness(
        secondTranscript,
        second.recommendations[0],
      ),
    ).toBe('current')
  })

  it('captures provenance before awaiting an analyzer', async () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    const analyzedTranscript = structuredClone(transcript)

    const result = await analyzeRetakes(transcript, 10_000, {
      analyzeContext: async () => {
        transcript.words[1].text = 'workspace'
        return POSITIVE_RESULT
      },
    })

    expect(
      getRetakeRecommendationFreshness(
        analyzedTranscript,
        result.recommendations[0],
      ),
    ).toBe('current')
    expect(
      getRetakeRecommendationFreshness(
        transcript,
        result.recommendations[0],
      ),
    ).toBe('stale')
  })

  it('does not cache rejected analyzer work', async () => {
    let calls = 0
    const analyzeContext = async (): Promise<RetakeAnalysisResult> => {
      calls++
      if (calls === 1) throw new Error('temporary failure')
      return NEGATIVE_RESULT
    }

    await analyzeRetakes(sequential(...FAILED_DASHBOARD), 10_000, {
      analyzeContext,
    }).catch(() => undefined)
    await analyzeRetakes(sequential(...FAILED_DASHBOARD), 10_000, {
      analyzeContext,
    })

    expect(calls).toBe(2)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails before candidate analysis when source duration is %s',
    async (sourceDurationMs) => {
      let calls = 0
      const analyzeContext = async (): Promise<RetakeAnalysisResult> => {
        calls++
        return POSITIVE_RESULT
      }

      await expect(
        analyzeRetakes(sequential(...FAILED_DASHBOARD), sourceDurationMs, {
          analyzeContext,
        }),
      ).rejects.toThrow(
        'Cannot analyze retakes without a valid source duration.',
      )
      expect(calls).toBe(0)
    },
  )

  it('fails an out-of-source candidate without spending an AI request', async () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    transcript.words = transcript.words.map((word) => ({
      ...word,
      start: word.start + 20,
      end: word.end + 20,
    }))
    const progress: RetakeBatchProgress[] = []
    let calls = 0

    await expect(
      analyzeRetakes(transcript, 10_000, {
        analyzeContext: async () => {
          calls++
          return POSITIVE_RESULT
        },
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toThrow(
      'A retake-analysis section falls outside the source duration.',
    )
    expect(calls).toBe(0)
    expect(progress).toEqual([
      { completed: 0, total: 1 },
      { completed: 0, failed: 1, total: 1 },
    ])
  })

  it('returns fresh deterministic recommendations without mutating inputs', async () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    const before = structuredClone(transcript)
    let calls = 0
    const analyzeContext = async (): Promise<RetakeAnalysisResult> => {
      calls++
      return POSITIVE_RESULT
    }

    const first = await analyzeRetakes(transcript, 10_000, {
      analyzeContext,
    })
    const second = await analyzeRetakes(transcript, 10_000, {
      analyzeContext,
    })

    expect(first).toEqual(second)
    expect(first.recommendations).not.toBe(second.recommendations)
    expect(first.recommendations[0]).not.toBe(second.recommendations[0])
    expect(first.recommendations[0].evidence).not.toBe(
      second.recommendations[0].evidence,
    )
    expect(calls).toBe(1)
    expect(transcript).toEqual(before)
  })
})
