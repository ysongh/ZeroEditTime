import { describe, expect, it } from 'vitest'
import type { Transcript, Word } from '../transcript/types'
import type { RetakeCandidate } from './candidates'
import {
  CONTEXT_OMISSION_MARKER,
  MAX_ALTERNATE_CONTEXT_CHARACTERS,
  MAX_ALTERNATE_CONTEXT_WORDS,
  MAX_CANDIDATE_CONTEXT_CHARACTERS,
  MAX_CANDIDATE_CONTEXT_WORDS,
  MAX_CONTEXT_ALTERNATE_TAKES,
  MAX_SURROUNDING_CONTEXT_CHARACTERS,
  MAX_SURROUNDING_CONTEXT_WORDS,
  buildRetakeAnalysisContext,
} from './context'
import { buildHeuristicRetakeCandidates } from './heuristics'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import { findNearbyTakeWindows } from './nearbyTakes'

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

function wordsInRange(
  texts: readonly string[],
  start: number,
  end: number,
): Word[] {
  const step = (end - start) / texts.length
  return texts.map((text, index) => ({
    text,
    start: start + index * step,
    end: index === texts.length - 1 ? end : start + (index + 0.75) * step,
  }))
}

function compactSequential(...sentences: readonly (readonly string[])[]): Transcript {
  const words: Word[] = []
  let time = 0
  for (const sentence of sentences) {
    for (const text of sentence) {
      words.push({ text, start: time, end: time + 0.04 })
      time += 0.05
    }
    time += 0.05
  }
  return { words }
}

function baseCandidate(
  overrides: Partial<RetakeCandidate> = {},
): RetakeCandidate {
  return {
    id: 'retake_candidate_10125_12875',
    startSourceMs: 10_125,
    endSourceMs: 12_875,
    transcriptText: 'Candidate speech stays in original source time.',
    signals: {
      fillerCount: 3,
      fillerDensity: 0.3,
      longPauseCount: 1,
      longestPauseMs: 2_500,
      stumbleCount: 2,
      repeatedAttemptScore: 0,
      transcriptConfidence: 0,
    },
    ...overrides,
  }
}

function exactAlternateFixture(): {
  transcript: Transcript
  candidate: RetakeCandidate
} {
  const transcript: Transcript = {
    words: [
      ...wordsInRange(CLEAN_DASHBOARD, 8.25, 9.625),
      ...wordsInRange(FAILED_DASHBOARD, 10.125, 12.875),
      ...wordsInRange(CLEAN_DASHBOARD, 13.25, 14.875),
    ],
  }
  const candidates = buildHeuristicRetakeCandidates(transcript)
  if (candidates.length !== 1) {
    throw new Error(`Expected one candidate, received ${candidates.length}`)
  }
  return { transcript, candidate: candidates[0] }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('buildRetakeAnalysisContext', () => {
  it('uses explicit payload bounds', () => {
    expect(MAX_CONTEXT_ALTERNATE_TAKES).toBe(2)
    expect(MAX_CANDIDATE_CONTEXT_WORDS).toBe(120)
    expect(MAX_CANDIDATE_CONTEXT_CHARACTERS).toBe(1_200)
    expect(MAX_SURROUNDING_CONTEXT_WORDS).toBe(40)
    expect(MAX_SURROUNDING_CONTEXT_CHARACTERS).toBe(400)
    expect(MAX_ALTERNATE_CONTEXT_WORDS).toBe(80)
    expect(MAX_ALTERNATE_CONTEXT_CHARACTERS).toBe(800)
    expect(CONTEXT_OMISSION_MARKER).toBe('[content omitted]')
  })

  it('constructs one exact source-time payload with adjacent sentences', () => {
    const { transcript, candidate } = exactAlternateFixture()

    expect(buildRetakeAnalysisContext(transcript, candidate)).toEqual({
      candidate: {
        startSourceMs: 10_125,
        endSourceMs: 12_875,
        text: 'The dashboard lets you um manage uh all er projects...',
      },
      before: { text: 'The dashboard lets you manage all projects.' },
      after: { text: 'The dashboard lets you manage all projects.' },
      signals: {
        fillerCount: 3,
        fillerDensity: 0.3,
        longPauseCount: 0,
        longestPauseMs: 0,
        stumbleCount: 0,
      },
    })
  })

  it('gives a screened candidate bounded speech across one intervening sentence', () => {
    const before = ['Previous', 'product', 'context', 'ends', 'here.']
    const interjection = ['Sorry.']
    const possibleAlternate = [
      'Use',
      'the',
      'project',
      'overview',
      'to',
      'organize',
      'every',
      'workspace.',
    ]
    const transcript = compactSequential(
      before,
      FAILED_DASHBOARD,
      interjection,
      possibleAlternate,
    )
    const candidates = buildScreenedRetakeCandidates(transcript)

    expect(candidates).toHaveLength(1)
    const context = buildRetakeAnalysisContext(transcript, candidates[0])!
    const alternateStart = before.length + FAILED_DASHBOARD.length + 1

    expect(context.before).toEqual({
      text: 'Previous product context ends here.',
    })
    expect(context.after).toEqual({ text: 'Sorry.' })
    expect(context.nearbyAlternateTakes).toEqual([
      {
        startSourceMs: transcript.words[alternateStart].start * 1_000,
        endSourceMs: transcript.words.at(-1)!.end * 1_000,
        text: 'Use the project overview to organize every workspace.',
      },
    ])
  })

  it('omits absent or blank optional context and never leaks candidate metadata', () => {
    const candidate = baseCandidate({
      previousContext: '  \n ',
      nextContext: '\t',
    }) as RetakeCandidate & { privateNote: string }
    candidate.privateNote = 'must not leave the local layer'
    ;(candidate.signals as RetakeCandidate['signals'] & { extra: number }).extra =
      42

    const context = buildRetakeAnalysisContext({ words: [] }, candidate)

    expect(context).not.toBeNull()
    expect(context).not.toHaveProperty('before')
    expect(context).not.toHaveProperty('after')
    expect(context).not.toHaveProperty('nearbyAlternateTakes')
    expect(context).not.toHaveProperty('id')
    expect(context?.candidate).not.toHaveProperty('id')
    expect(context?.signals).not.toHaveProperty('extra')
    expect(JSON.stringify(context)).not.toContain('privateNote')
  })

  it('copies zero-valued optional signals instead of treating them as absent', () => {
    const context = buildRetakeAnalysisContext(
      { words: [] },
      baseCandidate(),
    )

    expect(context?.signals).toMatchObject({
      repeatedAttemptScore: 0,
      transcriptConfidence: 0,
    })
  })

  it('uses only the candidate-provided adjacent sentence window', () => {
    const transcript: Transcript = {
      words: [
        ...wordsInRange(['DISTANT', 'PROLOGUE.'], 0, 1),
        ...wordsInRange(['DISTANT', 'EPILOGUE.'], 30, 31),
      ],
    }
    const candidate = baseCandidate({
      previousContext: 'Only the immediate sentence before.',
      nextContext: 'Only the immediate sentence after.',
    })
    const serialized = JSON.stringify(
      buildRetakeAnalysisContext(transcript, candidate),
    )

    expect(serialized).toContain('Only the immediate sentence before.')
    expect(serialized).toContain('Only the immediate sentence after.')
    expect(serialized).not.toContain('DISTANT PROLOGUE')
    expect(serialized).not.toContain('DISTANT EPILOGUE')
  })

  it('keeps the closest edge of oversized before and after context', () => {
    const beforeWords = Array.from({ length: 75 }, (_, index) => `before${index}`)
    const afterWords = Array.from({ length: 75 }, (_, index) => `after${index}`)
    const context = buildRetakeAnalysisContext(
      { words: [] },
      baseCandidate({
        previousContext: beforeWords.join(' '),
        nextContext: afterWords.join(' '),
      }),
    )!

    expect(context.before).toMatchObject({ truncated: true })
    expect(context.before?.text.startsWith(CONTEXT_OMISSION_MARKER)).toBe(
      true,
    )
    expect(context.before?.text).toContain('before74')
    expect(context.before?.text).not.toContain('before0 ')
    expect(context.before!.text.length).toBeLessThanOrEqual(
      MAX_SURROUNDING_CONTEXT_CHARACTERS,
    )
    expect(context.before!.text.split(' ').length).toBeLessThanOrEqual(
      MAX_SURROUNDING_CONTEXT_WORDS,
    )

    expect(context.after).toMatchObject({ truncated: true })
    expect(context.after?.text.endsWith(CONTEXT_OMISSION_MARKER)).toBe(true)
    expect(context.after?.text).toContain('after0')
    expect(context.after?.text).not.toContain('after74')
    expect(context.after!.text.length).toBeLessThanOrEqual(
      MAX_SURROUNDING_CONTEXT_CHARACTERS,
    )
    expect(context.after!.text.split(' ').length).toBeLessThanOrEqual(
      MAX_SURROUNDING_CONTEXT_WORDS,
    )
  })

  it('keeps both ends of an oversized candidate and marks the omission', () => {
    const words = Array.from({ length: 150 }, (_, index) => `candidate${index}`)
    const context = buildRetakeAnalysisContext(
      { words: [] },
      baseCandidate({ transcriptText: words.join(' ') }),
    )!

    expect(context.candidate.truncated).toBe(true)
    expect(context.candidate.text).toContain('candidate0')
    expect(context.candidate.text).toContain('candidate149')
    expect(context.candidate.text).toContain(CONTEXT_OMISSION_MARKER)
    expect(context.candidate.text.length).toBeLessThanOrEqual(
      MAX_CANDIDATE_CONTEXT_CHARACTERS,
    )
    expect(context.candidate.text.split(' ').length).toBeLessThanOrEqual(
      MAX_CANDIDATE_CONTEXT_WORDS,
    )
  })

  it('enforces the character cap for one unusually long token', () => {
    const hugeToken = `start${'x'.repeat(2_000)}end`
    const context = buildRetakeAnalysisContext(
      { words: [] },
      baseCandidate({ transcriptText: hugeToken }),
    )!

    expect(context.candidate.truncated).toBe(true)
    expect(context.candidate.text.startsWith('start')).toBe(true)
    expect(context.candidate.text.endsWith('end')).toBe(true)
    expect(context.candidate.text.length).toBe(
      MAX_CANDIDATE_CONTEXT_CHARACTERS,
    )
  })

  it('does not split a Unicode surrogate pair at a character boundary', () => {
    const hugeToken = '😀'.repeat(1_000)
    const context = buildRetakeAnalysisContext(
      { words: [] },
      baseCandidate({ transcriptText: hugeToken }),
    )!

    expect(context.candidate.truncated).toBe(true)
    expect(context.candidate.text.length).toBeLessThanOrEqual(
      MAX_CANDIDATE_CONTEXT_CHARACTERS,
    )
    expect(context.candidate.text).toContain(CONTEXT_OMISSION_MARKER)
    expect(hasUnpairedSurrogate(context.candidate.text)).toBe(false)
  })

  it('caps alternate count after preserving Part D nearest-first order', () => {
    const transcript = compactSequential(
      CLEAN_DASHBOARD,
      CLEAN_DASHBOARD,
      FAILED_DASHBOARD,
      CLEAN_DASHBOARD,
      CLEAN_DASHBOARD,
    )
    const candidate = buildHeuristicRetakeCandidates(transcript)[0]
    const allWindows = findNearbyTakeWindows(transcript, candidate)
    const possibleAlternates = allWindows.filter(
      (take) => take.sentenceDistance > 1,
    )
    const context = buildRetakeAnalysisContext(transcript, candidate)!

    expect(allWindows.length).toBeGreaterThan(MAX_CONTEXT_ALTERNATE_TAKES)
    expect(possibleAlternates).toHaveLength(MAX_CONTEXT_ALTERNATE_TAKES)
    expect(context.nearbyAlternateTakes).toHaveLength(
      MAX_CONTEXT_ALTERNATE_TAKES,
    )
    expect(context.nearbyAlternateTakes).toEqual(
      possibleAlternates.map((take) => ({
        startSourceMs: take.startSourceMs,
        endSourceMs: take.endSourceMs,
        text: take.text,
      })),
    )
  })

  it('bounds long alternate text while preserving its full source range', () => {
    const failedWords = Array.from({ length: 100 }, (_, index) => `word${index}`)
    failedWords[99] = 'word99...'
    const cleanWords = Array.from({ length: 100 }, (_, index) => `word${index}`)
    cleanWords[99] = 'word99.'
    const transcript = compactSequential(failedWords, ['Sorry.'], cleanWords)
    const candidate = baseCandidate({
      id: 'long_candidate',
      startSourceMs: transcript.words[0].start * 1_000,
      endSourceMs: transcript.words[99].end * 1_000,
      transcriptText: failedWords.join(' '),
    })
    const sourceAlternate = findNearbyTakeWindows(transcript, candidate).find(
      (take) => take.sentenceDistance > 1,
    )!
    const context = buildRetakeAnalysisContext(transcript, candidate)!
    const alternate = context.nearbyAlternateTakes?.[0]

    expect(sourceAlternate).toBeDefined()
    expect(alternate).toMatchObject({
      startSourceMs: sourceAlternate.startSourceMs,
      endSourceMs: sourceAlternate.endSourceMs,
      truncated: true,
    })
    expect(alternate?.text).toContain('word0')
    expect(alternate?.text).toContain('word99.')
    expect(alternate!.text.length).toBeLessThanOrEqual(
      MAX_ALTERNATE_CONTEXT_CHARACTERS,
    )
  })

  it.each([
    { startSourceMs: Number.NaN, endSourceMs: 2_000 },
    { startSourceMs: -1, endSourceMs: 2_000 },
    { startSourceMs: 2_000, endSourceMs: 2_000 },
    { startSourceMs: 3_000, endSourceMs: 2_000 },
    { startSourceMs: 2_000, endSourceMs: Number.POSITIVE_INFINITY },
  ])('rejects an unsafe candidate source range: %o', (range) => {
    expect(
      buildRetakeAnalysisContext(
        { words: [] },
        baseCandidate(range),
      ),
    ).toBeNull()
  })

  it('rejects an empty candidate excerpt', () => {
    expect(
      buildRetakeAnalysisContext(
        { words: [] },
        baseCandidate({ transcriptText: ' \n\t ' }),
      ),
    ).toBeNull()
  })

  it('is deterministic, deeply fresh, and leaves every input untouched', () => {
    const transcript = compactSequential(
      ['Previous', 'context', 'ends', 'here.'],
      FAILED_DASHBOARD,
      ['Sorry.'],
      [
        'Use',
        'the',
        'project',
        'overview',
        'to',
        'organize',
        'every',
        'workspace.',
      ],
    )
    const candidate = buildScreenedRetakeCandidates(transcript)[0]
    const transcriptBefore = structuredClone(transcript)
    const candidateBefore = structuredClone(candidate)

    const first = buildRetakeAnalysisContext(transcript, candidate)!
    const second = buildRetakeAnalysisContext(transcript, candidate)!

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.candidate).not.toBe(second.candidate)
    expect(first.signals).not.toBe(second.signals)
    expect(first.before).not.toBe(second.before)
    expect(first.after).not.toBe(second.after)
    expect(first.nearbyAlternateTakes).not.toBe(
      second.nearbyAlternateTakes,
    )
    expect(first.nearbyAlternateTakes?.[0]).not.toBe(
      second.nearbyAlternateTakes?.[0],
    )
    expect(transcript).toEqual(transcriptBefore)
    expect(candidate).toEqual(candidateBefore)
  })
})
