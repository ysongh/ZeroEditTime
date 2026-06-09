// Pure EDL math — no React, no DOM, no side effects. This module is the heart
// of the project: trimming, cutting, and (later) transcript-deletes all funnel
// through `applyRemovedRange`. Every function returns a new value and never
// mutates its input.

import type { EDL, Segment } from './types'

/**
 * Build a deterministic id from a segment's bounds. Segments are always disjoint
 * and ordered, so `start` is unique within an EDL — good enough for a React key
 * and stable across pure recomputation (no counters, no randomness).
 */
function makeSegment(start: number, end: number): Segment {
  return { id: `seg_${start}_${end}`, start, end }
}

/** Initialize an EDL from a loaded source as a single full-length segment. */
export function createEdl(source: EDL['source']): EDL {
  const duration = Math.max(0, source.duration)
  return {
    version: 1,
    source,
    segments: duration > 0 ? [makeSegment(0, duration)] : [],
    captions: [],
  }
}

/**
 * Subtract the source range [start, end] from the current segments, returning a
 * new EDL with new segments. This is the one removal primitive:
 *
 * - Removing a range inside a segment splits it into two.
 * - Trimming the head/tail shrinks a segment.
 * - A fully-covered (or zero-length) segment is dropped.
 * - Because we always subtract from the already-computed segment set, repeated
 *   overlapping or adjacent removals merge naturally.
 *
 * The range is clamped to [0, duration]. `start >= end` (including ranges that
 * clamp to nothing) is a no-op and returns the input EDL unchanged.
 */
export function applyRemovedRange(edl: EDL, start: number, end: number): EDL {
  const duration = edl.source.duration
  const lo = Math.max(0, Math.min(start, duration))
  const hi = Math.max(0, Math.min(end, duration))

  if (lo >= hi) {
    return edl
  }

  const segments: Segment[] = []
  for (const seg of edl.segments) {
    // Keep the part of the segment before the removed range.
    if (seg.start < lo) {
      const headEnd = Math.min(seg.end, lo)
      if (headEnd > seg.start) {
        segments.push(makeSegment(seg.start, headEnd))
      }
    }
    // Keep the part of the segment after the removed range.
    if (seg.end > hi) {
      const tailStart = Math.max(seg.start, hi)
      if (seg.end > tailStart) {
        segments.push(makeSegment(tailStart, seg.end))
      }
    }
    // A segment fully covered by [lo, hi] pushes nothing and is dropped.
  }

  return { ...edl, segments }
}

/**
 * Split the segment that strictly contains `t` into two adjacent segments. This
 * is the one structural operation (a boundary insert, not a removal): the two
 * halves play identically but become independently selectable/deletable.
 *
 * A `t` on a segment boundary or inside a removed gap is a no-op.
 */
export function splitSegmentAt(edl: EDL, t: number): EDL {
  let didSplit = false
  const segments: Segment[] = []
  for (const seg of edl.segments) {
    if (!didSplit && t > seg.start && t < seg.end) {
      segments.push(makeSegment(seg.start, t))
      segments.push(makeSegment(t, seg.end))
      didSplit = true
    } else {
      segments.push(seg)
    }
  }

  if (!didSplit) {
    return edl
  }

  return { ...edl, segments }
}

/** Total duration of all kept segments (the length of the concatenated timeline). */
export function totalKeptDuration(edl: EDL): number {
  return edl.segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0)
}

/**
 * Is the source time `t` inside a kept segment? This is the derived-truth
 * predicate for "is this still in the edit": a transcript word is struck through
 * iff its MIDPOINT is not kept, so a word that merely straddles a cut boundary is
 * not ambiguously struck. Nothing stores per-word deleted state — kept-ness is
 * recomputed from the EDL every render.
 *
 * Segments are half-open [start, end): a time exactly on a removed boundary reads
 * as not kept, matching how playback and the active-word highlight treat `end`.
 */
export function isSourceTimeKept(edl: EDL, t: number): boolean {
  return edl.segments.some((seg) => t >= seg.start && t < seg.end)
}

/**
 * Map a position on the concatenated kept timeline (EDL-time) to a source time.
 * EDL-time is clamped to [0, totalKeptDuration]. Returns 0 for an empty EDL.
 */
export function edlTimeToSource(edl: EDL, edlTime: number): number {
  const clamped = Math.max(0, edlTime)
  let acc = 0
  for (const seg of edl.segments) {
    const len = seg.end - seg.start
    if (clamped <= acc + len) {
      return seg.start + (clamped - acc)
    }
    acc += len
  }
  const last = edl.segments.at(-1)
  return last ? last.end : 0
}

/**
 * Map a source time to its position on the concatenated kept timeline (EDL-time).
 * A source time inside a removed gap maps to the boundary between the kept
 * segments around it (the kept duration up to that point).
 */
export function sourceTimeToEdlTime(edl: EDL, sourceTime: number): number {
  let acc = 0
  for (const seg of edl.segments) {
    if (sourceTime < seg.start) {
      return acc
    }
    if (sourceTime <= seg.end) {
      return acc + (sourceTime - seg.start)
    }
    acc += seg.end - seg.start
  }
  return acc
}

/**
 * Given a current source time during playback, return the next source time the
 * video should be at to stay within kept ranges:
 *
 * - inside a kept segment -> the same time (keep playing),
 * - inside a gap before a later segment -> that segment's start (skip forward),
 * - past the last kept segment -> null (playback should stop).
 *
 * `epsilon` absorbs `timeupdate`'s coarse granularity so we don't stall exactly
 * on a segment boundary.
 */
export function nextSourceTime(
  edl: EDL,
  sourceTime: number,
  epsilon = 0.04,
): number | null {
  for (const seg of edl.segments) {
    if (sourceTime < seg.end - epsilon) {
      return sourceTime < seg.start ? seg.start : sourceTime
    }
  }
  return null
}
