// Local sentence identity and safe context for clarity analysis. This module
// reads the original transcript and current kept ranges; it never edits either.

import type { EDL } from '../edl/types'
import { groupSentences } from '../transcript/sentences'
import type { Transcript, Word } from '../transcript/types'

/** Half-open original-source seconds, matching the EDL (never output time). */
export type ClaritySourceRange = { start: number; end: number }

/** Markers contain no transcript text from deleted or partly audible words. */
export type ClarityContextPart =
  | { kind: 'speech'; text: string }
  | { kind: 'cut' }
  | { kind: 'partial-word' }

export type ClarityProtectionReason = 'existing-cut' | 'overlapping-speech'

export type ClaritySentence = {
  /** Scoped to this original transcript, NOT a proposal freshness token. */
  id: string
  startIndex: number
  endIndex: number
  /** Original wording for local display only; may include previously cut words. */
  text: string
  sourceRange: ClaritySourceRange
  /** Only intact sentences with safe boundaries have a removal range. */
  removalRange: ClaritySourceRange | null
  protectionReasons: ClarityProtectionReason[]
  /** Kept envelope duration, including inner silence, excluding earlier cuts. */
  keptDurationSeconds: number
  contextParts: ClarityContextPart[]
}

/** Text-only projection; deliberately excludes original text and source ranges. */
export type ClaritySentenceContext = {
  sentenceId: string
  removable: boolean
  durationSeconds: number
  parts: ClarityContextPart[]
}

/** Validate coverage and merge structural splits without modifying the EDL. */
function keptRanges(edl: EDL): ClaritySourceRange[] {
  const duration = edl.source.duration
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error('Cannot map clarity sentences: invalid source duration.')
  }

  const ranges: ClaritySourceRange[] = []
  for (const segment of edl.segments) {
    const previous = ranges.at(-1)
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > duration ||
      (previous !== undefined && segment.start < previous.end)
    ) {
      throw new Error('Cannot map clarity sentences: invalid kept ranges.')
    }

    // No tolerance: even a small positive gap is an existing cut to preserve.
    if (previous !== undefined && segment.start === previous.end) {
      previous.end = segment.end
    } else {
      ranges.push({ start: segment.start, end: segment.end })
    }
  }
  return ranges
}

/** Prefix maxima also catch overlap with a long, non-adjacent earlier word. */
function validateWords(words: readonly Word[], duration: number): number[] {
  const latestEnds: number[] = []
  let previousStart = 0
  let latestEnd = 0
  for (const word of words) {
    if (
      typeof word.text !== 'string' ||
      word.text.trim() === '' ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previousStart ||
      word.end <= word.start ||
      word.end > duration
    ) {
      throw new Error(
        'Cannot map clarity sentences: transcript words need nonblank text ' +
          'and valid source timings in source order.',
      )
    }
    previousStart = word.start
    latestEnd = Math.max(latestEnd, word.end)
    latestEnds.push(latestEnd)
  }
  return latestEnds
}

function appendCut(parts: ClarityContextPart[]) {
  if (parts.at(-1)?.kind !== 'cut') parts.push({ kind: 'cut' })
}

/**
 * Describe audible word runs without filling holes from the original text.
 * A word clipped at either edge (or through its middle) is only a marker.
 */
function contextForRanges(
  words: readonly Word[],
  sourceRange: ClaritySourceRange,
  ranges: readonly ClaritySourceRange[],
): { parts: ClarityContextPart[]; hasSpeech: boolean } {
  const parts: ClarityContextPart[] = []
  let cursor = sourceRange.start
  let hasSpeech = false

  for (const range of ranges) {
    if (range.start > cursor) appendCut(parts)
    let run: string[] = []
    const flushRun = () => {
      if (run.length > 0) {
        parts.push({ kind: 'speech', text: run.join(' ') })
        run = []
      }
    }

    for (const word of words) {
      if (word.start >= range.end || word.end <= range.start) continue
      hasSpeech = true
      if (word.start >= range.start && word.end <= range.end) {
        run.push(word.text)
      } else {
        flushRun()
        parts.push({ kind: 'partial-word' })
      }
    }
    flushRun()
    cursor = range.end
  }
  if (cursor < sourceRange.end) appendCut(parts)
  return { parts, hasSpeech }
}

/**
 * Group the ORIGINAL transcript before examining cuts, so deleting words cannot
 * renumber sentences or erase a boundary. Fully deleted speech is omitted;
 * partly retained sentences stay as protected context. Throws on invalid input
 * instead of guessing, reordering words, or clamping uncertain timestamps.
 *
 * IDs must later be bound to the source/transcript/kept-range/settings snapshot.
 * A removalRange only establishes local range safety, not semantic suitability
 * or permission to remove all remaining speech.
 */
export function buildClaritySentenceCatalog(
  transcript: Transcript,
  edl: EDL,
): ClaritySentence[] {
  const kept = keptRanges(edl)
  const latestEnds = validateWords(transcript.words, edl.source.duration)
  const catalog: ClaritySentence[] = []

  for (const sentence of groupSentences(transcript.words)) {
    const { startIndex, endIndex } = sentence
    const words = transcript.words.slice(startIndex, endIndex + 1)
    const sourceRange = {
      start: words[0].start,
      // Overlap within a sentence is safe: its envelope includes every word.
      end: words.reduce((end, word) => Math.max(end, word.end), 0),
    }
    const coverage: ClaritySourceRange[] = []
    for (const range of kept) {
      if (range.end <= sourceRange.start) continue
      if (range.start >= sourceRange.end) break
      coverage.push({
        start: Math.max(range.start, sourceRange.start),
        end: Math.min(range.end, sourceRange.end),
      })
    }

    const context = contextForRanges(words, sourceRange, coverage)
    // A kept pause between deleted words is not kept speech.
    if (!context.hasSpeech) continue

    const protectionReasons: ClarityProtectionReason[] = []
    if (
      coverage.length !== 1 ||
      coverage[0].start !== sourceRange.start ||
      coverage[0].end !== sourceRange.end
    ) {
      protectionReasons.push('existing-cut')
    }

    const nextWord = transcript.words[endIndex + 1]
    if (
      (startIndex > 0 && latestEnds[startIndex - 1] > sourceRange.start) ||
      (nextWord !== undefined && nextWord.start < sourceRange.end)
    ) {
      // Never shrink the cut into a word or expand it to swallow a neighbor.
      // With ordered word starts these checks cover ALL outside word overlaps.
      protectionReasons.push('overlapping-speech')
    }

    catalog.push({
      id: `sentence:${startIndex}:${endIndex}`,
      startIndex,
      endIndex,
      text: words.map((word) => word.text).join(' '),
      sourceRange,
      removalRange: protectionReasons.length === 0 ? { ...sourceRange } : null,
      protectionReasons,
      keptDurationSeconds: coverage.reduce(
        (duration, range) => duration + (range.end - range.start),
        0,
      ),
      contextParts: context.parts,
    })
  }
  return catalog
}

/** Project only audible context. Do not serialize the local catalog for AI. */
export function buildClaritySentenceContext(
  catalog: readonly ClaritySentence[],
): ClaritySentenceContext[] {
  return catalog.map((sentence) => ({
    sentenceId: sentence.id,
    removable: sentence.removalRange !== null,
    durationSeconds: sentence.keptDurationSeconds,
    parts: sentence.contextParts.map((part) => ({ ...part })),
  }))
}
