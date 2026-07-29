// Pure overlay timing projection — no React, DOM, assets, or ffmpeg.
// Overlay ranges are authored in source milliseconds and projected onto the
// concatenated output timeline after source ranges have been removed.

export interface SourceRange {
  startMs: number
  endMs: number
}

export type RemovedRange = SourceRange

export interface ProjectedSourceSegment {
  sourceStartMs: number
  sourceEndMs: number
  outputStartMs: number
  outputEndMs: number
}

/**
 * Normalize source removals into sorted, disjoint half-open ranges.
 *
 * This is the range-list equivalent of repeatedly applying the EDL's
 * `applyRemovedRange`: overlapping, nested, duplicate, and adjacent removals
 * collapse to their union. Source time starts at zero, so negative bounds are
 * clamped; invalid and non-finite ranges are ignored.
 */
export function normalizeRemovedRanges(
  removedRanges: readonly RemovedRange[],
): RemovedRange[] {
  const sorted = removedRanges
    .filter(
      (range) =>
        Number.isFinite(range.startMs) &&
        Number.isFinite(range.endMs) &&
        range.endMs > range.startMs &&
        range.endMs > 0,
    )
    .map((range) => ({
      startMs: Math.max(0, range.startMs),
      endMs: range.endMs,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const normalized: RemovedRange[] = []
  for (const range of sorted) {
    const previous = normalized.at(-1)
    if (previous && range.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, range.endMs)
    } else {
      normalized.push({ ...range })
    }
  }
  return normalized
}

/**
 * Project a half-open source range [startMs, endMs) through removed source
 * ranges. Each result describes one surviving source piece and its position
 * on the concatenated output timeline.
 */
export function projectSourceRangeToOutputSegments(
  range: SourceRange,
  removedRanges: readonly RemovedRange[],
): ProjectedSourceSegment[] {
  if (
    !Number.isFinite(range.startMs) ||
    !Number.isFinite(range.endMs) ||
    range.endMs <= range.startMs ||
    range.endMs <= 0
  ) {
    return []
  }

  const startMs = Math.max(0, range.startMs)
  const endMs = range.endMs
  if (startMs >= endMs) {
    return []
  }

  const normalized = normalizeRemovedRanges(removedRanges)
  const projected: ProjectedSourceSegment[] = []
  let cursor = startMs
  let removedBeforeCursor = 0

  for (const removed of normalized) {
    if (removed.endMs <= cursor) {
      removedBeforeCursor += removed.endMs - removed.startMs
      continue
    }
    if (removed.startMs >= endMs) {
      break
    }

    const keptEnd = Math.min(removed.startMs, endMs)
    if (keptEnd > cursor) {
      const outputStartMs = cursor - removedBeforeCursor
      projected.push({
        sourceStartMs: cursor,
        sourceEndMs: keptEnd,
        outputStartMs,
        outputEndMs: outputStartMs + (keptEnd - cursor),
      })
    }

    const removedStart = Math.max(cursor, removed.startMs)
    const removedEnd = Math.min(endMs, removed.endMs)
    removedBeforeCursor +=
      Math.max(0, removedStart - removed.startMs) +
      Math.max(0, removedEnd - removedStart)
    cursor = Math.max(cursor, removedEnd)
  }

  if (cursor < endMs) {
    const outputStartMs = cursor - removedBeforeCursor
    projected.push({
      sourceStartMs: cursor,
      sourceEndMs: endMs,
      outputStartMs,
      outputEndMs: outputStartMs + (endMs - cursor),
    })
  }

  return projected
}
