// Pure Phase-11 model-context construction. This layer shapes one screened
// candidate into a small, predictable payload; it does not build a prompt,
// call a model, or decide whether a retake is needed.

import type { Transcript } from '../transcript/types'
import {
  type RetakeCandidate,
  type RetakeCandidateSignals,
} from './candidates'
import { findNearbyTakeWindows } from './nearbyTakes'

export const MAX_CONTEXT_ALTERNATE_TAKES = 2

export const MAX_CANDIDATE_CONTEXT_WORDS = 120
export const MAX_CANDIDATE_CONTEXT_CHARACTERS = 1_200

export const MAX_SURROUNDING_CONTEXT_WORDS = 40
export const MAX_SURROUNDING_CONTEXT_CHARACTERS = 400

export const MAX_ALTERNATE_CONTEXT_WORDS = 80
export const MAX_ALTERNATE_CONTEXT_CHARACTERS = 800

/** Fixed non-transcript marker so a clipped excerpt cannot look verbatim. */
export const CONTEXT_OMISSION_MARKER = '[content omitted]'

const CONTEXT_OMISSION_MARKER_WORDS = 2

export interface RetakeAnalysisTextContext {
  text: string
  truncated?: true
}

export interface RetakeAnalysisSourceContext
  extends RetakeAnalysisTextContext {
  /** Half-open range in original-source milliseconds. */
  startSourceMs: number
  endSourceMs: number
}

export interface RetakeAnalysisContext {
  candidate: RetakeAnalysisSourceContext
  before?: RetakeAnalysisTextContext
  after?: RetakeAnalysisTextContext
  nearbyAlternateTakes?: RetakeAnalysisSourceContext[]
  signals: RetakeCandidateSignals
}

type ExcerptDirection = 'prefix' | 'suffix' | 'head-tail'

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function safePrefixSlice(text: string, maxCharacters: number): string {
  let end = Math.min(text.length, maxCharacters)
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end--
  }
  return text.slice(0, end)
}

function safeSuffixSlice(text: string, maxCharacters: number): string {
  let start = Math.max(0, text.length - maxCharacters)
  if (
    start > 0 &&
    start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) &&
    isLowSurrogate(text.charCodeAt(start))
  ) {
    start++
  }
  return text.slice(start)
}

function clipPrefix(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text

  const raw = safePrefixSlice(text, maxCharacters)
  if (text[raw.length] === ' ' || raw.endsWith(' ')) return raw.trim()

  const boundary = raw.lastIndexOf(' ')
  return (boundary > 0 ? raw.slice(0, boundary) : raw).trim()
}

function clipSuffix(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text

  const raw = safeSuffixSlice(text, maxCharacters)
  const start = text.length - raw.length
  if (text[start] === ' ' || text[start - 1] === ' ') return raw.trim()

  const boundary = raw.indexOf(' ')
  return (boundary >= 0 ? raw.slice(boundary + 1) : raw).trim()
}

function directionalExcerpt(
  words: readonly string[],
  maxWords: number,
  maxCharacters: number,
  direction: 'prefix' | 'suffix',
): string {
  const retainedWords = Math.max(
    1,
    maxWords - CONTEXT_OMISSION_MARKER_WORDS,
  )
  const selected =
    direction === 'prefix'
      ? words.slice(0, retainedWords).join(' ')
      : words.slice(-retainedWords).join(' ')
  const availableCharacters =
    maxCharacters - CONTEXT_OMISSION_MARKER.length - 1
  const clipped =
    direction === 'prefix'
      ? clipPrefix(selected, availableCharacters)
      : clipSuffix(selected, availableCharacters)

  return direction === 'prefix'
    ? `${clipped} ${CONTEXT_OMISSION_MARKER}`
    : `${CONTEXT_OMISSION_MARKER} ${clipped}`
}

function headTailExcerpt(
  normalizedText: string,
  words: readonly string[],
  maxWords: number,
  maxCharacters: number,
): string {
  const availableCharacters =
    maxCharacters - CONTEXT_OMISSION_MARKER.length - 2
  const headCharacters = Math.ceil(availableCharacters / 2)
  const tailCharacters = Math.floor(availableCharacters / 2)

  // Preserve both ends even when one unusually long token alone exceeds the
  // character cap.
  if (words.length === 1) {
    const head = safePrefixSlice(normalizedText, headCharacters)
    const tail = safeSuffixSlice(normalizedText, tailCharacters)
    return `${head} ${CONTEXT_OMISSION_MARKER} ${tail}`
  }

  const retainedWordCount = Math.min(
    Math.max(1, maxWords - CONTEXT_OMISSION_MARKER_WORDS),
    words.length,
  )
  const headWordCount = Math.ceil(retainedWordCount / 2)
  const tailWordCount = Math.floor(retainedWordCount / 2)
  const head = clipPrefix(
    words.slice(0, headWordCount).join(' '),
    headCharacters,
  )
  const tail = clipSuffix(
    words.slice(-tailWordCount).join(' '),
    tailCharacters,
  )

  return `${head} ${CONTEXT_OMISSION_MARKER} ${tail}`
}

function boundedText(
  text: string,
  maxWords: number,
  maxCharacters: number,
  direction: ExcerptDirection,
): RetakeAnalysisTextContext | null {
  const normalizedText = normalizeWhitespace(text)
  if (normalizedText === '') return null

  const words = normalizedText.split(' ')
  if (
    words.length <= maxWords &&
    normalizedText.length <= maxCharacters
  ) {
    return { text: normalizedText }
  }

  const excerpt =
    direction === 'head-tail'
      ? headTailExcerpt(normalizedText, words, maxWords, maxCharacters)
      : directionalExcerpt(words, maxWords, maxCharacters, direction)
  return { text: excerpt, truncated: true }
}

function candidateSignals(
  signals: RetakeCandidateSignals,
): RetakeCandidateSignals {
  const copy: RetakeCandidateSignals = {
    fillerCount: signals.fillerCount,
    fillerDensity: signals.fillerDensity,
    longPauseCount: signals.longPauseCount,
    longestPauseMs: signals.longestPauseMs,
    stumbleCount: signals.stumbleCount,
  }
  if (signals.repeatedAttemptScore !== undefined) {
    copy.repeatedAttemptScore = signals.repeatedAttemptScore
  }
  if (signals.transcriptConfidence !== undefined) {
    copy.transcriptConfidence = signals.transcriptConfidence
  }
  return copy
}

function hasValidCandidateRange(candidate: RetakeCandidate): boolean {
  return (
    Number.isFinite(candidate.startSourceMs) &&
    Number.isFinite(candidate.endSourceMs) &&
    candidate.startSourceMs >= 0 &&
    candidate.endSourceMs > candidate.startSourceMs
  )
}

/**
 * Construct bounded evidence for one candidate.
 *
 * Normal callers should pass a candidate that survived Part D. Keeping this
 * constructor independent of suppression also makes the boundary testable with
 * raw candidates and their known alternate-take metadata.
 */
export function buildRetakeAnalysisContext(
  transcript: Transcript,
  candidate: RetakeCandidate,
): RetakeAnalysisContext | null {
  if (!hasValidCandidateRange(candidate)) return null

  const candidateText = boundedText(
    candidate.transcriptText,
    MAX_CANDIDATE_CONTEXT_WORDS,
    MAX_CANDIDATE_CONTEXT_CHARACTERS,
    'head-tail',
  )
  if (candidateText === null) return null

  const context: RetakeAnalysisContext = {
    candidate: {
      startSourceMs: candidate.startSourceMs,
      endSourceMs: candidate.endSourceMs,
      ...candidateText,
    },
    signals: candidateSignals(candidate.signals),
  }

  const before = boundedText(
    candidate.previousContext ?? '',
    MAX_SURROUNDING_CONTEXT_WORDS,
    MAX_SURROUNDING_CONTEXT_CHARACTERS,
    'suffix',
  )
  if (before !== null) context.before = before

  const after = boundedText(
    candidate.nextContext ?? '',
    MAX_SURROUNDING_CONTEXT_WORDS,
    MAX_SURROUNDING_CONTEXT_CHARACTERS,
    'prefix',
  )
  if (after !== null) context.after = after

  // Immediate sentences are already present as `before`/`after`. Distance-two
  // windows add the bounded speech behind one intervening sentence (often a
  // brief restart such as "Sorry.") without claiming a semantic match.
  const nearbyAlternateTakes = findNearbyTakeWindows(transcript, candidate)
    .filter((take) => take.sentenceDistance > 1)
    .slice(0, MAX_CONTEXT_ALTERNATE_TAKES)
    .flatMap((take): RetakeAnalysisSourceContext[] => {
      const bounded = boundedText(
        take.text,
        MAX_ALTERNATE_CONTEXT_WORDS,
        MAX_ALTERNATE_CONTEXT_CHARACTERS,
        'head-tail',
      )
      if (bounded === null) return []
      return [
        {
          startSourceMs: take.startSourceMs,
          endSourceMs: take.endSourceMs,
          ...bounded,
        },
      ]
    })
  if (nearbyAlternateTakes.length > 0) {
    context.nearbyAlternateTakes = nearbyAlternateTakes
  }

  return context
}
