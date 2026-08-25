// Pure Phase-11 retake-candidate construction. This layer groups supplied
// transcript-analysis signals into sentence-sized source ranges; it deliberately
// does not choose detector thresholds or make semantic retake decisions.

import type { Range } from '../agent/detect'
import { groupSentences, type Sentence } from '../transcript/sentences'
import type { Transcript, Word } from '../transcript/types'

/**
 * Existing transcript-analysis signals, all in source seconds like Transcript.
 * `longPauseSpans` must describe the full qualifying gap so its duration remains
 * accurate; Part C will decide how those qualifying spans are detected.
 */
export interface ExistingAnalysisResults {
  readonly fillerSpans: readonly Range[]
  readonly longPauseSpans: readonly Range[]
  readonly stumbleSpans: readonly Range[]
}

export interface RetakeCandidateSignals {
  fillerCount: number
  fillerDensity: number

  longPauseCount: number
  longestPauseMs: number

  stumbleCount: number

  /** Deferred until a reliable repeated-attempt signal exists. */
  repeatedAttemptScore?: number

  /** Omitted because the current Whisper response exposes no confidence. */
  transcriptConfidence?: number
}

export interface RetakeCandidate {
  id: string

  /** Half-open range [startSourceMs, endSourceMs) in source-video time. */
  startSourceMs: number
  endSourceMs: number

  transcriptText: string
  previousContext?: string
  nextContext?: string

  signals: RetakeCandidateSignals
}

interface SentenceView {
  words: Word[]
  text: string
  startSourceS: number
  endSourceS: number
}

function normalizeRanges(ranges: readonly Range[]): Range[] {
  return ranges
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start &&
        range.end > 0,
    )
    .map((range) => ({ start: Math.max(0, range.start), end: range.end }))
    .filter((range) => range.end > range.start)
}

function overlaps(
  range: Range,
  startSourceS: number,
  endSourceS: number,
): boolean {
  return range.start < endSourceS && range.end > startSourceS
}

function sentenceText(words: readonly Word[]): string {
  return words
    .map((word) => word.text.trim())
    .filter((text) => text !== '')
    .join(' ')
}

function buildSentenceView(
  words: Word[],
  sentence: Sentence,
): SentenceView | null {
  const sentenceWords = words.slice(
    sentence.startIndex,
    sentence.endIndex + 1,
  )
  if (
    sentenceWords.length === 0 ||
    sentenceWords.some(
      (word) =>
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end <= word.start,
    )
  ) {
    return null
  }

  const startSourceS = Math.min(...sentenceWords.map((word) => word.start))
  const endSourceS = Math.max(...sentenceWords.map((word) => word.end))
  const text = sentenceText(sentenceWords)
  if (text === '' || endSourceS <= startSourceS) return null

  return {
    words: sentenceWords,
    text,
    startSourceS,
    endSourceS,
  }
}

function contextText(
  words: Word[],
  sentence: Sentence | undefined,
): string | undefined {
  if (sentence === undefined) return undefined
  const text = sentenceText(
    words.slice(sentence.startIndex, sentence.endIndex + 1),
  )
  return text === '' ? undefined : text
}

/**
 * Build one deterministic candidate per signal-bearing sentence.
 *
 * This is a structural bucketing layer only: every supplied span is assumed to
 * have been selected by an analysis policy. Part C owns conservative trigger
 * thresholds, and Part D owns nearby-clean-take suppression. With no supplied
 * signals, no sentence becomes a candidate.
 */
export function buildRetakeCandidates(
  transcript: Transcript,
  analysis: Readonly<ExistingAnalysisResults>,
): RetakeCandidate[] {
  const sentences = groupSentences(transcript.words)
  if (sentences.length === 0) return []

  const fillerSpans = normalizeRanges(analysis.fillerSpans)
  const longPauseSpans = normalizeRanges(analysis.longPauseSpans)
  const stumbleSpans = normalizeRanges(analysis.stumbleSpans)
  const candidates: RetakeCandidate[] = []

  for (let index = 0; index < sentences.length; index++) {
    const view = buildSentenceView(transcript.words, sentences[index])
    if (view === null) continue

    const fillers = fillerSpans.filter((range) =>
      overlaps(range, view.startSourceS, view.endSourceS),
    )
    const longPauses = longPauseSpans.filter((range) =>
      overlaps(range, view.startSourceS, view.endSourceS),
    )
    const stumbles = stumbleSpans.filter((range) =>
      overlaps(range, view.startSourceS, view.endSourceS),
    )

    if (fillers.length + longPauses.length + stumbles.length === 0) {
      continue
    }

    const startSourceMs = view.startSourceS * 1_000
    const endSourceMs = view.endSourceS * 1_000
    const candidate: RetakeCandidate = {
      id: `retake_candidate_${startSourceMs}_${endSourceMs}`,
      startSourceMs,
      endSourceMs,
      transcriptText: view.text,
      signals: {
        fillerCount: fillers.length,
        fillerDensity: fillers.length / view.words.length,
        longPauseCount: longPauses.length,
        longestPauseMs: longPauses.reduce(
          (longest, range) =>
            Math.max(longest, range.end * 1_000 - range.start * 1_000),
          0,
        ),
        stumbleCount: stumbles.length,
      },
    }

    const previousContext = contextText(
      transcript.words,
      sentences[index - 1],
    )
    const nextContext = contextText(transcript.words, sentences[index + 1])
    if (previousContext !== undefined) {
      candidate.previousContext = previousContext
    }
    if (nextContext !== undefined) candidate.nextContext = nextContext

    candidates.push(candidate)
  }

  return candidates.sort(
    (a, b) =>
      a.startSourceMs - b.startSourceMs ||
      a.endSourceMs - b.endSourceMs ||
      a.id.localeCompare(b.id),
  )
}
