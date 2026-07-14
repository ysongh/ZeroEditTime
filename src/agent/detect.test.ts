import { describe, it, expect } from 'vitest'
import type { Word } from '../transcript/types'
import { findFillerSpans, findSilences, findStumbleSpans } from './detect'

/** Words with explicit source timings (silence detection needs real gaps). */
function timed(...specs: Array<[string, number, number]>): Word[] {
  return specs.map(([text, start, end]) => ({ text, start, end }))
}

/** Words where text is all that matters; times are sequential filler. */
function texts(...words: string[]): Word[] {
  return words.map((text, i) => ({ text, start: i, end: i + 1 }))
}

describe('findSilences', () => {
  it('returns nothing for fewer than two words', () => {
    expect(findSilences({ words: [] }, 100)).toEqual([])
    expect(findSilences({ words: timed(['a', 0, 1]) }, 100)).toEqual([])
  })

  it('trims the middle of a gap over the threshold, keeping the default breathing room', () => {
    const t = { words: timed(['a', 0, 1], ['b', 1.5, 2.5]) }
    // 0.5s gap; the default 250ms keep survives split half/half at the edges.
    expect(findSilences(t, 300)).toEqual([{ start: 1.125, end: 1.375 }])
  })

  it('ignores gaps at or below the threshold (strict greater-than)', () => {
    const t = { words: timed(['a', 0, 1], ['b', 1.5, 2.5]) }
    // gap is exactly 0.5s; a 500ms threshold must not remove it.
    expect(findSilences(t, 500)).toEqual([])
  })

  it('finds multiple gaps and trims only inside the silence, never the words', () => {
    const t = {
      words: timed(['a', 0, 1], ['b', 2, 3], ['c', 3.1, 4], ['d', 6, 7]),
    }
    // gaps: 1.0 (a→b), 0.1 (b→c), 2.0 (c→d); threshold 500ms keeps the middle
    // word pair intact and shaves 125ms off each edge of the removed gaps.
    expect(findSilences(t, 500)).toEqual([
      { start: 1.125, end: 1.875 },
      { start: 4.125, end: 5.875 },
    ])
  })

  it('splits an explicit keep_gap_ms half/half (1.0s gap, threshold 500, keep 250)', () => {
    const t = { words: timed(['a', 0, 1], ['b', 2, 3]) }
    expect(findSilences(t, 500, 250)).toEqual([{ start: 1.125, end: 1.875 }])
  })

  it('leaves a gap not exceeding keep_gap_ms untouched regardless of threshold', () => {
    // 240ms gap clears a 150ms threshold but is under the 250ms keep — removing
    // anything would leave less breathing room than the keep guarantees.
    const t = { words: timed(['a', 0, 1], ['b', 1.24, 2]) }
    expect(findSilences(t, 150)).toEqual([])
    expect(findSilences(t, 150, 250)).toEqual([])
  })

  it('keep_gap_ms = 0 restores full-gap removal', () => {
    const t = { words: timed(['a', 0, 1], ['b', 1.5, 2.5]) }
    expect(findSilences(t, 300, 0)).toEqual([{ start: 1, end: 1.5 }])
  })
})

describe('findFillerSpans', () => {
  it('returns nothing when there are no fillers', () => {
    expect(findFillerSpans({ words: texts('this', 'is', 'clean') })).toEqual([])
  })

  it('matches default fillers ignoring case and punctuation', () => {
    const t = { words: texts('I', 'Um,', 'think', 'UH', 'so') }
    expect(findFillerSpans(t)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ])
  })

  it('matches a multi-word filler across consecutive words', () => {
    // "you know" spans words 1-2 -> [start of "you", end of "know"].
    const t = { words: texts('So', 'you', 'know', 'then') }
    expect(findFillerSpans(t)).toEqual([{ start: 1, end: 3 }])
  })

  it('prefers the longest match greedily', () => {
    const t = { words: texts('you', 'know') }
    // With both candidates, "you know" (len 2) wins over "you" (len 1).
    expect(findFillerSpans(t, ['you', 'you know'])).toEqual([
      { start: 0, end: 2 },
    ])
  })

  it('honors a custom filler list', () => {
    const t = { words: texts('basically', 'a', 'test') }
    expect(findFillerSpans(t, ['basically'])).toEqual([{ start: 0, end: 1 }])
  })
})

describe('findStumbleSpans', () => {
  // With texts(), word i spans [i, i+1] — so a range ending at the kept take's
  // first-word START is [i, j], never [i, j-1+1] via the last word's end.

  it('cuts an immediate word repeat, ending at the kept word start', () => {
    const t = { words: texts('the', 'the', 'cat') }
    expect(findStumbleSpans(t)).toEqual([{ start: 0, end: 1 }])
  })

  it('collapses a triple take to keep only the final word', () => {
    const t = { words: texts('we', 'we', 'we', 'should') }
    // Two adjacent ranges; applyRemovedRange merges them, keeping the last "we".
    expect(findStumbleSpans(t)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ])
  })

  it('cuts a partial-word restart by prefix', () => {
    const t = { words: texts('archi', 'architecture') }
    expect(findStumbleSpans(t)).toEqual([{ start: 0, end: 1 }])
  })

  it('normalizes a Whisper cutoff token before prefix-matching', () => {
    const t = { words: texts('Archi-', 'architecture') }
    expect(findStumbleSpans(t)).toEqual([{ start: 0, end: 1 }])
  })

  it('cuts a phrase restart whose final word is a prefix', () => {
    const t = {
      words: texts('we', 'built', 'the', 'arch', 'we', 'built', 'the', 'architecture'),
    }
    // The whole abandoned take [0..3] goes; the kept take starts at word 4.
    expect(findStumbleSpans(t)).toEqual([{ start: 0, end: 4 }])
  })

  it('swallows a filler between takes, ending at the kept take start', () => {
    const t = { words: texts('the', 'architecture', 'um', 'the', 'architecture') }
    // The range covers the abandoned take AND the "um" (words 0-2).
    expect(findStumbleSpans(t)).toEqual([{ start: 0, end: 3 }])
  })

  it('prefers the longest match so k=1 never fires inside a phrase repeat', () => {
    const t = { words: texts('we', 'we', 'should', 'we', 'we', 'should') }
    // k=3 wins at word 0 (removing the whole first take); the kept take's own
    // internal "we we" then fires the adjacency rule.
    expect(findStumbleSpans(t)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 4 },
    ])
  })

  it('does NOT cut distant single-word repetition', () => {
    const t = { words: texts('the', 'cat', 'and', 'the', 'dog') }
    expect(findStumbleSpans(t)).toEqual([])
  })

  it('does NOT cut a phrase recurrence beyond the retake gap', () => {
    // "we built" recurs, but 4s after the first take ends (> MAX_RETAKE_GAP_S).
    const t = {
      words: timed(['we', 0, 0.5], ['built', 0.5, 1], ['we', 5, 5.5], ['built', 5.5, 6]),
    }
    expect(findStumbleSpans(t)).toEqual([])
  })

  it('does NOT fire on a 1-2 char prefix', () => {
    const t = { words: texts('a', 'about') }
    expect(findStumbleSpans(t)).toEqual([])
  })

  it('never mutates the input transcript', () => {
    const t = { words: texts('we', 'we', 'we', 'should') }
    const snapshot = JSON.parse(JSON.stringify(t)) as typeof t
    findStumbleSpans(t)
    expect(t).toEqual(snapshot)
  })
})
