// Pure, framework-free sentence grouping over a transcript's word list. A
// sentence is a contiguous run of words that ends at terminal punctuation
// (. ? !). This drives the "delete a sentence in one action" affordance: a
// sentence is just an index span, which maps to a source range the same way a
// hand-selected word span does. No React, no DOM — unit-tested in isolation.

import type { Word } from './types'

/** Inclusive index span into the transcript's `words` array. */
export type Sentence = { startIndex: number; endIndex: number }

// A word ends a sentence if its (trimmed) text closes with terminal punctuation,
// allowing trailing closing quotes/brackets after it (e.g. `done."`, `right?")`).
// Abbreviations like "Mr." will mis-split; that is acceptable for this phase.
const TERMINAL = /[.?!]["')\]]*$/

/**
 * Does this word close a sentence? Exported so Phase-6 caption chunking
 * (`src/captions/`) shares the one terminal-punctuation definition instead of
 * duplicating the regex.
 */
export function endsSentence(text: string): boolean {
  return TERMINAL.test(text.trim())
}

/**
 * Group consecutive words into sentences. Each terminal-punctuation word closes
 * the current sentence; any words trailing after the last terminal mark form a
 * final sentence. A transcript with no terminal punctuation collapses to a single
 * group spanning every word (the fallback falls out of the trailing flush). An
 * empty word list yields no sentences.
 */
export function groupSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = []
  let start = 0

  for (let i = 0; i < words.length; i++) {
    if (endsSentence(words[i].text)) {
      sentences.push({ startIndex: start, endIndex: i })
      start = i + 1
    }
  }

  // Flush a dangling run with no closing punctuation (also the no-punctuation
  // fallback: one group covering all the words).
  if (start < words.length) {
    sentences.push({ startIndex: start, endIndex: words.length - 1 })
  }

  return sentences
}
