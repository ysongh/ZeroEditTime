import { describe, it, expect } from 'vitest'
import type { Word } from './types'
import { groupSentences } from './sentences'

/** Build a word list from texts; times are filler (grouping ignores them). */
function words(...texts: string[]): Word[] {
  return texts.map((text, i) => ({ text, start: i, end: i + 1 }))
}

describe('groupSentences', () => {
  it('returns no sentences for an empty word list', () => {
    expect(groupSentences([])).toEqual([])
  })

  it('splits on a period into separate sentences', () => {
    const w = words('Hello', 'there.', 'How', 'are', 'you.')
    expect(groupSentences(w)).toEqual([
      { startIndex: 0, endIndex: 1 },
      { startIndex: 2, endIndex: 4 },
    ])
  })

  it('treats ? and ! as terminal punctuation', () => {
    const w = words('Stop!', 'Who', 'goes', 'there?', 'Go')
    expect(groupSentences(w)).toEqual([
      { startIndex: 0, endIndex: 0 },
      { startIndex: 1, endIndex: 3 },
      { startIndex: 4, endIndex: 4 }, // dangling tail, no closing mark
    ])
  })

  it('allows trailing quotes/brackets after the terminal mark', () => {
    const w = words('He', 'said', '"go."', 'Then', 'left.')
    expect(groupSentences(w)).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 3, endIndex: 4 },
    ])
  })

  it('falls back to a single group when there is no terminal punctuation', () => {
    const w = words('just', 'some', 'words', 'no', 'period')
    expect(groupSentences(w)).toEqual([{ startIndex: 0, endIndex: 4 }])
  })

  it('handles a single terminated word', () => {
    expect(groupSentences(words('Yes.'))).toEqual([{ startIndex: 0, endIndex: 0 }])
  })

  it('closes the final sentence when the last word terminates', () => {
    const w = words('One.', 'Two.')
    expect(groupSentences(w)).toEqual([
      { startIndex: 0, endIndex: 0 },
      { startIndex: 1, endIndex: 1 },
    ])
  })
})
