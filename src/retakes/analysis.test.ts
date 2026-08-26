import { describe, expect, it } from 'vitest'
import type { AgentReply } from '../agent/api'
import {
  RETAKE_ANALYSIS_TOOL_NAME,
  extractRetakeAnalysisResult,
  normalizeRetakeAnalysisResult,
} from './analysis'
import { RETAKE_REASONS, RETAKE_SEVERITIES } from './recommendation'

const VALID_POSITIVE = {
  needsRetake: true,
  reason: 'severe-stumble',
  severity: 'recommended',
  explanation: '  Several restarts prevent a clean edit.  ',
  suggestedScript: '  Explain the workflow in one complete sentence.  ',
  confidence: 0.84,
} as const

describe('normalizeRetakeAnalysisResult', () => {
  it('returns a fresh, trimmed, whitelisted positive result', () => {
    const input = {
      ...VALID_POSITIVE,
      ignored: 'model-owned metadata',
    }

    const normalized = normalizeRetakeAnalysisResult(input)

    expect(normalized).toEqual({
      needsRetake: true,
      reason: 'severe-stumble',
      severity: 'recommended',
      explanation: 'Several restarts prevent a clean edit.',
      suggestedScript: 'Explain the workflow in one complete sentence.',
      confidence: 0.84,
    })
    expect(normalized).not.toBe(input)
    expect(input).toEqual({
      ...VALID_POSITIVE,
      ignored: 'model-owned metadata',
    })
  })

  it.each(RETAKE_REASONS)('accepts the %s reason', (reason) => {
    expect(
      normalizeRetakeAnalysisResult({ ...VALID_POSITIVE, reason }),
    ).toMatchObject({ reason })
  })

  it.each(RETAKE_SEVERITIES)('accepts the %s severity', (severity) => {
    expect(
      normalizeRetakeAnalysisResult({ ...VALID_POSITIVE, severity }),
    ).toMatchObject({ severity })
  })

  it('keeps an optional negative rationale and strips positive-only fields', () => {
    const input = {
      ...VALID_POSITIVE,
      needsRetake: false,
      explanation: 'There is already a clean nearby take.',
      unknown: true,
    }

    expect(normalizeRetakeAnalysisResult(input)).toEqual({
      needsRetake: false,
      explanation: 'There is already a clean nearby take.',
      confidence: 0.84,
    })
  })

  it('returns only the discriminator and confidence when no rationale exists', () => {
    expect(
      normalizeRetakeAnalysisResult({ needsRetake: false, confidence: 0.6 }),
    ).toEqual({ needsRetake: false, confidence: 0.6 })
  })

  it('clamps finite confidence to the inclusive unit interval', () => {
    expect(
      normalizeRetakeAnalysisResult({
        needsRetake: false,
        confidence: -0.25,
      }),
    ).toEqual({ needsRetake: false, confidence: 0 })
    expect(
      normalizeRetakeAnalysisResult({
        ...VALID_POSITIVE,
        confidence: 1.8,
      }),
    ).toMatchObject({ confidence: 1 })
  })

  it.each([
    ['missing reason', { reason: undefined }],
    ['unknown reason', { reason: 'unsupported' }],
    ['missing severity', { severity: undefined }],
    ['unknown severity', { severity: 'urgent' }],
    ['missing explanation', { explanation: undefined }],
    ['blank explanation', { explanation: ' \n\t ' }],
    ['non-string explanation', { explanation: 42 }],
  ])('rejects a positive result with %s', (_name, patch) => {
    expect(
      normalizeRetakeAnalysisResult({ ...VALID_POSITIVE, ...patch }),
    ).toBeNull()
  })

  it.each([
    ['missing needsRetake', { confidence: 0.5 }],
    ['non-boolean needsRetake', { needsRetake: 'false', confidence: 0.5 }],
    ['missing confidence', { needsRetake: false }],
    ['non-number confidence', { needsRetake: false, confidence: '0.5' }],
    ['NaN confidence', { needsRetake: false, confidence: Number.NaN }],
    [
      'infinite confidence',
      { needsRetake: false, confidence: Number.POSITIVE_INFINITY },
    ],
  ])('rejects a result with %s', (_name, value) => {
    expect(normalizeRetakeAnalysisResult(value)).toBeNull()
  })

  it.each([null, undefined, 'result', 42, []])(
    'rejects a non-record value: %j',
    (value) => {
      expect(normalizeRetakeAnalysisResult(value)).toBeNull()
    },
  )

  it.each([undefined, null, 123, '', '   \n'])(
    'omits a malformed or blank optional script: %j',
    (suggestedScript) => {
      expect(
        normalizeRetakeAnalysisResult({
          ...VALID_POSITIVE,
          suggestedScript,
        }),
      ).not.toHaveProperty('suggestedScript')
    },
  )

  it('does not mutate frozen input', () => {
    const input = Object.freeze({
      ...VALID_POSITIVE,
      explanation: '  Keep this trimmed  ',
    })

    expect(() => normalizeRetakeAnalysisResult(input)).not.toThrow()
    expect(input.explanation).toBe('  Keep this trimmed  ')
  })

  it('rejects prototype-only required fields and ignores an inherited script', () => {
    const inheritedNegative = Object.create({ needsRetake: false }) as Record<
      string,
      unknown
    >
    inheritedNegative.confidence = 0.5
    expect(normalizeRetakeAnalysisResult(inheritedNegative)).toBeNull()

    const positive = Object.create({
      suggestedScript: 'Inherited text must not cross the boundary.',
    }) as Record<string, unknown>
    Object.assign(positive, VALID_POSITIVE)
    Reflect.deleteProperty(positive, 'suggestedScript')
    expect(normalizeRetakeAnalysisResult(positive)).not.toHaveProperty(
      'suggestedScript',
    )
  })
})

function reply(content: unknown, stop_reason: unknown = 'tool_use'): AgentReply {
  return { content, stop_reason }
}

function analysisTool(input: unknown) {
  return {
    type: 'tool_use',
    id: 'toolu_1',
    name: RETAKE_ANALYSIS_TOOL_NAME,
    input,
  }
}

describe('extractRetakeAnalysisResult', () => {
  it('extracts and normalizes the single matching tool call', () => {
    expect(
      extractRetakeAnalysisResult(
        reply([
          { type: 'text', text: 'Submitting the result.' },
          analysisTool(VALID_POSITIVE),
        ]),
      ),
    ).toEqual({
      needsRetake: true,
      reason: 'severe-stumble',
      severity: 'recommended',
      explanation: 'Several restarts prevent a clean edit.',
      suggestedScript: 'Explain the workflow in one complete sentence.',
      confidence: 0.84,
    })
  })

  it.each([
    ['a non-tool stop reason', reply([analysisTool(VALID_POSITIVE)], 'end_turn')],
    ['non-array content', reply(analysisTool(VALID_POSITIVE))],
    ['no tool call', reply([{ type: 'text', text: 'No tool.' }])],
    [
      'a differently named tool',
      reply([{ ...analysisTool(VALID_POSITIVE), name: 'other_tool' }]),
    ],
    [
      'multiple matching tool calls',
      reply([analysisTool(VALID_POSITIVE), analysisTool(VALID_POSITIVE)]),
    ],
    [
      'one matching and one different tool call',
      reply([
        analysisTool(VALID_POSITIVE),
        { ...analysisTool(VALID_POSITIVE), name: 'other_tool' },
      ]),
    ],
    ['malformed tool input', reply([analysisTool({ needsRetake: true })])],
  ])('rejects %s', (_name, agentReply) => {
    expect(extractRetakeAnalysisResult(agentReply)).toBeNull()
  })
})
