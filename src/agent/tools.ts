// The agent's tool executors — pure, React-free, and the client-side half of the
// stateless-relay design: Claude SELECTS a tool and supplies its intent; these
// functions compute the actual ranges and apply them. Every removal funnels
// through the existing `applyRemovedRange`, so the agent can only do what manual
// edits can do, and the numbers it reports are deterministic (computed here, not
// taken from Claude's text).
//
// Each executor takes the working EDL, the transcript, and the tool's input, and
// returns a new EDL plus what it removed. Executors never mutate; the loop in
// `run.ts` threads the returned EDL into the next call and commits once at the end.

import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import {
  applyRemovedRange,
  edlTimeToSource,
  totalKeptDuration,
} from '../edl/edl'
import {
  DEFAULT_FILLER_WORDS,
  DEFAULT_KEEP_GAP_MS,
  findFillerSpans,
  findSilences,
  findStumbleSpans,
  type Range,
} from './detect'

export type ToolResult = {
  edl: EDL
  removed_count: number
  removed_seconds: number
}

// Suggested gap for a vague "remove the silences" when Claude omits a threshold,
// and the floor we clamp any model-supplied threshold to. The clamp is a
// deterministic guardrail (like `applyRemovedRange` clamping to [0, duration]),
// not range logic: it stops a bad value like 0 from cutting every word gap.
export const DEFAULT_SILENCE_MS = 600
export const MIN_SILENCE_MS = 150
// Ceiling for a model-supplied keep_gap_ms (the same guardrail idea as the
// silence floor): keeping over a second of every gap would defeat the tool.
export const MAX_KEEP_GAP_MS = 1000

// Apply a list of candidate ranges by reducing through `applyRemovedRange`, which
// already merges overlaps/adjacency and treats re-removing an already-cut range
// as a no-op. We count a range as "removed" only if it actually shortened the
// kept timeline, so the reported count reflects real edits.
function applyRanges(edl: EDL, ranges: Range[]): ToolResult {
  const before = totalKeptDuration(edl)
  let current = edl
  let removed_count = 0
  for (const range of ranges) {
    const prev = totalKeptDuration(current)
    current = applyRemovedRange(current, range.start, range.end)
    if (totalKeptDuration(current) < prev - 1e-9) {
      removed_count++
    }
  }
  return {
    edl: current,
    removed_count,
    removed_seconds: before - totalKeptDuration(current),
  }
}

/** cut_segment { start, end } — remove one explicit source range. */
export function cutSegment(
  edl: EDL,
  _transcript: Transcript,
  args: { start: number; end: number },
): ToolResult {
  return applyRanges(edl, [{ start: args.start, end: args.end }])
}

/**
 * remove_silences { threshold_ms, keep_gap_ms? } — shorten every inter-word gap
 * over the threshold to `keep_gap_ms` of breathing room (default 250 ms, split
 * half/half at the gap's edges for natural pacing; 0 removes gaps wholly).
 */
export function removeSilences(
  edl: EDL,
  transcript: Transcript,
  args: { threshold_ms: number; keep_gap_ms?: number },
): ToolResult {
  const requested = Number.isFinite(args.threshold_ms)
    ? args.threshold_ms
    : DEFAULT_SILENCE_MS
  const thresholdMs = Math.max(MIN_SILENCE_MS, requested)
  const requestedKeep =
    args.keep_gap_ms !== undefined && Number.isFinite(args.keep_gap_ms)
      ? args.keep_gap_ms
      : DEFAULT_KEEP_GAP_MS
  const keepGapMs = Math.min(MAX_KEEP_GAP_MS, Math.max(0, requestedKeep))
  return applyRanges(edl, findSilences(transcript, thresholdMs, keepGapMs))
}

/** remove_filler_words { words? } — cut each occurrence of a filler word/phrase. */
export function removeFillerWords(
  edl: EDL,
  transcript: Transcript,
  args: { words?: string[] },
): ToolResult {
  const fillers =
    args.words !== undefined && args.words.length > 0
      ? args.words
      : DEFAULT_FILLER_WORDS
  return applyRanges(edl, findFillerSpans(transcript, fillers))
}

/**
 * remove_stumbles {} — cut verbal stumbles (immediate word repeats, partial-word
 * restarts, re-said phrases), keeping the LAST take. Takes no parameters; every
 * detected range already ends at the kept take's first word, so the dead air
 * between takes goes with the abandoned take.
 */
export function removeStumbles(edl: EDL, transcript: Transcript): ToolResult {
  return applyRanges(edl, findStumbleSpans(transcript))
}

/**
 * trim_to_duration { target_seconds } — crop the TAIL until the kept timeline is
 * at most `target_seconds`. No-op if already short enough. Reuses the existing
 * EDL-time -> source-time mapping to find where the target falls in the source,
 * then removes from there to the end. This loses content, so the system prompt
 * tells Claude to prefer the non-destructive cuts first.
 */
export function trimToDuration(
  edl: EDL,
  _transcript: Transcript,
  args: { target_seconds: number },
): ToolResult {
  const before = totalKeptDuration(edl)
  if (before <= args.target_seconds) {
    return { edl, removed_count: 0, removed_seconds: 0 }
  }
  const sourceCut = edlTimeToSource(edl, args.target_seconds)
  const next = applyRemovedRange(edl, sourceCut, edl.source.duration)
  return {
    edl: next,
    removed_count: 1,
    removed_seconds: before - totalKeptDuration(next),
  }
}
