import { describe, expect, it } from 'vitest'
import {
  RETAKE_REASONS,
  RETAKE_SEVERITIES,
  RETAKE_STATUSES,
  normalizeRetakeRecommendation,
} from './recommendation'

const SOURCE_DURATION_MS = 30_000

const VALID_RECOMMENDATION = {
  id: 'model-controlled-id',
  startSourceMs: 4_000,
  endSourceMs: 8_500,
  reason: 'severe-stumble',
  severity: 'recommended',
  title: '  Record this explanation again  ',
  explanation: '  The sentence has several incomplete restarts.  ',
  suggestedScript: '  Explain the workflow in one complete sentence.  ',
  confidence: 0.82,
  status: 'open',
  evidence: {
    fillerCount: 3,
    silenceDurationMs: 1_250.5,
    stumbleCount: 4,
    transcriptConfidence: 0.61,
  },
} as const

describe('normalizeRetakeRecommendation', () => {
  it('returns a trusted independent recommendation with a deterministic id', () => {
    const normalized = normalizeRetakeRecommendation(
      VALID_RECOMMENDATION,
      SOURCE_DURATION_MS,
    )

    expect(normalized).toEqual({
      id: 'retake_4000_8500_severe-stumble',
      startSourceMs: 4_000,
      endSourceMs: 8_500,
      reason: 'severe-stumble',
      severity: 'recommended',
      title: 'Record this explanation again',
      explanation: 'The sentence has several incomplete restarts.',
      suggestedScript: 'Explain the workflow in one complete sentence.',
      confidence: 0.82,
      status: 'open',
      evidence: {
        fillerCount: 3,
        silenceDurationMs: 1_250.5,
        stumbleCount: 4,
        transcriptConfidence: 0.61,
      },
    })
    expect(normalized).not.toBe(VALID_RECOMMENDATION)
    expect(normalized?.evidence).not.toBe(VALID_RECOMMENDATION.evidence)
  })

  it.each(RETAKE_REASONS)('accepts the %s reason', (reason) => {
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, reason },
        SOURCE_DURATION_MS,
      )?.reason,
    ).toBe(reason)
  })

  it.each(RETAKE_SEVERITIES)('accepts the %s severity', (severity) => {
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, severity },
        SOURCE_DURATION_MS,
      )?.severity,
    ).toBe(severity)
  })

  it.each(RETAKE_STATUSES)('accepts the %s status', (status) => {
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, status },
        SOURCE_DURATION_MS,
      )?.status,
    ).toBe(status)
  })

  it('clamps finite source bounds and confidence to their valid ranges', () => {
    expect(
      normalizeRetakeRecommendation(
        {
          ...VALID_RECOMMENDATION,
          startSourceMs: -500,
          endSourceMs: SOURCE_DURATION_MS + 500,
          confidence: 4,
        },
        SOURCE_DURATION_MS,
      ),
    ).toMatchObject({
      id: `retake_0_${SOURCE_DURATION_MS}_severe-stumble`,
      startSourceMs: 0,
      endSourceMs: SOURCE_DURATION_MS,
      confidence: 1,
    })

    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, confidence: -0.2 },
        SOURCE_DURATION_MS,
      )?.confidence,
    ).toBe(0)
  })

  it.each([
    ['zero length', 5_000, 5_000],
    ['reversed', 6_000, 5_000],
    ['entirely before the source', -2_000, -1_000],
    [
      'entirely after the source',
      SOURCE_DURATION_MS + 1,
      SOURCE_DURATION_MS + 2,
    ],
  ])('rejects a %s range after source-bound clamping', (_name, start, end) => {
    expect(
      normalizeRetakeRecommendation(
        {
          ...VALID_RECOMMENDATION,
          startSourceMs: start,
          endSourceMs: end,
        },
        SOURCE_DURATION_MS,
      ),
    ).toBeNull()
  })

  it.each([
    ['start', { startSourceMs: Number.NaN }],
    ['end', { endSourceMs: Number.POSITIVE_INFINITY }],
    ['confidence', { confidence: Number.NEGATIVE_INFINITY }],
  ])('rejects a non-finite %s', (_name, patch) => {
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, ...patch },
        SOURCE_DURATION_MS,
      ),
    ).toBeNull()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid source duration %s',
    (sourceDurationMs) => {
      expect(
        normalizeRetakeRecommendation(
          VALID_RECOMMENDATION,
          sourceDurationMs,
        ),
      ).toBeNull()
    },
  )

  it.each([
    ['unknown reason', { reason: 'bad-reason' }],
    ['unknown severity', { severity: 'urgent' }],
    ['unknown status', { status: 'hidden' }],
    ['blank title', { title: '   ' }],
    ['non-string title', { title: 12 }],
    ['blank explanation', { explanation: '\n\t' }],
    ['non-string explanation', { explanation: null }],
    ['non-number start', { startSourceMs: '4000' }],
    ['non-number end', { endSourceMs: '8500' }],
    ['non-number confidence', { confidence: '0.82' }],
  ])('rejects a recommendation with %s', (_name, patch) => {
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, ...patch },
        SOURCE_DURATION_MS,
      ),
    ).toBeNull()
  })

  it.each([null, undefined, 'recommendation', 42, []])(
    'rejects a non-record value: %j',
    (value) => {
      expect(
        normalizeRetakeRecommendation(value, SOURCE_DURATION_MS),
      ).toBeNull()
    },
  )

  it('omits an absent, blank, or malformed optional script', () => {
    const withoutScript: Record<string, unknown> = {
      ...VALID_RECOMMENDATION,
    }
    delete withoutScript.suggestedScript

    expect(
      normalizeRetakeRecommendation(withoutScript, SOURCE_DURATION_MS),
    ).not.toHaveProperty('suggestedScript')
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, suggestedScript: '  ' },
        SOURCE_DURATION_MS,
      ),
    ).not.toHaveProperty('suggestedScript')
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, suggestedScript: 123 },
        SOURCE_DURATION_MS,
      ),
    ).not.toHaveProperty('suggestedScript')
  })

  it('whitelists and normalizes valid evidence fields', () => {
    expect(
      normalizeRetakeRecommendation(
        {
          ...VALID_RECOMMENDATION,
          evidence: {
            fillerCount: 2,
            silenceDurationMs: 875.25,
            stumbleCount: 1,
            transcriptConfidence: 3,
            modelCommentary: 'do not retain this',
          },
        },
        SOURCE_DURATION_MS,
      )?.evidence,
    ).toEqual({
      fillerCount: 2,
      silenceDurationMs: 875.25,
      stumbleCount: 1,
      transcriptConfidence: 1,
    })
  })

  it('omits malformed optional evidence instead of trusting it', () => {
    const normalized = normalizeRetakeRecommendation(
      {
        ...VALID_RECOMMENDATION,
        evidence: {
          fillerCount: -1,
          silenceDurationMs: Number.NaN,
          stumbleCount: 1.5,
          transcriptConfidence: 'high',
        },
      },
      SOURCE_DURATION_MS,
    )

    expect(normalized).not.toBeNull()
    expect(normalized).not.toHaveProperty('evidence')
    expect(
      normalizeRetakeRecommendation(
        { ...VALID_RECOMMENDATION, evidence: 'not-an-object' },
        SOURCE_DURATION_MS,
      ),
    ).not.toHaveProperty('evidence')
  })

  it('discards extra model fields and never trusts a supplied id', () => {
    const normalized = normalizeRetakeRecommendation(
      {
        ...VALID_RECOMMENDATION,
        id: '<model-id>',
        needsRetake: true,
        hiddenInstruction: 'retain me',
      },
      SOURCE_DURATION_MS,
    )

    expect(normalized?.id).toBe('retake_4000_8500_severe-stumble')
    expect(normalized).not.toHaveProperty('needsRetake')
    expect(normalized).not.toHaveProperty('hiddenInstruction')
  })

  it('changes deterministic identity when normalized range or reason changes', () => {
    const first = normalizeRetakeRecommendation(
      VALID_RECOMMENDATION,
      SOURCE_DURATION_MS,
    )
    const same = normalizeRetakeRecommendation(
      { ...VALID_RECOMMENDATION, id: 'different-input-id' },
      SOURCE_DURATION_MS,
    )
    const moved = normalizeRetakeRecommendation(
      { ...VALID_RECOMMENDATION, startSourceMs: 4_001 },
      SOURCE_DURATION_MS,
    )
    const differentReason = normalizeRetakeRecommendation(
      { ...VALID_RECOMMENDATION, reason: 'incomplete-thought' },
      SOURCE_DURATION_MS,
    )

    expect(same?.id).toBe(first?.id)
    expect(moved?.id).not.toBe(first?.id)
    expect(differentReason?.id).not.toBe(first?.id)
  })

  it('does not mutate the untrusted input', () => {
    const input = {
      ...VALID_RECOMMENDATION,
      evidence: { ...VALID_RECOMMENDATION.evidence },
    }
    const before = structuredClone(input)

    normalizeRetakeRecommendation(input, SOURCE_DURATION_MS)

    expect(input).toEqual(before)
  })
})
