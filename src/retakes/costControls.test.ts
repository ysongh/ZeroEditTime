import { describe, expect, it } from 'vitest'
import type { RetakeAnalysisResult } from './analysis'
import type { RetakeCandidate } from './candidates'
import type { RetakeAnalysisContext } from './context'
import {
  HEAVY_CANDIDATE_OVERLAP_RATIO,
  MAX_RETAKE_ANALYSIS_CACHE_ENTRIES,
  MAX_RETAKE_ANALYSIS_CANDIDATES,
  MAX_RETAKE_ANALYSIS_CONCURRENCY,
  RETAKE_ANALYSIS_CACHE_KEY_VERSION,
  createRetakeAnalysisSessionCache,
  fingerprintRetakeAnalysisContext,
  selectRetakeCandidatesForAnalysis,
} from './costControls'

const FILLER_SIGNALS: RetakeCandidate['signals'] = {
  fillerCount: 3,
  fillerDensity: 0.3,
  longPauseCount: 0,
  longestPauseMs: 0,
  stumbleCount: 0,
}

function candidate(
  id: string,
  startSourceMs: number,
  endSourceMs: number,
  signals: Partial<RetakeCandidate['signals']> = {},
): RetakeCandidate {
  return {
    id,
    startSourceMs,
    endSourceMs,
    transcriptText: `Candidate ${id}.`,
    previousContext: `Before ${id}.`,
    nextContext: `After ${id}.`,
    signals: { ...FILLER_SIGNALS, ...signals },
  }
}

function context(index = 0): RetakeAnalysisContext {
  return {
    candidate: {
      startSourceMs: index * 1_000,
      endSourceMs: index * 1_000 + 900,
      text: `Candidate ${index}`,
    },
    before: { text: `Before ${index}` },
    after: { text: `After ${index}` },
    nearbyAlternateTakes: [
      {
        startSourceMs: index * 1_000 + 1_000,
        endSourceMs: index * 1_000 + 1_800,
        text: `Alternate ${index}`,
      },
    ],
    signals: {
      fillerCount: 3,
      fillerDensity: 0.3,
      longPauseCount: 1,
      longestPauseMs: 2_200,
      stumbleCount: 2,
    },
  }
}

const POSITIVE_RESULT: RetakeAnalysisResult = {
  needsRetake: true,
  reason: 'incomplete-thought',
  severity: 'recommended',
  explanation: 'The thought remains incomplete.',
  suggestedScript: 'Complete the thought in one sentence.',
  confidence: 0.8,
}

describe('retake analysis cost controls', () => {
  it('publishes conservative fixed request limits', () => {
    expect(MAX_RETAKE_ANALYSIS_CANDIDATES).toBe(10)
    expect(MAX_RETAKE_ANALYSIS_CONCURRENCY).toBe(2)
    expect(HEAVY_CANDIDATE_OVERLAP_RATIO).toBe(0.8)
    expect(MAX_RETAKE_ANALYSIS_CACHE_ENTRIES).toBe(50)
    expect(RETAKE_ANALYSIS_CACHE_KEY_VERSION).toBe(
      'retake-analysis-policy-v1',
    )
  })

  it('deduplicates at the heavy-overlap boundary and keeps the stronger candidate', () => {
    const weaker = candidate('weaker', 0, 1_000)
    const stronger = candidate('stronger', 200, 1_200, {
      fillerCount: 0,
      fillerDensity: 0,
      stumbleCount: 4,
    })

    expect(selectRetakeCandidatesForAnalysis([weaker, stronger])).toEqual([
      stronger,
    ])
    expect(
      selectRetakeCandidatesForAnalysis([
        weaker,
        candidate('below-boundary', 201, 1_201),
      ]),
    ).toHaveLength(2)
  })

  it('deduplicates containment but retains touching and disjoint ranges', () => {
    const outer = candidate('outer', 0, 2_000)
    const contained = candidate('contained', 500, 1_500, {
      fillerCount: 0,
      fillerDensity: 0,
      stumbleCount: 3,
    })
    const touching = candidate('touching', 2_000, 3_000)
    const disjoint = candidate('disjoint', 4_000, 5_000)

    expect(selectRetakeCandidatesForAnalysis([outer, contained])).toEqual([
      contained,
    ])
    expect(
      selectRetakeCandidatesForAnalysis([outer, touching, disjoint]).map(
        ({ id }) => id,
      ),
    ).toEqual(['outer', 'touching', 'disjoint'])
  })

  it('caps after prioritization and restores chronological order', () => {
    const weakCandidates = Array.from(
      { length: MAX_RETAKE_ANALYSIS_CANDIDATES },
      (_, index) => candidate(`weak-${index}`, index * 2_000, index * 2_000 + 1_000),
    )
    const lateStrong = candidate('late-strong', 25_000, 26_000, {
      fillerCount: 0,
      fillerDensity: 0,
      stumbleCount: 6,
    })

    const selected = selectRetakeCandidatesForAnalysis([
      ...weakCandidates,
      lateStrong,
    ])

    expect(selected).toHaveLength(MAX_RETAKE_ANALYSIS_CANDIDATES)
    expect(selected.map(({ id }) => id)).toEqual([
      ...weakCandidates.slice(0, -1).map(({ id }) => id),
      'late-strong',
    ])
  })

  it('ignores weak co-signals when choosing an overlapping survivor', () => {
    const weak = candidate('weak', 0, 1_000, {
      fillerCount: 2,
      fillerDensity: 0.9,
      longPauseCount: 1,
      longestPauseMs: 2_000,
      stumbleCount: 1,
    })
    const qualified = candidate('qualified', 100, 1_100)

    expect(selectRetakeCandidatesForAnalysis([weak, qualified])).toEqual([
      qualified,
    ])
  })

  it('ranks hesitation and multiple qualifying signal families', () => {
    const filler = candidate('filler', 0, 1_000)
    const longHesitation = candidate('long-hesitation', 100, 1_100, {
      fillerCount: 0,
      fillerDensity: 0,
      longPauseCount: 1,
      longestPauseMs: 4_000,
    })
    expect(selectRetakeCandidatesForAnalysis([filler, longHesitation])).toEqual([
      longHesitation,
    ])

    const singleFamily = candidate('single-family', 2_000, 3_000, {
      fillerCount: 0,
      fillerDensity: 0,
      stumbleCount: 4,
    })
    const twoFamilies = candidate('two-families', 2_100, 3_100, {
      fillerCount: 0,
      fillerDensity: 0,
      longPauseCount: 1,
      longestPauseMs: 3_000,
      stumbleCount: 4,
    })
    expect(selectRetakeCandidatesForAnalysis([singleFamily, twoFamilies])).toEqual([
      twoFamilies,
    ])

    const lowerTotal = candidate('lower-total', 4_000, 5_000, {
      fillerCount: 3,
      fillerDensity: 0.3,
      stumbleCount: 4,
    })
    const higherTotal = candidate('higher-total', 4_100, 5_100, {
      fillerCount: 6,
      fillerDensity: 0.45,
      stumbleCount: 4,
    })
    expect(selectRetakeCandidatesForAnalysis([lowerTotal, higherTotal])).toEqual([
      higherTotal,
    ])
  })

  it('uses canonical content to break otherwise equal overlap ties', () => {
    const alpha = candidate('duplicate', 0, 1_000)
    alpha.transcriptText = 'Alpha candidate.'
    const zulu = candidate('duplicate', 0, 1_000)
    zulu.transcriptText = 'Zulu candidate.'

    const forward = selectRetakeCandidatesForAnalysis([zulu, alpha])
    const reversed = selectRetakeCandidatesForAnalysis([alpha, zulu])

    expect(forward).toEqual(reversed)
    expect(forward).toHaveLength(1)
    expect(forward[0].transcriptText).toBe('Alpha candidate.')
  })

  it.each([
    ['negative start', { startSourceMs: -1 }],
    ['reversed range', { startSourceMs: 2_000, endSourceMs: 1_000 }],
    ['NaN start', { startSourceMs: Number.NaN }],
    ['infinite end', { endSourceMs: Number.POSITIVE_INFINITY }],
    ['blank transcript', { transcriptText: '  \n ' }],
  ])('drops a malformed candidate with %s', (_name, patch) => {
    expect(
      selectRetakeCandidatesForAnalysis([
        Object.assign(candidate('invalid', 0, 1_000), patch),
      ]),
    ).toEqual([])
  })

  it('is input-order independent, deterministic, fresh, and pure', () => {
    const input = [
      candidate('later', 2_000, 3_000),
      candidate('earlier', 0, 1_000),
      candidate('invalid', 4_000, 4_000),
    ]
    const before = structuredClone(input)

    const first = selectRetakeCandidatesForAnalysis(input)
    const second = selectRetakeCandidatesForAnalysis([...input].reverse())

    expect(first).toEqual(second)
    expect(first.map(({ id }) => id)).toEqual(['earlier', 'later'])
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(input[1])
    expect(first[0].signals).not.toBe(input[1].signals)
    expect(input).toEqual(before)
  })

  it('fingerprints exactly the bounded context and excludes unrelated EDL state', () => {
    const base = context()
    const sameWithEdlMetadata = {
      ...structuredClone(base),
      removedRanges: [{ start: 1, end: 2 }],
    } as RetakeAnalysisContext
    const changedText = structuredClone(base)
    changedText.candidate.text = 'Changed candidate'
    const changedBefore = structuredClone(base)
    changedBefore.before!.text = 'Changed before'
    const changedAlternate = structuredClone(base)
    changedAlternate.nearbyAlternateTakes![0].text = 'Changed alternate'
    const changedSignals = structuredClone(base)
    changedSignals.signals.stumbleCount = 3
    const changedCandidateRange = structuredClone(base)
    changedCandidateRange.candidate.startSourceMs = 1
    const changedCandidateTruncation = structuredClone(base)
    changedCandidateTruncation.candidate.truncated = true
    const changedBeforeTruncation = structuredClone(base)
    changedBeforeTruncation.before!.truncated = true
    const changedAfter = structuredClone(base)
    changedAfter.after!.text = 'Changed after'
    const changedAfterTruncation = structuredClone(base)
    changedAfterTruncation.after!.truncated = true
    const changedAlternateRange = structuredClone(base)
    changedAlternateRange.nearbyAlternateTakes![0].startSourceMs += 1
    const changedAlternateTruncation = structuredClone(base)
    changedAlternateTruncation.nearbyAlternateTakes![0].truncated = true
    const changedOptionalSignals = structuredClone(base)
    changedOptionalSignals.signals.repeatedAttemptScore = 0
    changedOptionalSignals.signals.transcriptConfidence = 0.5

    const fingerprint = fingerprintRetakeAnalysisContext(base)
    expect(fingerprintRetakeAnalysisContext(structuredClone(base))).toBe(
      fingerprint,
    )
    expect(fingerprintRetakeAnalysisContext(sameWithEdlMetadata)).toBe(
      fingerprint,
    )
    for (const changed of [
      changedText,
      changedBefore,
      changedAlternate,
      changedSignals,
      changedCandidateRange,
      changedCandidateTruncation,
      changedBeforeTruncation,
      changedAfter,
      changedAfterTruncation,
      changedAlternateRange,
      changedAlternateTruncation,
      changedOptionalSignals,
    ]) {
      expect(fingerprintRetakeAnalysisContext(changed)).not.toBe(fingerprint)
    }
  })

  it('copies positive and negative results into and out of the cache', () => {
    const cache = createRetakeAnalysisSessionCache()
    const input = { ...POSITIVE_RESULT }
    cache.set(context(), input)
    input.explanation = 'Mutated after caching.'

    const first = cache.get(context())
    const second = cache.get(context())
    expect(first).toEqual(POSITIVE_RESULT)
    expect(second).toEqual(POSITIVE_RESULT)
    expect(first).not.toBe(second)

    const negativeContext = context(1)
    cache.set(negativeContext, {
      needsRetake: false,
      explanation: 'Editing is sufficient.',
      confidence: 0.9,
    })
    expect(cache.get(negativeContext)).toEqual({
      needsRetake: false,
      explanation: 'Editing is sufficient.',
      confidence: 0.9,
    })
  })

  it('partitions equivalent model context by captured source provenance', () => {
    const cache = createRetakeAnalysisSessionCache()
    const unchangedContext = context()

    cache.set(unchangedContext, POSITIVE_RESULT, 'source-version-a')

    expect(
      cache.get(unchangedContext, 'source-version-b'),
    ).toBeUndefined()
    expect(
      cache.get(unchangedContext, 'source-version-a'),
    ).toEqual(POSITIVE_RESULT)
    expect(cache.get(unchangedContext)).toBeUndefined()
  })

  it('uses bounded least-recently-used cache eviction', () => {
    const cache = createRetakeAnalysisSessionCache()
    for (let index = 0; index < MAX_RETAKE_ANALYSIS_CACHE_ENTRIES; index++) {
      cache.set(context(index), POSITIVE_RESULT)
    }

    expect(cache.get(context(0))).toEqual(POSITIVE_RESULT)
    cache.set(context(MAX_RETAKE_ANALYSIS_CACHE_ENTRIES), POSITIVE_RESULT)

    expect(cache.size).toBe(MAX_RETAKE_ANALYSIS_CACHE_ENTRIES)
    expect(cache.get(context(1))).toBeUndefined()
    expect(cache.get(context(0))).toEqual(POSITIVE_RESULT)
  })
})
