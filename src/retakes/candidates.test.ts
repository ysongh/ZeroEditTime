import { describe, expect, it } from 'vitest'
import type { Range } from '../agent/detect'
import type { Transcript, Word } from '../transcript/types'
import {
  buildRetakeCandidates,
  type ExistingAnalysisResults,
} from './candidates'

const NO_ANALYSIS: ExistingAnalysisResults = {
  fillerSpans: [],
  longPauseSpans: [],
  stumbleSpans: [],
}

function timed(...specs: Array<[string, number, number]>): Word[] {
  return specs.map(([text, start, end]) => ({ text, start, end }))
}

describe('buildRetakeCandidates', () => {
  it('returns no candidates for an empty transcript or no supplied signals', () => {
    expect(buildRetakeCandidates({ words: [] }, NO_ANALYSIS)).toEqual([])
    expect(
      buildRetakeCandidates(
        { words: timed(['This', 0, 0.3], ['works.', 0.35, 0.7]) },
        NO_ANALYSIS,
      ),
    ).toEqual([])
  })

  it('builds one full-sentence candidate in original source milliseconds', () => {
    const transcript: Transcript = {
      words: timed(
        ['Before', 0, 0.25],
        ['this.', 0.3, 0.6],
        ['We', 1.25, 1.45],
        ['um,', 1.5, 1.7],
        ['continue.', 1.75, 2.4],
        ['After', 3, 3.25],
        ['that.', 3.3, 3.8],
      ),
    }

    expect(
      buildRetakeCandidates(transcript, {
        ...NO_ANALYSIS,
        fillerSpans: [{ start: 1.5, end: 1.7 }],
      }),
    ).toEqual([
      {
        id: 'retake_candidate_1250_2400',
        startSourceMs: 1_250,
        endSourceMs: 2_400,
        transcriptText: 'We um, continue.',
        previousContext: 'Before this.',
        nextContext: 'After that.',
        signals: {
          fillerCount: 1,
          fillerDensity: 1 / 3,
          longPauseCount: 0,
          longestPauseMs: 0,
          stumbleCount: 0,
        },
      },
    ])
  })

  it('aggregates all overlapping signals into one candidate', () => {
    const transcript: Transcript = {
      words: timed(
        ['So', 2, 2.2],
        ['um', 2.25, 2.4],
        ['we', 3.1, 3.25],
        ['we', 3.3, 3.45],
        ['uh', 3.5, 3.65],
        ['continue.', 3.7, 4.1],
      ),
    }

    expect(
      buildRetakeCandidates(transcript, {
        fillerSpans: [
          { start: 2.25, end: 2.4 },
          { start: 3.5, end: 3.65 },
        ],
        longPauseSpans: [
          { start: 2.4, end: 3.1 },
          { start: 3.45, end: 3.5 },
        ],
        stumbleSpans: [
          { start: 3.1, end: 3.3 },
          { start: 3.3, end: 3.5 },
        ],
      }),
    ).toEqual([
      {
        id: 'retake_candidate_2000_4100',
        startSourceMs: 2_000,
        endSourceMs: 4_100,
        transcriptText: 'So um we we uh continue.',
        signals: {
          fillerCount: 2,
          fillerDensity: 2 / 6,
          longPauseCount: 2,
          longestPauseMs: 700,
          stumbleCount: 2,
        },
      },
    ])
  })

  it('treats ranges as half-open so a pause between sentences selects neither', () => {
    const transcript: Transcript = {
      words: timed(
        ['First', 0, 0.4],
        ['ends.', 0.45, 1],
        ['Second', 2, 2.4],
        ['starts.', 2.45, 3],
      ),
    }

    expect(
      buildRetakeCandidates(transcript, {
        ...NO_ANALYSIS,
        longPauseSpans: [{ start: 1, end: 2 }],
      }),
    ).toEqual([])
  })

  it('includes only the immediately adjacent available sentence context', () => {
    const transcript: Transcript = {
      words: timed(
        ['  First  ', 0, 0.4],
        [' sentence. ', 0.45, 1],
        ['Second', 2, 2.4],
        ['um.', 2.45, 3],
        [' Third', 4, 4.4],
        ['sentence.  ', 4.45, 5],
      ),
    }
    const candidates = buildRetakeCandidates(transcript, {
      ...NO_ANALYSIS,
      fillerSpans: [
        { start: 0, end: 0.4 },
        { start: 4, end: 4.4 },
      ],
    })

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).not.toHaveProperty('previousContext')
    expect(candidates[0].nextContext).toBe('Second um.')
    expect(candidates[1].previousContext).toBe('Second um.')
    expect(candidates[1]).not.toHaveProperty('nextContext')
    expect(candidates[0].endSourceMs).toBe(1_000)
    expect(candidates[1].startSourceMs).toBe(4_000)
  })

  it('sorts candidates chronologically with deterministic identities', () => {
    const transcript: Transcript = {
      words: timed(
        ['Textually', 10, 10.4],
        ['first.', 10.5, 11],
        ['Textually', 2, 2.4],
        ['second.', 2.5, 3],
      ),
    }
    const first = buildRetakeCandidates(transcript, {
      ...NO_ANALYSIS,
      stumbleSpans: [
        { start: 10, end: 10.5 },
        { start: 2, end: 2.5 },
      ],
    })
    const reordered = buildRetakeCandidates(transcript, {
      ...NO_ANALYSIS,
      stumbleSpans: [
        { start: 2, end: 2.5 },
        { start: 10, end: 10.5 },
      ],
    })

    expect(first.map((candidate) => candidate.startSourceMs)).toEqual([
      2_000, 10_000,
    ])
    expect(first.map((candidate) => candidate.id)).toEqual([
      'retake_candidate_2000_3000',
      'retake_candidate_10000_11000',
    ])
    expect(reordered).toEqual(first)
  })

  it('ignores malformed signal ranges', () => {
    const invalidRanges: Range[] = [
      { start: Number.NaN, end: 0.5 },
      { start: 0.1, end: Number.POSITIVE_INFINITY },
      { start: 0.5, end: 0.5 },
      { start: 0.8, end: 0.4 },
      { start: -2, end: -1 },
    ]
    const transcript: Transcript = {
      words: timed(['Still', 0, 0.4], ['clean.', 0.45, 1]),
    }

    expect(
      buildRetakeCandidates(transcript, {
        fillerSpans: invalidRanges,
        longPauseSpans: invalidRanges,
        stumbleSpans: invalidRanges,
      }),
    ).toEqual([])
  })

  it('never emits invalid timing from malformed transcript words', () => {
    const transcript: Transcript = {
      words: timed(
        ['Broken', Number.NaN, 0.4],
        ['sentence.', 0.5, 1],
        ['Later', 2, 2.4],
        ['works.', 2.5, 3],
      ),
    }

    expect(
      buildRetakeCandidates(transcript, {
        ...NO_ANALYSIS,
        fillerSpans: [
          { start: 0.5, end: 0.8 },
          { start: 2, end: 2.4 },
        ],
      }),
    ).toEqual([
      {
        id: 'retake_candidate_2000_3000',
        startSourceMs: 2_000,
        endSourceMs: 3_000,
        transcriptText: 'Later works.',
        previousContext: 'Broken sentence.',
        signals: {
          fillerCount: 1,
          fillerDensity: 0.5,
          longPauseCount: 0,
          longestPauseMs: 0,
          stumbleCount: 0,
        },
      },
    ])
  })

  it('does not invent unavailable confidence or repeated-attempt data', () => {
    const candidate = buildRetakeCandidates(
      { words: timed(['Um', 0, 0.2], ['okay.', 0.25, 0.7]) },
      {
        ...NO_ANALYSIS,
        fillerSpans: [{ start: 0, end: 0.2 }],
      },
    )[0]

    expect(candidate.signals).not.toHaveProperty('transcriptConfidence')
    expect(candidate.signals).not.toHaveProperty('repeatedAttemptScore')
  })

  it('returns fresh values without mutating transcript or analysis inputs', () => {
    const transcript: Transcript = {
      words: timed(['We', 0, 0.2], ['we', 0.25, 0.45], ['continue.', 0.5, 1]),
    }
    const analysis: ExistingAnalysisResults = {
      fillerSpans: [],
      longPauseSpans: [],
      stumbleSpans: [{ start: 0, end: 0.25 }],
    }
    const transcriptBefore = structuredClone(transcript)
    const analysisBefore = structuredClone(analysis)

    const first = buildRetakeCandidates(transcript, analysis)
    const second = buildRetakeCandidates(transcript, analysis)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first[0].signals).not.toBe(second[0].signals)
    expect(transcript).toEqual(transcriptBefore)
    expect(analysis).toEqual(analysisBefore)
  })
})
