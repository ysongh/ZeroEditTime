import { describe, expect, it } from 'vitest'
import type { Transcript } from '../transcript/types'
import type { RetakeAnalysisResult } from './analysis'
import {
  analyzeRetakes,
  type RetakeBatchProgress,
} from './batchAnalysis'
import type { RetakeAnalysisContext } from './context'

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

  it('analyzes bounded contexts serially, reports progress, and keeps only positives', async () => {
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

    expect(maximumActive).toBe(1)
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
        },
      ],
    })
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

  it('returns fresh deterministic recommendations without mutating inputs', async () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    const before = structuredClone(transcript)
    const analyzeContext = async (): Promise<RetakeAnalysisResult> =>
      POSITIVE_RESULT

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
    expect(transcript).toEqual(before)
  })
})
