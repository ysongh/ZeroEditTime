import { describe, expect, it } from 'vitest'
import type { Transcript } from '../transcript/types'
import { buildRetakeAnalysisContext } from './context'
import {
  buildRetakeTranscriptFingerprint,
  getRetakeRecommendationFreshness,
  withRetakeTranscriptFingerprint,
} from './freshness'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import type {
  RetakeRecommendation,
  RetakeTranscriptFingerprint,
} from './recommendation'
import {
  MIN_RETAKE_MERGE_OVERLAP_OF_LONGER,
  MIN_RETAKE_MERGE_OVERLAP_OF_SHORTER,
  normalizeRetakeRecommendations,
} from './recommendations'

const SOURCE_DURATION_MS = 100_000

const BASE_RECOMMENDATION: RetakeRecommendation = {
  id: 'untrusted-input-id',
  startSourceMs: 41_000,
  endSourceMs: 46_000,
  reason: 'severe-stumble',
  severity: 'recommended',
  title: 'Severe stumble',
  explanation: 'Several restarts make this section difficult to cut.',
  confidence: 0.75,
  status: 'open',
}

function recommendation(
  patch: Partial<RetakeRecommendation> = {},
): RetakeRecommendation {
  return { ...BASE_RECOMMENDATION, ...patch }
}

function fingerprint(
  startSourceMs: number,
  endSourceMs: number,
  hexCharacter: string,
): RetakeTranscriptFingerprint {
  return {
    startSourceMs,
    endSourceMs,
    fingerprint: `retake-transcript-v1:100:${hexCharacter.repeat(16)}`,
  }
}

function sequential(...texts: readonly string[]): Transcript {
  return {
    words: texts.map((text, index) => ({
      text,
      start: index * 0.4,
      end: index * 0.4 + 0.3,
    })),
  }
}

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

describe('normalizeRetakeRecommendations', () => {
  it('locks the conservative overlap policy constants', () => {
    expect(MIN_RETAKE_MERGE_OVERLAP_OF_SHORTER).toBe(0.6)
    expect(MIN_RETAKE_MERGE_OVERLAP_OF_LONGER).toBe(0.3)
  })

  it('returns empty output for empty input or invalid source duration', () => {
    const empty: RetakeRecommendation[] = []
    const normalized = normalizeRetakeRecommendations(
      empty,
      SOURCE_DURATION_MS,
    )

    expect(normalized).toEqual([])
    expect(normalized).not.toBe(empty)
    for (const sourceDurationMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        normalizeRetakeRecommendations(
          [BASE_RECOMMENDATION],
          sourceDurationMs,
        ),
      ).toEqual([])
    }
  })

  it('enforces source bounds and removes ranges empty after normalization', () => {
    expect(
      normalizeRetakeRecommendations(
        [recommendation({ startSourceMs: -500, endSourceMs: 2_000 })],
        10_000,
      )[0],
    ).toMatchObject({ startSourceMs: 0, endSourceMs: 2_000 })
    expect(
      normalizeRetakeRecommendations(
        [recommendation({ startSourceMs: 9_000, endSourceMs: 12_000 })],
        10_000,
      )[0],
    ).toMatchObject({ startSourceMs: 9_000, endSourceMs: 10_000 })

    for (const [startSourceMs, endSourceMs] of [
      [5_000, 5_000],
      [6_000, 5_000],
      [-2_000, -1_000],
      [11_000, 12_000],
      [Number.NaN, 5_000],
      [0, Number.POSITIVE_INFINITY],
    ]) {
      expect(
        normalizeRetakeRecommendations(
          [recommendation({ startSourceMs, endSourceMs })],
          10_000,
        ),
      ).toEqual([])
    }
  })

  it('clamps finite confidence and rejects non-finite confidence', () => {
    expect(
      normalizeRetakeRecommendations(
        [recommendation({ confidence: -0.2 })],
        SOURCE_DURATION_MS,
      )[0].confidence,
    ).toBe(0)
    expect(
      normalizeRetakeRecommendations(
        [recommendation({ confidence: 2 })],
        SOURCE_DURATION_MS,
      )[0].confidence,
    ).toBe(1)

    for (const confidence of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        normalizeRetakeRecommendations(
          [recommendation({ confidence })],
          SOURCE_DURATION_MS,
        ),
      ).toEqual([])
    }
  })

  it('sorts canonically and is independent of input order', () => {
    const items = [
      recommendation({
        startSourceMs: 70_000,
        endSourceMs: 75_000,
        reason: 'audio-quality',
      }),
      recommendation({
        startSourceMs: 10_000,
        endSourceMs: 12_000,
        reason: 'low-transcription-confidence',
      }),
      recommendation({
        startSourceMs: 10_000,
        endSourceMs: 11_000,
        reason: 'audio-quality',
      }),
    ]

    const first = normalizeRetakeRecommendations(
      items,
      SOURCE_DURATION_MS,
    )
    const reversed = normalizeRetakeRecommendations(
      items.toReversed(),
      SOURCE_DURATION_MS,
    )

    expect(reversed).toEqual(first)
    expect(first.map(({ startSourceMs, endSourceMs }) => [
      startSourceMs,
      endSourceMs,
    ])).toEqual([
      [10_000, 11_000],
      [10_000, 12_000],
      [70_000, 75_000],
    ])
  })

  it('canonically orders incompatible recommendations with equal ranges', () => {
    const items = [
      recommendation({ reason: 'low-transcription-confidence' }),
      recommendation({ reason: 'audio-quality' }),
    ]
    const expected = normalizeRetakeRecommendations(
      items,
      SOURCE_DURATION_MS,
    )

    expect(
      normalizeRetakeRecommendations(
        items.toReversed(),
        SOURCE_DURATION_MS,
      ),
    ).toEqual(expected)
    expect(expected.map(({ reason }) => reason)).toEqual([
      'audio-quality',
      'low-transcription-confidence',
    ])
  })

  it('deduplicates identical recommendations and regenerates local identity', () => {
    const duplicate = recommendation({ id: 'second-input-id' })
    const normalized = normalizeRetakeRecommendations(
      [BASE_RECOMMENDATION, duplicate],
      SOURCE_DURATION_MS,
    )

    expect(normalized).toHaveLength(1)
    expect(normalized[0].id).toBe(
      'retake_41000_46000_severe-stumble',
    )
  })

  it('merges the specification example and preserves strongest/useful fields', () => {
    const severe = recommendation({
      severity: 'strongly-recommended',
      explanation:
        'The repeated restart leaves no clean edit point or complete usable take.',
      confidence: 0.72,
      evidence: {
        fillerCount: 2,
        stumbleCount: 3,
        transcriptConfidence: 0.7,
      },
      transcriptFingerprints: [fingerprint(41_000, 46_000, 'b')],
    })
    const incomplete = recommendation({
      startSourceMs: 43_000,
      endSourceMs: 49_000,
      reason: 'incomplete-thought',
      severity: 'recommended',
      title: 'Incomplete thought',
      explanation: 'The explanation does not reach its conclusion.',
      suggestedScript: 'Explain the complete workflow in one sentence.',
      confidence: 0.94,
      evidence: {
        fillerCount: 4,
        silenceDurationMs: 2_100,
        transcriptConfidence: 0.5,
      },
      transcriptFingerprints: [fingerprint(43_000, 49_000, 'a')],
    })

    expect(
      normalizeRetakeRecommendations(
        [incomplete, severe],
        SOURCE_DURATION_MS,
      ),
    ).toEqual([
      {
        id: 'retake_41000_49000_severe-stumble',
        startSourceMs: 41_000,
        endSourceMs: 49_000,
        reason: 'severe-stumble',
        severity: 'strongly-recommended',
        title: 'Severe stumble',
        explanation:
          'The repeated restart leaves no clean edit point or complete usable take.',
        suggestedScript: 'Explain the complete workflow in one sentence.',
        confidence: 0.94,
        status: 'open',
        evidence: {
          fillerCount: 4,
          silenceDurationMs: 2_100,
          stumbleCount: 3,
          transcriptConfidence: 0.5,
        },
        transcriptFingerprints: [
          fingerprint(41_000, 46_000, 'b'),
          fingerprint(43_000, 49_000, 'a'),
        ],
      },
    ])
  })

  it('keeps spans separate just below either overlap boundary', () => {
    const belowShorter = recommendation({
      startSourceMs: 43_001,
      endSourceMs: 49_000,
      reason: 'incomplete-thought',
    })
    const tooSmallWithinLong = recommendation({
      startSourceMs: 42_000,
      endSourceMs: 44_000,
      reason: 'incomplete-thought',
    })
    const broad = recommendation({
      startSourceMs: 40_000,
      endSourceMs: 50_000,
    })

    expect(
      normalizeRetakeRecommendations(
        [BASE_RECOMMENDATION, belowShorter],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
    expect(
      normalizeRetakeRecommendations(
        [broad, tooSmallWithinLong],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
  })

  it('includes the longer-range overlap boundary and rejects just below it', () => {
    const broad = recommendation({
      startSourceMs: 0,
      endSourceMs: 10_000,
    })
    const atBoundary = recommendation({
      startSourceMs: 0,
      endSourceMs: 3_000,
      reason: 'incomplete-thought',
    })
    const belowBoundary = recommendation({
      startSourceMs: 0,
      endSourceMs: 2_999,
      reason: 'incomplete-thought',
    })

    expect(
      normalizeRetakeRecommendations(
        [broad, atBoundary],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(1)
    expect(
      normalizeRetakeRecommendations(
        [broad, belowBoundary],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
  })

  it.each([
    'no-clean-take',
    'incomplete-thought',
    'repeated-failed-takes',
    'unclear-explanation',
    'excessive-fillers',
    'long-hesitation',
  ] as const)('treats %s as compatible speech/content advice', (reason) => {
    expect(
      normalizeRetakeRecommendations(
        [BASE_RECOMMENDATION, recommendation({ reason })],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(1)
  })

  it('never merges touching, gapped, or incompatible issue families', () => {
    const touching = recommendation({
      startSourceMs: 46_000,
      endSourceMs: 50_000,
      reason: 'incomplete-thought',
    })
    const gapped = recommendation({
      startSourceMs: 46_001,
      endSourceMs: 50_000,
      reason: 'incomplete-thought',
    })
    const audio = recommendation({ reason: 'audio-quality' })
    const lowConfidence = recommendation({
      reason: 'low-transcription-confidence',
    })

    expect(
      normalizeRetakeRecommendations(
        [BASE_RECOMMENDATION, touching],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
    expect(
      normalizeRetakeRecommendations(
        [BASE_RECOMMENDATION, gapped],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
    expect(
      normalizeRetakeRecommendations(
        [BASE_RECOMMENDATION, audio, lowConfidence],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(3)
    expect(
      normalizeRetakeRecommendations(
        [audio, recommendation({ reason: 'audio-quality' })],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(1)
  })

  it('collapses conflicting workflow copies without duplicate ids', () => {
    const dismissed = recommendation({ status: 'dismissed' })
    const resolved = recommendation({ status: 'resolved' })
    const normalized = normalizeRetakeRecommendations(
      [BASE_RECOMMENDATION, dismissed, resolved],
      SOURCE_DURATION_MS,
    )

    expect(normalized).toHaveLength(1)
    expect(normalized[0].status).toBe('resolved')
    expect(new Set(normalized.map(({ id }) => id)).size).toBe(
      normalized.length,
    )
  })

  it('preserves severity, explanation, and script independently', () => {
    const strongest = recommendation({
      severity: 'strongly-recommended',
      explanation: 'Restart.',
      confidence: 0.61,
      suggestedScript: 'Again.',
    })
    const mostUsefulExplanation = recommendation({
      reason: 'incomplete-thought',
      severity: 'suggestion',
      title: 'Finish the workflow explanation',
      explanation:
        'The section stops before explaining the final publish step, so the listener cannot complete the workflow.',
      confidence: 0.72,
    })
    const mostUsefulScript = recommendation({
      reason: 'unclear-explanation',
      severity: 'recommended',
      title: 'Clarify the workflow',
      explanation: 'The workflow is unclear.',
      suggestedScript:
        'Open the project, review the transcript, and choose Publish to finish the workflow.',
      confidence: 0.96,
    })

    const [merged] = normalizeRetakeRecommendations(
      [mostUsefulScript, strongest, mostUsefulExplanation],
      SOURCE_DURATION_MS,
    )

    expect(merged).toMatchObject({
      reason: 'incomplete-thought',
      severity: 'strongly-recommended',
      title: 'Finish the workflow explanation',
      explanation:
        'The section stops before explaining the final publish step, so the listener cannot complete the workflow.',
      suggestedScript:
        'Open the project, review the transcript, and choose Publish to finish the workflow.',
      confidence: 0.96,
    })
  })

  it('ranks original copy owners consistently across a three-way merge', () => {
    const usefulSuggestion = recommendation({
      severity: 'suggestion',
      title: 'Suggestion copy',
      explanation: 'abcdefghij',
      suggestedScript: 'abcdefghij',
      confidence: 0.1,
    })
    const terseStrongCopy = recommendation({
      severity: 'strongly-recommended',
      title: 'Strong copy',
      explanation: 'x',
      suggestedScript: 'x',
      confidence: 0.99,
    })
    const usefulRecommended = recommendation({
      startSourceMs: 43_000,
      endSourceMs: 49_000,
      reason: 'incomplete-thought',
      severity: 'recommended',
      title: 'Recommended copy',
      explanation: 'klmnopqrst',
      suggestedScript: 'klmnopqrst',
      confidence: 0.5,
    })

    const [merged] = normalizeRetakeRecommendations(
      [usefulRecommended, terseStrongCopy, usefulSuggestion],
      SOURCE_DURATION_MS,
    )

    expect(merged).toMatchObject({
      reason: 'incomplete-thought',
      severity: 'strongly-recommended',
      title: 'Recommended copy',
      explanation: 'klmnopqrst',
      suggestedScript: 'klmnopqrst',
      confidence: 0.99,
    })
  })

  it('preserves the strongest value across every severity level', () => {
    const normalized = normalizeRetakeRecommendations(
      [
        recommendation({ severity: 'suggestion' }),
        recommendation({ severity: 'recommended' }),
        recommendation({ severity: 'strongly-recommended' }),
      ],
      SOURCE_DURATION_MS,
    )

    expect(normalized).toHaveLength(1)
    expect(normalized[0].severity).toBe('strongly-recommended')
  })

  it('merges compatible overlap bridges to a stable fixed point', () => {
    const first = recommendation({
      startSourceMs: 0,
      endSourceMs: 10_000,
    })
    const bridge = recommendation({
      startSourceMs: 4_000,
      endSourceMs: 14_000,
      reason: 'incomplete-thought',
    })
    const last = recommendation({
      startSourceMs: 8_000,
      endSourceMs: 18_000,
      reason: 'unclear-explanation',
    })

    const expected = normalizeRetakeRecommendations(
      [first, bridge, last],
      SOURCE_DURATION_MS,
    )
    expect(expected).toHaveLength(1)
    expect(expected.map(({ startSourceMs, endSourceMs }) => [
      startSourceMs,
      endSourceMs,
    ])).toEqual([
      [0, 18_000],
    ])
    expect(
      normalizeRetakeRecommendations(
        [last, first, bridge],
        SOURCE_DURATION_MS,
      ),
    ).toEqual(expected)
    expect(
      normalizeRetakeRecommendations(expected, SOURCE_DURATION_MS),
    ).toEqual(expected)
  })

  it('canonically unions and deduplicates all complete provenance', () => {
    const firstProof = fingerprint(41_000, 46_000, 'a')
    const conflictingProof = fingerprint(41_000, 46_000, 'b')
    const secondProof = fingerprint(43_000, 49_000, 'c')
    const proofWithExtraField = {
      ...firstProof,
      modelCommentary: 'do not retain this',
    }
    const first = recommendation({
      transcriptFingerprints: [
        conflictingProof,
        proofWithExtraField,
        firstProof,
      ],
    })
    const second = recommendation({
      startSourceMs: 43_000,
      endSourceMs: 49_000,
      reason: 'incomplete-thought',
      transcriptFingerprints: [secondProof],
    })

    const [merged] = normalizeRetakeRecommendations(
      [second, first],
      SOURCE_DURATION_MS,
    )
    expect(merged.transcriptFingerprints).toEqual([
      firstProof,
      conflictingProof,
      secondProof,
    ])
    expect(merged.transcriptFingerprints?.[0]).not.toBe(firstProof)
    expect(merged.transcriptFingerprints?.[0]).not.toHaveProperty(
      'modelCommentary',
    )
  })

  it('uses an exact shared proof to identify a duplicate beyond geometry alone', () => {
    const sharedProof = fingerprint(45_000, 46_000, 'a')
    const broad = recommendation({
      startSourceMs: 40_000,
      endSourceMs: 50_000,
      transcriptFingerprints: [sharedProof],
    })
    const narrow = recommendation({
      startSourceMs: 45_000,
      endSourceMs: 46_000,
      reason: 'incomplete-thought',
      transcriptFingerprints: [sharedProof],
    })

    const [merged] = normalizeRetakeRecommendations(
      [narrow, broad],
      SOURCE_DURATION_MS,
    )
    expect(merged).toMatchObject({
      startSourceMs: 40_000,
      endSourceMs: 50_000,
      transcriptFingerprints: [sharedProof],
    })

    expect(
      normalizeRetakeRecommendations(
        [
          broad,
          recommendation({
            startSourceMs: 45_000,
            endSourceMs: 46_000,
            reason: 'incomplete-thought',
            transcriptFingerprints: [
              fingerprint(45_000, 46_000, 'b'),
            ],
          }),
        ],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
    expect(
      normalizeRetakeRecommendations(
        [
          broad,
          recommendation({
            startSourceMs: 45_000,
            endSourceMs: 46_000,
            reason: 'audio-quality',
            transcriptFingerprints: [sharedProof],
          }),
        ],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
    expect(
      normalizeRetakeRecommendations(
        [
          broad,
          recommendation({
            startSourceMs: 45_000,
            endSourceMs: 46_000,
            reason: 'incomplete-thought',
            status: 'dismissed',
            transcriptFingerprints: [sharedProof],
          }),
        ],
        SOURCE_DURATION_MS,
      ),
    ).toHaveLength(2)
  })

  it('retains known proofs for matching while merged provenance fails closed', () => {
    const sharedProof = fingerprint(45_000, 46_000, 'a')
    const proven = recommendation({
      startSourceMs: 45_000,
      endSourceMs: 46_000,
      transcriptFingerprints: [sharedProof],
    })
    const sameIdentityWithoutProof = recommendation({
      startSourceMs: 45_000,
      endSourceMs: 46_000,
    })
    const broad = recommendation({
      startSourceMs: 40_000,
      endSourceMs: 50_000,
      reason: 'incomplete-thought',
      transcriptFingerprints: [sharedProof],
    })

    const normalized = normalizeRetakeRecommendations(
      [broad, sameIdentityWithoutProof, proven],
      SOURCE_DURATION_MS,
    )

    expect(normalized).toHaveLength(1)
    expect(normalized[0]).not.toHaveProperty('transcriptFingerprints')
  })

  it('preserves and deep-copies valid provenance on a singleton', () => {
    const proof = fingerprint(41_000, 46_000, 'a')
    const input = recommendation({ transcriptFingerprints: [proof] })
    const [normalized] = normalizeRetakeRecommendations(
      [input],
      SOURCE_DURATION_MS,
    )

    expect(normalized.transcriptFingerprints).toEqual([proof])
    expect(normalized.transcriptFingerprints).not.toBe(
      input.transcriptFingerprints,
    )
    expect(normalized.transcriptFingerprints?.[0]).not.toBe(proof)
  })

  it.each([
    ['missing', undefined],
    ['empty', []],
    [
      'malformed',
      [
        {
          startSourceMs: 43_000,
          endSourceMs: 49_000,
          fingerprint: 'model-value',
        },
      ],
    ],
    [
      'outside its contributor range',
      [fingerprint(40_000, 49_000, 'd')],
    ],
  ])('fails closed when merged provenance is %s', (_name, fingerprints) => {
    const complete = recommendation({
      transcriptFingerprints: [fingerprint(41_000, 46_000, 'a')],
    })
    const incomplete = recommendation({
      startSourceMs: 43_000,
      endSourceMs: 49_000,
      reason: 'incomplete-thought',
      transcriptFingerprints: fingerprints,
    } as Partial<RetakeRecommendation>)

    const [merged] = normalizeRetakeRecommendations(
      [complete, incomplete],
      SOURCE_DURATION_MS,
    )
    expect(merged).not.toHaveProperty('transcriptFingerprints')
  })

  it('keeps an exact duplicate merge current only with complete provenance', () => {
    const transcript = sequential(...FAILED_DASHBOARD)
    const [candidate] = buildScreenedRetakeCandidates(transcript)
    const context = buildRetakeAnalysisContext(transcript, candidate)
    if (context === null) throw new Error('Expected retake context.')
    const proof = buildRetakeTranscriptFingerprint(candidate, context)
    if (proof === null) throw new Error('Expected transcript proof.')
    const first = withRetakeTranscriptFingerprint(
      recommendation({
        startSourceMs: 0,
        endSourceMs: 3_900,
      }),
      proof,
    )
    const second = withRetakeTranscriptFingerprint(
      recommendation({
        startSourceMs: 0,
        endSourceMs: 3_900,
        reason: 'incomplete-thought',
      }),
      proof,
    )
    if (first === null || second === null) {
      throw new Error('Expected fingerprinted recommendations.')
    }

    const [current] = normalizeRetakeRecommendations(
      [first, second],
      10_000,
    )
    expect(current.transcriptFingerprints).toEqual([proof])
    expect(
      getRetakeRecommendationFreshness(transcript, current),
    ).toBe('current')

    const withoutProof = { ...second }
    delete withoutProof.transcriptFingerprints
    const [requiresReanalysis] = normalizeRetakeRecommendations(
      [first, withoutProof],
      10_000,
    )
    expect(
      getRetakeRecommendationFreshness(
        transcript,
        requiresReanalysis,
      ),
    ).toBe('requires-reanalysis')
  })

  it('keeps a merged recommendation current with distinct real proofs until relevant text changes', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      ...FAILED_DASHBOARD,
    )
    const candidates = buildScreenedRetakeCandidates(transcript)
    expect(candidates).toHaveLength(2)
    const proofs = candidates.map((candidate) => {
      const context = buildRetakeAnalysisContext(transcript, candidate)
      if (context === null) throw new Error('Expected retake context.')
      const proof = buildRetakeTranscriptFingerprint(candidate, context)
      if (proof === null) throw new Error('Expected transcript proof.')
      return proof
    })
    const first = withRetakeTranscriptFingerprint(
      recommendation({ startSourceMs: 0, endSourceMs: 6_000 }),
      proofs[0],
    )
    const second = withRetakeTranscriptFingerprint(
      recommendation({
        startSourceMs: 2_000,
        endSourceMs: 7_900,
        reason: 'incomplete-thought',
      }),
      proofs[1],
    )
    if (first === null || second === null) {
      throw new Error('Expected fingerprinted recommendations.')
    }

    const [merged] = normalizeRetakeRecommendations(
      [second, first],
      10_000,
    )
    expect(merged.transcriptFingerprints).toEqual(proofs)
    expect(getRetakeRecommendationFreshness(transcript, merged)).toBe(
      'current',
    )

    const changedTranscript: Transcript = {
      words: transcript.words.map((word, index) =>
        index === 5 ? { ...word, text: 'operate' } : { ...word },
      ),
    }
    expect(
      getRetakeRecommendationFreshness(changedTranscript, merged),
    ).toBe('stale')
  })

  it('returns deeply fresh values without mutating inputs', () => {
    const inputs = [
      recommendation({
        evidence: { fillerCount: 3 },
        transcriptFingerprints: [fingerprint(41_000, 46_000, 'a')],
      }),
      recommendation({
        startSourceMs: 43_000,
        endSourceMs: 49_000,
        reason: 'incomplete-thought',
        evidence: { stumbleCount: 2 },
        transcriptFingerprints: [fingerprint(43_000, 49_000, 'b')],
      }),
    ]
    const before = structuredClone(inputs)
    const first = normalizeRetakeRecommendations(
      inputs,
      SOURCE_DURATION_MS,
    )
    const second = normalizeRetakeRecommendations(
      inputs,
      SOURCE_DURATION_MS,
    )

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(inputs[0])
    expect(first[0].evidence).not.toBe(inputs[0].evidence)
    expect(first[0].transcriptFingerprints).not.toBe(
      inputs[0].transcriptFingerprints,
    )
    expect(first[0].transcriptFingerprints?.[0]).not.toBe(
      inputs[0].transcriptFingerprints?.[0],
    )
    expect(inputs).toEqual(before)
  })
})
