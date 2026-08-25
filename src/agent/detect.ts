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
// case-insensitive and ignores surrounding punctuation (see
// `normalizeSpeechToken`).
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
export function normalizeSpeechToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// How much of each removed gap survives, by default, as breathing room (Phase
// 5.5B). Deleting a gap wholly produces machine-gun pacing; ~250 ms keeps a
// natural beat so the viewer can absorb what's on screen.
export const DEFAULT_KEEP_GAP_MS = 250

/**
 * Find the silent gaps between words. A gap is the gap between adjacent words;
 * one longer than `thresholdMs` AND longer than `keepGapMs` (so the removal is
 * always positive) yields a range trimming the MIDDLE of the gap:
 * `keepGapMs` of it survives, split half/half at the edges — the earlier word
 * keeps its natural decay, the next word its inhale/lead-in. `keepGapMs = 0`
 * removes qualifying gaps wholly (the old behavior). The words themselves are
 * never part of the range.
 */
export function findSilences(
  transcript: Transcript,
  thresholdMs: number,
  keepGapMs: number = DEFAULT_KEEP_GAP_MS,
): Range[] {
  const threshold = thresholdMs / 1000
  const keep = keepGapMs / 1000
  const words = transcript.words
  const ranges: Range[] = []
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end
    if (gap > threshold && gap > keep) {
      ranges.push({
        start: words[i].end + keep / 2,
        end: words[i + 1].start - keep / 2,
      })
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
    .map((filler) =>
      filler
        .split(/\s+/)
        .map(normalizeSpeechToken)
        .filter((token) => token !== ''),
    )
    .filter((tokens) => tokens.length > 0)
    .sort((a, b) => b.length - a.length)

  const words = transcript.words
  const normalized = words.map((word) => normalizeSpeechToken(word.text))
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

// ——— Stumble detection (Phase 4.5) ———
//
// Repetition is also how normal speech works, so these thresholds are tuned for
// precision over recall: a missed stumble is a shrug, a false positive deletes
// real content. Whisper cleans up most small flubs, so what survives — and what
// this detects — is full restarts and repeated words/phrases.

// Longest phrase (in words) tried as a retake unit. Tried longest-first at each
// position so a single-word rule never fires inside a longer phrase repeat.
export const MAX_NGRAM = 4
// A phrase recurrence must start within this many words after the abandoned
// take ends (lets a filler like "um" sit between the takes)…
export const MAX_BETWEEN_WORDS = 2
// …and within this many seconds (end of the abandoned take's last word to the
// retake's first word). The same phrase recurring later is normal speech.
export const MAX_RETAKE_GAP_S = 3.0
// Minimum length of a partial-word restart ("archi architecture"). Shorter
// prefixes ("a about") are far more likely to be ordinary words.
export const MIN_PREFIX_LEN = 3

/**
 * Find verbal stumbles — immediate word repeats, partial-word restarts, and
 * re-said phrases — keeping the LAST take. Each detected region yields the range
 * [abandonedTakeFirstWord.start, keptTakeFirstWord.start): unlike filler spans,
 * it ends at the START of the kept take, so the dead air and any filler between
 * the takes is swallowed with the abandoned take.
 *
 * Rules (greedy left-to-right scan):
 * - Single-word repeats fire only on immediate adjacency ("the the"), never at
 *   a distance ("the cat and the dog").
 * - Phrase repeats (2+ words) fire only when the recurrence starts within
 *   MAX_BETWEEN_WORDS words and MAX_RETAKE_GAP_S seconds of the abandoned take.
 * - The FINAL word of the abandoned take may be a prefix (≥ MIN_PREFIX_LEN
 *   chars) of its counterpart instead of equal — a mid-word restart.
 * - After a match the scan continues FROM the retake, so chained takes
 *   ("we we we should") collapse to ranges that keep only the final one.
 */
export function findStumbleSpans(transcript: Transcript): Range[] {
  const words = transcript.words
  const normalized = words.map((word) => normalizeSpeechToken(word.text))
  const ranges: Range[] = []

  // Does the k-word take starting at `i` recur starting at `j`? Earlier words
  // must be normalized-equal; the final word may instead be a prefix of its
  // counterpart. Empty-normalized tokens (pure punctuation) never match.
  function matchesAt(i: number, j: number, k: number): boolean {
    for (let m = 0; m < k; m++) {
      const abandoned = normalized[i + m]
      const retake = normalized[j + m]
      if (abandoned === '' || retake === '') {
        return false
      }
      if (abandoned === retake) {
        continue
      }
      const isFinalWord = m === k - 1
      if (
        isFinalWord &&
        abandoned.length >= MIN_PREFIX_LEN &&
        retake.startsWith(abandoned)
      ) {
        continue
      }
      return false
    }
    return true
  }

  let i = 0
  while (i < words.length) {
    // Prefer the longest match: k counts down so a k=1 repeat never fires
    // inside a longer phrase repeat. `retakeStart` is the kept take's first word.
    let retakeStart = -1
    for (let k = MAX_NGRAM; k >= 1 && retakeStart === -1; k--) {
      if (k === 1) {
        // Single-word rule: immediate adjacency only.
        if (i + 1 < words.length && matchesAt(i, i + 1, 1)) {
          retakeStart = i + 1
        }
        continue
      }
      // Phrase rule: the retake may start up to MAX_BETWEEN_WORDS after the
      // abandoned take ends, but must begin within MAX_RETAKE_GAP_S of it.
      for (let j = i + k; j <= i + k + MAX_BETWEEN_WORDS; j++) {
        if (j + k > words.length) {
          break
        }
        const gap = words[j].start - words[i + k - 1].end
        if (gap > MAX_RETAKE_GAP_S) {
          continue
        }
        if (matchesAt(i, j, k)) {
          retakeStart = j
          break
        }
      }
    }

    if (retakeStart !== -1) {
      ranges.push({ start: words[i].start, end: words[retakeStart].start })
      i = retakeStart
    } else {
      i++
    }
  }
  return ranges
}
