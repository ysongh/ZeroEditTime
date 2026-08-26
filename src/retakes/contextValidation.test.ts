import { describe, expect, it } from 'vitest'
import {
  MAX_ALTERNATE_CONTEXT_CHARACTERS,
  MAX_ALTERNATE_CONTEXT_WORDS,
  MAX_CANDIDATE_CONTEXT_CHARACTERS,
  MAX_CANDIDATE_CONTEXT_WORDS,
  MAX_SURROUNDING_CONTEXT_CHARACTERS,
  MAX_SURROUNDING_CONTEXT_WORDS,
  normalizeRetakeAnalysisContext,
} from './context'

interface TestContext extends Record<string, unknown> {
  candidate: Record<string, unknown>
  signals: Record<string, unknown>
  before?: unknown
  after?: unknown
  nearbyAlternateTakes?: unknown
}

function baseContext(): TestContext {
  return {
    candidate: {
      startSourceMs: 1_000,
      endSourceMs: 2_000,
      text: 'Candidate sentence.',
    },
    signals: {
      fillerCount: 1,
      fillerDensity: 0.25,
      longPauseCount: 2,
      longestPauseMs: 1_250.5,
      stumbleCount: 3,
    },
  }
}

describe('normalizeRetakeAnalysisContext', () => {
  it('normalizes text and reconstructs only the bounded context contract', () => {
    const input = {
      ...baseContext(),
      privateRootNote: 'discard me',
      candidate: {
        startSourceMs: 1_000,
        endSourceMs: 2_000,
        text: '  Candidate\n\t sentence.  ',
        truncated: true,
        id: 'discard me',
      },
      before: {
        text: '  Before\n context. ',
        secret: true,
      },
      after: {
        text: '\tAfter   context.\n',
        truncated: true,
        secret: true,
      },
      nearbyAlternateTakes: [
        {
          startSourceMs: 2_100,
          endSourceMs: 2_900,
          text: '  First   alternate. ',
          secret: true,
        },
        {
          startSourceMs: 3_000,
          endSourceMs: 3_800,
          text: '\nSecond alternate.\t',
          truncated: true,
        },
      ],
      signals: {
        fillerCount: 1,
        fillerDensity: 0.25,
        longPauseCount: 2,
        longestPauseMs: 1_250.5,
        stumbleCount: 3,
        repeatedAttemptScore: 0,
        transcriptConfidence: 1,
        inventedScore: 99,
      },
    }
    const before = structuredClone(input)

    const result = normalizeRetakeAnalysisContext(input)

    expect(result).toEqual({
      candidate: {
        startSourceMs: 1_000,
        endSourceMs: 2_000,
        text: 'Candidate sentence.',
        truncated: true,
      },
      before: { text: 'Before context.' },
      after: { text: 'After context.', truncated: true },
      nearbyAlternateTakes: [
        {
          startSourceMs: 2_100,
          endSourceMs: 2_900,
          text: 'First alternate.',
        },
        {
          startSourceMs: 3_000,
          endSourceMs: 3_800,
          text: 'Second alternate.',
          truncated: true,
        },
      ],
      signals: {
        fillerCount: 1,
        fillerDensity: 0.25,
        longPauseCount: 2,
        longestPauseMs: 1_250.5,
        stumbleCount: 3,
        repeatedAttemptScore: 0,
        transcriptConfidence: 1,
      },
    })
    expect(input).toEqual(before)
    expect(result).not.toBe(input)
    expect(result?.candidate).not.toBe(input.candidate)
    expect(result?.signals).not.toBe(input.signals)
    expect(result?.before).not.toBe(input.before)
    expect(result?.nearbyAlternateTakes).not.toBe(
      input.nearbyAlternateTakes,
    )
    expect(result?.nearbyAlternateTakes?.[0]).not.toBe(
      input.nearbyAlternateTakes[0],
    )
  })

  it('accepts exact text caps and at most two alternate takes', () => {
    const input = baseContext()
    input.candidate.text = 'c'.repeat(MAX_CANDIDATE_CONTEXT_CHARACTERS)
    input.before = {
      text: 'b'.repeat(MAX_SURROUNDING_CONTEXT_CHARACTERS),
    }
    input.after = {
      text: Array.from(
        { length: MAX_SURROUNDING_CONTEXT_WORDS },
        () => 'a',
      ).join(' '),
    }
    input.nearbyAlternateTakes = [
      {
        startSourceMs: 2_100,
        endSourceMs: 2_900,
        text: 'n'.repeat(MAX_ALTERNATE_CONTEXT_CHARACTERS),
      },
      {
        startSourceMs: 3_000,
        endSourceMs: 3_900,
        text: Array.from(
          { length: MAX_ALTERNATE_CONTEXT_WORDS },
          () => 'n',
        ).join(' '),
      },
    ]

    expect(normalizeRetakeAnalysisContext(input)).not.toBeNull()

    input.candidate.text = Array.from(
      { length: MAX_CANDIDATE_CONTEXT_WORDS },
      () => 'c',
    ).join(' ')
    expect(normalizeRetakeAnalysisContext(input)).not.toBeNull()
  })

  it('rejects text beyond each field-specific word or character cap', () => {
    const candidateCharacters = baseContext()
    candidateCharacters.candidate.text = 'c'.repeat(
      MAX_CANDIDATE_CONTEXT_CHARACTERS + 1,
    )
    expect(normalizeRetakeAnalysisContext(candidateCharacters)).toBeNull()

    const candidateWords = baseContext()
    candidateWords.candidate.text = Array.from(
      { length: MAX_CANDIDATE_CONTEXT_WORDS + 1 },
      () => 'c',
    ).join(' ')
    expect(normalizeRetakeAnalysisContext(candidateWords)).toBeNull()

    const beforeCharacters = baseContext()
    beforeCharacters.before = {
      text: 'b'.repeat(MAX_SURROUNDING_CONTEXT_CHARACTERS + 1),
    }
    expect(normalizeRetakeAnalysisContext(beforeCharacters)).toBeNull()

    const afterWords = baseContext()
    afterWords.after = {
      text: Array.from(
        { length: MAX_SURROUNDING_CONTEXT_WORDS + 1 },
        () => 'a',
      ).join(' '),
    }
    expect(normalizeRetakeAnalysisContext(afterWords)).toBeNull()

    const alternateCharacters = baseContext()
    alternateCharacters.nearbyAlternateTakes = [
      {
        startSourceMs: 2_100,
        endSourceMs: 2_900,
        text: 'n'.repeat(MAX_ALTERNATE_CONTEXT_CHARACTERS + 1),
      },
    ]
    expect(normalizeRetakeAnalysisContext(alternateCharacters)).toBeNull()

    const alternateWords = baseContext()
    alternateWords.nearbyAlternateTakes = [
      {
        startSourceMs: 2_100,
        endSourceMs: 2_900,
        text: Array.from(
          { length: MAX_ALTERNATE_CONTEXT_WORDS + 1 },
          () => 'n',
        ).join(' '),
      },
    ]
    expect(normalizeRetakeAnalysisContext(alternateWords)).toBeNull()
  })

  it.each([
    { startSourceMs: Number.NaN, endSourceMs: 2_000 },
    { startSourceMs: Number.POSITIVE_INFINITY, endSourceMs: 2_000 },
    { startSourceMs: -1, endSourceMs: 2_000 },
    { startSourceMs: 2_000, endSourceMs: 2_000 },
    { startSourceMs: 2_001, endSourceMs: 2_000 },
    { startSourceMs: 1_000, endSourceMs: '2000' },
  ])('rejects an unsafe half-open candidate range: %o', (range) => {
    const input = baseContext()
    Object.assign(input.candidate, range)

    expect(normalizeRetakeAnalysisContext(input)).toBeNull()
  })

  it('rejects an unsafe alternate source range', () => {
    const input = baseContext()
    input.nearbyAlternateTakes = [
      {
        startSourceMs: 3_000,
        endSourceMs: 2_000,
        text: 'Alternate.',
      },
    ]

    expect(normalizeRetakeAnalysisContext(input)).toBeNull()
  })

  it.each([
    ['fillerCount', -1],
    ['fillerCount', 1.5],
    ['fillerDensity', -0.01],
    ['fillerDensity', 1.01],
    ['fillerDensity', Number.NaN],
    ['longPauseCount', Number.POSITIVE_INFINITY],
    ['longPauseCount', 0.5],
    ['longestPauseMs', -1],
    ['stumbleCount', -1],
    ['stumbleCount', 0.5],
  ])('rejects an invalid required signal %s=%s', (key, value) => {
    const input = baseContext()
    input.signals[key] = value

    expect(normalizeRetakeAnalysisContext(input)).toBeNull()
  })

  it.each([
    ['repeatedAttemptScore', -1],
    ['repeatedAttemptScore', Number.NaN],
    ['transcriptConfidence', -0.01],
    ['transcriptConfidence', 1.01],
    ['transcriptConfidence', Number.POSITIVE_INFINITY],
  ])('rejects an invalid optional signal %s=%s', (key, value) => {
    const input = baseContext()
    input.signals[key] = value

    expect(normalizeRetakeAnalysisContext(input)).toBeNull()
  })

  it('requires every required property to be an own property', () => {
    const root = Object.create({ candidate: baseContext().candidate }) as Record<
      string,
      unknown
    >
    root.signals = baseContext().signals
    expect(normalizeRetakeAnalysisContext(root)).toBeNull()

    const inputWithInheritedText = baseContext()
    const candidate = Object.create({ text: 'Inherited text.' }) as Record<
      string,
      unknown
    >
    candidate.startSourceMs = 1_000
    candidate.endSourceMs = 2_000
    inputWithInheritedText.candidate = candidate
    expect(
      normalizeRetakeAnalysisContext(inputWithInheritedText),
    ).toBeNull()

    const inputWithInheritedCount = baseContext()
    const signals = Object.create({ fillerCount: 1 }) as Record<
      string,
      unknown
    >
    signals.fillerDensity = 0.25
    signals.longPauseCount = 0
    signals.longestPauseMs = 0
    signals.stumbleCount = 0
    inputWithInheritedCount.signals = signals
    expect(
      normalizeRetakeAnalysisContext(inputWithInheritedCount),
    ).toBeNull()
  })

  it('rejects missing required properties and blank required text', () => {
    const missingCandidate = baseContext()
    Reflect.deleteProperty(missingCandidate, 'candidate')
    expect(normalizeRetakeAnalysisContext(missingCandidate)).toBeNull()

    const missingSignals = baseContext()
    Reflect.deleteProperty(missingSignals, 'signals')
    expect(normalizeRetakeAnalysisContext(missingSignals)).toBeNull()

    const missingText = baseContext()
    Reflect.deleteProperty(missingText.candidate, 'text')
    expect(normalizeRetakeAnalysisContext(missingText)).toBeNull()

    const missingCount = baseContext()
    Reflect.deleteProperty(missingCount.signals, 'fillerCount')
    expect(normalizeRetakeAnalysisContext(missingCount)).toBeNull()

    const blankText = baseContext()
    blankText.candidate.text = ' \n\t '
    expect(normalizeRetakeAnalysisContext(blankText)).toBeNull()
  })

  it('accepts truncated only when its optional value is exactly true', () => {
    const valid = baseContext()
    valid.candidate.truncated = true
    expect(normalizeRetakeAnalysisContext(valid)?.candidate.truncated).toBe(
      true,
    )

    for (const invalidValue of [false, null, 1, 'true']) {
      const invalid = baseContext()
      invalid.candidate.truncated = invalidValue
      expect(normalizeRetakeAnalysisContext(invalid)).toBeNull()
    }
  })

  it('rejects malformed optional context and more than two alternates', () => {
    const malformedBefore = baseContext()
    malformedBefore.before = undefined
    expect(normalizeRetakeAnalysisContext(malformedBefore)).toBeNull()

    const malformedAlternates = baseContext()
    malformedAlternates.nearbyAlternateTakes = 'not an array'
    expect(normalizeRetakeAnalysisContext(malformedAlternates)).toBeNull()

    const tooManyAlternates = baseContext()
    tooManyAlternates.nearbyAlternateTakes = [
      { startSourceMs: 2_100, endSourceMs: 2_900, text: 'One.' },
      { startSourceMs: 3_000, endSourceMs: 3_900, text: 'Two.' },
      { startSourceMs: 4_000, endSourceMs: 4_900, text: 'Three.' },
    ]
    expect(normalizeRetakeAnalysisContext(tooManyAlternates)).toBeNull()
  })

  it('omits an explicitly empty alternate array', () => {
    const input = baseContext()
    input.nearbyAlternateTakes = []

    expect(normalizeRetakeAnalysisContext(input)).toEqual(baseContext())
  })
})
