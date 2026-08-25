import { describe, expect, it } from 'vitest'
import type { Transcript, Word } from '../transcript/types'
import {
  LONG_HESITATION_THRESHOLD_MS,
  MIN_EXCESSIVE_FILLER_COUNT,
  MIN_EXCESSIVE_FILLER_DENSITY,
  MIN_LONG_HESITATION_WORD_COUNT,
  MIN_SEVERE_STUMBLE_COUNT,
  buildHeuristicRetakeCandidates,
} from './heuristics'

function timed(...specs: Array<[string, number, number]>): Word[] {
  return specs.map(([text, start, end]) => ({ text, start, end }))
}

function sequential(...texts: string[]): Transcript {
  return {
    words: texts.map((text, index) => ({
      text,
      start: index * 0.4,
      end: index * 0.4 + 0.3,
    })),
  }
}

describe('buildHeuristicRetakeCandidates', () => {
  it('uses the documented conservative thresholds', () => {
    expect(MIN_EXCESSIVE_FILLER_COUNT).toBe(3)
    expect(MIN_EXCESSIVE_FILLER_DENSITY).toBe(0.3)
    expect(LONG_HESITATION_THRESHOLD_MS).toBe(2_000)
    expect(MIN_LONG_HESITATION_WORD_COUNT).toBe(5)
    expect(MIN_SEVERE_STUMBLE_COUNT).toBe(2)
  })

  it('does not flag clean speech or infer an incomplete thought from punctuation alone', () => {
    expect(
      buildHeuristicRetakeCandidates(
        sequential('This', 'sentence', 'is', 'clear.'),
      ),
    ).toEqual([])
    expect(
      buildHeuristicRetakeCandidates(
        sequential('This', 'dangling', 'thought', 'is', 'still', 'clean'),
      ),
    ).toEqual([])
  })

  it('does not flag one filler or two fillers at high density', () => {
    expect(
      buildHeuristicRetakeCandidates(
        sequential('We', 'um', 'can', 'continue', 'cleanly.'),
      ),
    ).toEqual([])
    expect(
      buildHeuristicRetakeCandidates(
        sequential('Um', 'we', 'uh', 'continue.'),
      ),
    ).toEqual([])
  })

  it('flags three fillers at the inclusive 30 percent density boundary', () => {
    const candidates = buildHeuristicRetakeCandidates(
      sequential(
        'So',
        'um',
        'we',
        'can',
        'uh',
        'now',
        'explain',
        'er',
        'workflow',
        'clearly.',
      ),
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0].signals).toMatchObject({
      fillerCount: 3,
      fillerDensity: 0.3,
      longPauseCount: 0,
      stumbleCount: 0,
    })
  })

  it('does not flag three fillers below the density threshold', () => {
    expect(
      buildHeuristicRetakeCandidates(
        sequential(
          'So',
          'um',
          'we',
          'can',
          'uh',
          'now',
          'explain',
          'er',
          'the',
          'workflow',
          'very',
          'clearly.',
        ),
      ),
    ).toEqual([])
  })

  it('flags the full source-time gap for a long internal hesitation', () => {
    const transcript: Transcript = {
      words: timed(
        ['This', 4, 4.2],
        ['feature', 4.25, 4.5],
        ['exports', 6.501, 6.8],
        ['clips', 6.85, 7.1],
        ['cleanly.', 7.15, 7.5],
      ),
    }
    const candidates = buildHeuristicRetakeCandidates(transcript)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: 'retake_candidate_4000_7500',
      startSourceMs: 4_000,
      endSourceMs: 7_500,
      signals: {
        fillerCount: 0,
        fillerDensity: 0,
        longPauseCount: 1,
        longestPauseMs: 2_001,
        stumbleCount: 0,
      },
    })
  })

  it('requires a pause to exceed two seconds inside a meaningful sentence', () => {
    const exactThreshold: Transcript = {
      words: timed(
        ['This', 0, 0.2],
        ['feature', 0.25, 0.5],
        ['exports', 2.5, 2.8],
        ['clips', 2.85, 3.1],
        ['cleanly.', 3.15, 3.5],
      ),
    }
    const shortFragment: Transcript = {
      words: timed(
        ['This', 0, 0.2],
        ['feature', 0.25, 0.5],
        ['exports', 2.501, 2.8],
        ['cleanly.', 2.85, 3.2],
      ),
    }

    expect(buildHeuristicRetakeCandidates(exactThreshold)).toEqual([])
    expect(buildHeuristicRetakeCandidates(shortFragment)).toEqual([])
  })

  it('does not treat a long paragraph pause between sentences as hesitation', () => {
    const transcript: Transcript = {
      words: timed(
        ['This', 0, 0.15],
        ['first', 0.2, 0.35],
        ['sentence', 0.4, 0.55],
        ['is', 0.6, 0.7],
        ['complete.', 0.75, 1],
        ['This', 4, 4.15],
        ['second', 4.2, 4.35],
        ['sentence', 4.4, 4.55],
        ['starts', 4.6, 4.75],
        ['cleanly.', 4.8, 5],
      ),
    }

    expect(buildHeuristicRetakeCandidates(transcript)).toEqual([])
  })

  it('does not flag one editing-fixable stumble', () => {
    expect(
      buildHeuristicRetakeCandidates(
        sequential('We', 'we', 'should', 'continue', 'now.'),
      ),
    ).toEqual([])
  })

  it('flags two stumble markers in one sentence as severe', () => {
    const candidates = buildHeuristicRetakeCandidates(
      sequential('We', 'we', 'can', 'now', 'now', 'continue.'),
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0].signals.stumbleCount).toBe(2)
  })

  it('keeps stumble severity sentence-local', () => {
    expect(
      buildHeuristicRetakeCandidates(
        sequential(
          'We',
          'we',
          'continue.',
          'Now',
          'now',
          'finish.',
        ),
      ),
    ).toEqual([])
  })

  it('surfaces repeated failed attempts without inventing a score', () => {
    const candidates = buildHeuristicRetakeCandidates(
      sequential(
        'we',
        'built',
        'the',
        'arch-',
        'we',
        'built',
        'the',
        'arch-',
        'we',
        'built',
        'the',
        'architecture',
        'now.',
      ),
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0].signals.stumbleCount).toBe(2)
    expect(candidates[0].signals).not.toHaveProperty('repeatedAttemptScore')
    expect(candidates[0].signals).not.toHaveProperty('transcriptConfidence')
  })

  it('does not combine several weak signals into an undocumented score', () => {
    const transcript: Transcript = {
      words: timed(
        ['Um', 0, 0.2],
        ['we', 0.25, 0.45],
        ['we', 0.5, 0.7],
        ['uh', 1.8, 2],
        ['continue', 2.05, 2.3],
        ['now.', 2.35, 2.7],
      ),
    }

    expect(buildHeuristicRetakeCandidates(transcript)).toEqual([])
  })

  it('retains weaker co-signals when a strong trigger qualifies', () => {
    const transcript: Transcript = {
      words: timed(
        ['Um', 8, 8.2],
        ['we', 8.25, 8.45],
        ['we', 8.5, 8.7],
        ['can', 10.701, 10.9],
        ['continue', 10.95, 11.2],
        ['now.', 11.25, 11.6],
      ),
    }
    const candidates = buildHeuristicRetakeCandidates(transcript)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      startSourceMs: 8_000,
      endSourceMs: 11_600,
      signals: {
        fillerCount: 1,
        fillerDensity: 1 / 6,
        longPauseCount: 1,
        longestPauseMs: 2_001,
        stumbleCount: 1,
      },
    })
  })

  it('is deterministic, pure, and returns fresh candidate values', () => {
    const transcript = sequential(
      'So',
      'um',
      'we',
      'can',
      'uh',
      'now',
      'explain',
      'er',
      'workflow',
      'clearly.',
    )
    const before = structuredClone(transcript)

    const first = buildHeuristicRetakeCandidates(transcript)
    const second = buildHeuristicRetakeCandidates(transcript)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first[0].signals).not.toBe(second[0].signals)
    expect(transcript).toEqual(before)
  })
})
