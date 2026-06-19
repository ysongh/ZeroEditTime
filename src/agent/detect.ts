// Pure range detection for the agent's tools — no React, no DOM, no API. Given a
// transcript (word-level source timings), these find the source time-ranges the
// agent should remove. They never touch the EDL: a detected range is just a
// candidate that the tool executors feed through `applyRemovedRange`.
//
// All times are seconds into the source, matching the EDL and the transcript.

import type { Transcript } from '../transcript/types'

/** A candidate source range to remove, in seconds. */
export type Range = { start: number; end: number }

// The filler words removed when the user doesn't name their own. Multi-word
// phrases ("you know") match across consecutive transcript words. Matching is
// case-insensitive and ignores surrounding punctuation (see `normalize`).
export const DEFAULT_FILLER_WORDS = [
  'um',
  'uh',
  'uhh',
  'er',
  'like',
  'you know',
  'i mean',
]

// Lowercase and strip everything that isn't a letter or digit, so a Whisper
// token like " Um," compares equal to the filler "um".
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Find the silent gaps between words. A gap is the gap between adjacent words;
 * one longer than `thresholdMs` yields the range spanning it, i.e. from the end
 * of the earlier word to the start of the next. The words themselves are never
 * part of the range.
 */
export function findSilences(
  transcript: Transcript,
  thresholdMs: number,
): Range[] {
  const threshold = thresholdMs / 1000
  const words = transcript.words
  const ranges: Range[] = []
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end
    if (gap > threshold) {
      ranges.push({ start: words[i].end, end: words[i + 1].start })
    }
  }
  return ranges
}

/**
 * Find every occurrence of a filler word/phrase. Each match yields the range
 * spanning the matched word(s). Phrases are matched greedily longest-first so a
 * multi-word filler ("you know") wins over a single word ("you") that prefixes
 * it, and matched words are not reconsidered.
 */
export function findFillerSpans(
  transcript: Transcript,
  fillerWords: string[] = DEFAULT_FILLER_WORDS,
): Range[] {
  // Pre-tokenize each filler into normalized tokens, dropping empties, and try
  // longer phrases first so the greedy scan prefers the most specific match.
  const phrases = fillerWords
    .map((filler) => filler.split(/\s+/).map(normalize).filter((t) => t !== ''))
    .filter((tokens) => tokens.length > 0)
    .sort((a, b) => b.length - a.length)

  const words = transcript.words
  const normalized = words.map((w) => normalize(w.text))
  const ranges: Range[] = []

  let i = 0
  while (i < words.length) {
    let matched = 0
    for (const tokens of phrases) {
      if (i + tokens.length > words.length) {
        continue
      }
      let isMatch = true
      for (let k = 0; k < tokens.length; k++) {
        if (normalized[i + k] !== tokens[k]) {
          isMatch = false
          break
        }
      }
      if (isMatch) {
        matched = tokens.length
        break
      }
    }
    if (matched > 0) {
      ranges.push({ start: words[i].start, end: words[i + matched - 1].end })
      i += matched
    } else {
      i++
    }
  }
  return ranges
}
