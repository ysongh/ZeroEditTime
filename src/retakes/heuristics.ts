// Pure Phase-11 candidate heuristics. Existing transcript detectors produce
// objective source-time signals; this layer applies conservative thresholds
// before any candidate could be sent to an AI analyzer.

import {
  findFillerSpans,
  findSilences,
  findStumbleSpans,
} from '../agent/detect'
import type { Transcript } from '../transcript/types'
import {
  buildRetakeCandidates,
  type RetakeCandidate,
} from './candidates'

/** A single filler or two conversational fillers remain ordinary editing. */
export const MIN_EXCESSIVE_FILLER_COUNT = 3

/** Count uses Part B's filler-occurrences-per-sentence-word definition. */
export const MIN_EXCESSIVE_FILLER_DENSITY = 0.3

/** A pause must be strictly longer than this to be a retake signal. */
export const LONG_HESITATION_THRESHOLD_MS = 2_000

/** Avoid treating a long gap in a tiny conversational fragment as meaningful. */
export const MIN_LONG_HESITATION_WORD_COUNT = 5

/** One cuttable repeat/restart is handled by ordinary stumble removal. */
export const MIN_SEVERE_STUMBLE_COUNT = 2

function wordCountForCandidate(
  transcript: Transcript,
  candidate: RetakeCandidate,
): number {
  return transcript.words.filter((word) => {
    if (
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end <= word.start
    ) {
      return false
    }
    const wordStartMs = word.start * 1_000
    const wordEndMs = word.end * 1_000
    return (
      wordStartMs >= candidate.startSourceMs &&
      wordEndMs <= candidate.endSourceMs
    )
  }).length
}

function hasStrongTrigger(
  transcript: Transcript,
  candidate: RetakeCandidate,
): boolean {
  const { signals } = candidate
  const excessiveFillers =
    signals.fillerCount >= MIN_EXCESSIVE_FILLER_COUNT &&
    signals.fillerDensity >= MIN_EXCESSIVE_FILLER_DENSITY
  const longHesitation =
    signals.longPauseCount > 0 &&
    wordCountForCandidate(transcript, candidate) >=
      MIN_LONG_HESITATION_WORD_COUNT
  const severeStumble =
    signals.stumbleCount >= MIN_SEVERE_STUMBLE_COUNT

  return excessiveFillers || longHesitation || severeStumble
}

/**
 * Detect conservative, local transcript candidates without browser or AI work.
 *
 * Filler, pause, and stumble detectors run once over the transcript. Part B
 * then buckets all signals by sentence, after which this function retains only
 * candidates with at least one strong trigger. Building before filtering keeps
 * weaker co-occurring signals as useful evidence without allowing unrelated
 * weak imperfections to add into an undocumented score.
 *
 * `keepGapMs = 0` is intentional: Part B needs the full pause duration for
 * evidence. This does not edit media or change the natural-pacing removal tool.
 */
export function buildHeuristicRetakeCandidates(
  transcript: Transcript,
): RetakeCandidate[] {
  const candidates = buildRetakeCandidates(transcript, {
    fillerSpans: findFillerSpans(transcript),
    longPauseSpans: findSilences(
      transcript,
      LONG_HESITATION_THRESHOLD_MS,
      0,
    ),
    stumbleSpans: findStumbleSpans(transcript),
  })

  return candidates.filter((candidate) =>
    hasStrongTrigger(transcript, candidate),
  )
}
