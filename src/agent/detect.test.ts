import { describe, it, expect } from 'vitest'
import type { Word } from '../transcript/types'
import { findFillerSpans, findSilences } from './detect'

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

  it('emits the gap range for an inter-word gap over the threshold', () => {
    const t = { words: timed(['a', 0, 1], ['b', 1.5, 2.5]) }
    expect(findSilences(t, 300)).toEqual([{ start: 1, end: 1.5 }])
  })

  it('ignores gaps at or below the threshold (strict greater-than)', () => {
    const t = { words: timed(['a', 0, 1], ['b', 1.5, 2.5]) }
    // gap is exactly 0.5s; a 500ms threshold must not remove it.
    expect(findSilences(t, 500)).toEqual([])
  })

  it('finds multiple gaps and spans only the silence, never the words', () => {
    const t = {
      words: timed(['a', 0, 1], ['b', 2, 3], ['c', 3.1, 4], ['d', 6, 7]),
    }
    // gaps: 1.0 (a→b), 0.1 (b→c), 2.0 (c→d); threshold 500ms keeps the middle.
    expect(findSilences(t, 500)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 6 },
    ])
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
