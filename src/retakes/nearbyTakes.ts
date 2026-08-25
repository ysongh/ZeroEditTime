// Pure Phase-11 nearby-clean-take suppression. This is intentionally a
// high-precision local filter: obvious alternate takes stay out of later AI
// analysis, while semantic paraphrases and uncertain fragments remain for the
// model to judge with context.

import {
  findFillerSpans,
  findSilences,
  findStumbleSpans,
  MAX_NGRAM,
  MAX_RETAKE_GAP_S,
  MIN_PREFIX_LEN,
  normalizeSpeechToken,
  type Range,
} from '../agent/detect'
import { endsSentence, groupSentences } from '../transcript/sentences'
import type { Transcript, Word } from '../transcript/types'
import type { RetakeCandidate } from './candidates'
import {
  buildHeuristicRetakeCandidates,
  LONG_HESITATION_THRESHOLD_MS,
} from './heuristics'

/** Keep local alternate-take discovery aligned with the existing restart rule. */
export const MAX_NEARBY_TAKE_GAP_MS = MAX_RETAKE_GAP_S * 1_000

/** Allows one tiny interjection sentence (for example, "Sorry.") in between. */
export const MAX_NEARBY_SENTENCE_DISTANCE = 2

/** Shorter phrases are too generic to prove that two takes express one thought. */
export const MIN_RELATED_OPENING_WORD_COUNT = 4

/** A clean take must contain enough non-filler speech to stand on its own. */
export const MIN_CLEAN_TAKE_WORD_COUNT = 4

/** One filler is ordinary cleanup; more than one is not an obvious clean take. */
export const MAX_CLEAN_TAKE_FILLER_COUNT = 1

/** A detector-linked restart must repeat this much of the take to prove repairability. */
export const MIN_REPAIRABLE_RESTART_WORD_COUNT = 4

export interface NearbyCleanTake {
  /** Half-open range in original-source milliseconds. */
  startSourceMs: number
  endSourceMs: number
  text: string
}

interface SentenceView extends NearbyCleanTake {
  sentenceIndex: number
  words: Word[]
}

interface RankedCleanTake {
  take: NearbyCleanTake
  gapMs: number
  sentenceDistance: number
}

function isValidWord(word: Word): boolean {
  return (
    Number.isFinite(word.start) &&
    Number.isFinite(word.end) &&
    word.start >= 0 &&
    word.end > word.start
  )
}

function textForWords(words: readonly Word[]): string {
  return words
    .map((word) => word.text.trim())
    .filter((text) => text !== '')
    .join(' ')
}

function buildSentenceViews(transcript: Transcript): SentenceView[] {
  return groupSentences(transcript.words).flatMap(
    (sentence, sentenceIndex): SentenceView[] => {
      const words = transcript.words.slice(
        sentence.startIndex,
        sentence.endIndex + 1,
      )
      if (words.length === 0 || words.some((word) => !isValidWord(word))) {
        return []
      }

      const text = textForWords(words)
      const startSourceMs = Math.min(...words.map((word) => word.start)) * 1_000
      const endSourceMs = Math.max(...words.map((word) => word.end)) * 1_000
      if (text === '' || endSourceMs <= startSourceMs) return []

      return [
        {
          sentenceIndex,
          words,
          text,
          startSourceMs,
          endSourceMs,
        },
      ]
    },
  )
}

function overlapsSourceMs(range: Range, candidate: RetakeCandidate): boolean {
  return (
    range.start * 1_000 < candidate.endSourceMs &&
    range.end * 1_000 > candidate.startSourceMs
  )
}

function containsWord(range: Range, word: Word): boolean {
  const midpoint = (word.start + word.end) / 2
  return midpoint >= range.start && midpoint < range.end
}

function wordsInsideCandidate(
  transcript: Transcript,
  candidate: RetakeCandidate,
): Word[] {
  return transcript.words.filter(
    (word) =>
      isValidWord(word) &&
      word.start * 1_000 >= candidate.startSourceMs &&
      word.end * 1_000 <= candidate.endSourceMs,
  )
}

function wordsOutsideRanges(
  words: readonly Word[],
  ranges: readonly Range[],
): Word[] {
  return words.filter(
    (word) => !ranges.some((range) => containsWord(range, word)),
  )
}

function nonFillerWords(words: readonly Word[]): Word[] {
  const fillerSpans = findFillerSpans({ words: [...words] })
  return wordsOutsideRanges(words, fillerSpans)
}

function normalizedTokens(words: readonly Word[]): string[] {
  return words
    .map((word) => normalizeSpeechToken(word.text))
    .filter((token) => token !== '')
}

function clearlyTerminates(words: readonly Word[]): boolean {
  const finalText = words.at(-1)?.text.trim() ?? ''
  if (!endsSentence(finalText)) return false

  // `endsSentence` intentionally treats an ellipsis as sentence punctuation,
  // but an ellipsis or trailing dash is not proof of a completed spoken take.
  return !/(?:\.{2,}|…|[-–—])(?:["')\]]*)$/u.test(finalText)
}

function isLocallyCleanTake(words: readonly Word[]): boolean {
  if (words.length === 0 || words.some((word) => !isValidWord(word))) {
    return false
  }

  const transcript = { words: [...words] }
  const fillerSpans = findFillerSpans(transcript)
  if (fillerSpans.length > MAX_CLEAN_TAKE_FILLER_COUNT) return false
  const contentWords = wordsOutsideRanges(words, fillerSpans)
  if (
    normalizedTokens(contentWords).length < MIN_CLEAN_TAKE_WORD_COUNT
  ) {
    return false
  }
  // A trailing `um.` cannot donate its punctuation to an otherwise dangling
  // phrase: completion is checked after the ordinary filler cut.
  if (!clearlyTerminates(contentWords)) return false
  if (findStumbleSpans(transcript).length > 0) return false
  if (
    findSilences(transcript, LONG_HESITATION_THRESHOLD_MS, 0).length > 0
  ) {
    return false
  }

  return true
}

function sharedOpeningLength(
  candidateTokens: readonly string[],
  alternateTokens: readonly string[],
): number {
  const limit = Math.min(candidateTokens.length, alternateTokens.length)
  let count = 0
  while (
    count < limit &&
    candidateTokens[count] === alternateTokens[count]
  ) {
    count++
  }
  return count
}

function candidateCoreWords(
  transcript: Transcript,
  candidate: RetakeCandidate,
): Word[] {
  const candidateWords = wordsInsideCandidate(transcript, candidate)
  const localTranscript = { words: candidateWords }
  const removableRanges = [
    ...findFillerSpans(localTranscript),
    ...findStumbleSpans(localTranscript),
  ]
  return wordsOutsideRanges(candidateWords, removableRanges)
}

function isClearlyRelatedTake(
  candidateWords: readonly Word[],
  alternateWords: readonly Word[],
): boolean {
  const candidateTokens = normalizedTokens(candidateWords)
  const alternateTokens = normalizedTokens(nonFillerWords(alternateWords))
  const openingLength = sharedOpeningLength(candidateTokens, alternateTokens)
  if (openingLength < MIN_RELATED_OPENING_WORD_COUNT) return false

  // Hard suppression needs the same full wording after ordinary filler/stumble
  // cleanup. Shared boilerplate, fuzzy word prefixes, extensions, and
  // paraphrases remain available to the later model through normal context.
  return (
    alternateTokens.length === candidateTokens.length &&
    openingLength === candidateTokens.length
  )
}

function sourceGapMs(
  candidate: RetakeCandidate,
  sentence: SentenceView,
): number | null {
  if (sentence.endSourceMs <= candidate.startSourceMs) {
    return candidate.startSourceMs - sentence.endSourceMs
  }
  if (sentence.startSourceMs >= candidate.endSourceMs) {
    return sentence.startSourceMs - candidate.endSourceMs
  }
  return null
}

function nearbyTakeValue(sentence: SentenceView): NearbyCleanTake {
  return {
    startSourceMs: sentence.startSourceMs,
    endSourceMs: sentence.endSourceMs,
    text: sentence.text,
  }
}

/**
 * Find high-confidence clean versions of a candidate in nearby sentences.
 * Results are nearest-first, then earlier-first for a stable tie-break. Source
 * text and ranges are preserved for Part E context construction.
 */
export function findNearbyCleanTakes(
  transcript: Transcript,
  candidate: RetakeCandidate,
): NearbyCleanTake[] {
  const sentences = buildSentenceViews(transcript)
  const candidateSentence = sentences.find(
    (sentence) =>
      sentence.startSourceMs === candidate.startSourceMs &&
      sentence.endSourceMs === candidate.endSourceMs,
  )
  if (candidateSentence === undefined) return []

  const coreWords = candidateCoreWords(transcript, candidate)
  if (normalizedTokens(coreWords).length < MIN_RELATED_OPENING_WORD_COUNT) {
    return []
  }

  const matches: RankedCleanTake[] = []
  for (const sentence of sentences) {
    const sentenceDistance = Math.abs(
      sentence.sentenceIndex - candidateSentence.sentenceIndex,
    )
    if (
      sentenceDistance === 0 ||
      sentenceDistance > MAX_NEARBY_SENTENCE_DISTANCE
    ) {
      continue
    }

    const gapMs = sourceGapMs(candidate, sentence)
    if (
      gapMs === null ||
      gapMs > MAX_NEARBY_TAKE_GAP_MS ||
      !isLocallyCleanTake(sentence.words) ||
      !isClearlyRelatedTake(coreWords, sentence.words)
    ) {
      continue
    }

    matches.push({
      take: nearbyTakeValue(sentence),
      gapMs,
      sentenceDistance,
    })
  }

  return matches
    .sort(
      (left, right) =>
        left.gapMs - right.gapMs ||
        left.sentenceDistance - right.sentenceDistance ||
        left.take.startSourceMs - right.take.startSourceMs ||
        left.take.endSourceMs - right.take.endSourceMs,
    )
    .map(({ take }) => ({ ...take }))
}

/** Return the single nearest obvious external clean take, when one exists. */
export function findNearbyCleanTake(
  transcript: Transcript,
  candidate: RetakeCandidate,
): NearbyCleanTake | null {
  return findNearbyCleanTakes(transcript, candidate)[0] ?? null
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start,
    )
    .map((range) => ({ ...range }))
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const merged: Range[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous === undefined || range.start > previous.end) {
      merged.push(range)
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

function removedDurationBefore(time: number, ranges: readonly Range[]): number {
  return ranges.reduce(
    (duration, range) =>
      duration + Math.max(0, Math.min(time, range.end) - range.start),
    0,
  )
}

function projectAfterCuts(words: readonly Word[], ranges: readonly Range[]): Word[] {
  return wordsOutsideRanges(words, ranges).map((word) => ({
    text: word.text,
    start: word.start - removedDurationBefore(word.start, ranges),
    end: word.end - removedDurationBefore(word.end, ranges),
  }))
}

function restartMatchLength(words: readonly Word[], range: Range): number {
  const abandonedStart = words.findIndex(
    (word) => Math.abs(word.start - range.start) < 1e-9,
  )
  const keptStart = words.findIndex(
    (word) => Math.abs(word.start - range.end) < 1e-9,
  )
  if (abandonedStart < 0 || keptStart <= abandonedStart) return 0

  const limit = Math.min(
    MAX_NGRAM,
    keptStart - abandonedStart,
    words.length - keptStart,
  )
  for (let length = limit; length >= 1; length--) {
    let matches = true
    for (let offset = 0; offset < length; offset++) {
      const abandoned = normalizeSpeechToken(
        words[abandonedStart + offset].text,
      )
      const kept = normalizeSpeechToken(words[keptStart + offset].text)
      const isFinalToken = offset === length - 1
      if (
        abandoned === '' ||
        kept === '' ||
        (abandoned !== kept &&
          !(
            isFinalToken &&
            abandoned.length >= MIN_PREFIX_LEN &&
            kept.startsWith(abandoned)
          ))
      ) {
        matches = false
        break
      }
    }
    if (matches) return length
  }
  return 0
}

/**
 * Whether the existing stumble cuts already leave a complete, locally clean
 * final take inside this candidate. Projecting timestamps closes removed gaps,
 * matching the result the non-destructive edit would produce.
 */
export function isRepairableByStumbleRemoval(
  transcript: Transcript,
  candidate: RetakeCandidate,
): boolean {
  const candidateWords = wordsInsideCandidate(transcript, candidate)
  const detectedSpans = findStumbleSpans({ words: candidateWords }).filter(
    (range) => overlapsSourceMs(range, candidate),
  )
  if (detectedSpans.length === 0) return false

  // Isolated word/phrase repeats can occur throughout an otherwise incomplete
  // sentence. Only an opening-anchored chain of substantial restarted takes is
  // proof that the detector preserved a complete final version.
  const firstWord = candidateWords[0]
  const formsOpeningRestartChain =
    firstWord !== undefined &&
    Math.abs(detectedSpans[0].start - firstWord.start) < 1e-9 &&
    detectedSpans.every(
      (range) =>
        restartMatchLength(candidateWords, range) >=
        MIN_REPAIRABLE_RESTART_WORD_COUNT,
    ) &&
    detectedSpans.every(
      (range, index) =>
        index === 0 ||
        Math.abs(detectedSpans[index - 1].end - range.start) < 1e-9,
    )
  if (!formsOpeningRestartChain) return false

  const stumbleSpans = mergeRanges(detectedSpans)

  return isLocallyCleanTake(projectAfterCuts(candidateWords, stumbleSpans))
}

/** Suppress only candidates whose clean result is already locally obvious. */
export function suppressCandidatesWithNearbyCleanTakes(
  transcript: Transcript,
  candidates: readonly RetakeCandidate[],
): RetakeCandidate[] {
  return candidates.filter(
    (candidate) =>
      !isRepairableByStumbleRemoval(transcript, candidate) &&
      findNearbyCleanTake(transcript, candidate) === null,
  )
}

/** Part C candidate generation composed with the Part D suppression pass. */
export function buildScreenedRetakeCandidates(
  transcript: Transcript,
): RetakeCandidate[] {
  return suppressCandidatesWithNearbyCleanTakes(
    transcript,
    buildHeuristicRetakeCandidates(transcript),
  )
}
