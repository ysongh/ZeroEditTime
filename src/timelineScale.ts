// Pure layout math for the timeline view. Everything is in SOURCE seconds and
// derives one-way from the EDL (or transcript words); nothing here is stored.

import type { EDL } from './edl/types'

export type SourceRange = { start: number; end: number }

export type RulerTick = {
  time: number
  major: boolean
}

// [minor, major] spacings in seconds; each major is a multiple of its minor.
const TICK_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 2],
  [1, 5],
  [2, 10],
  [5, 30],
  [10, 30],
  [15, 60],
  [30, 120],
  [60, 300],
  [120, 600],
  [300, 1_800],
  [600, 3_600],
  [1_800, 7_200],
]

const MAX_MINOR_TICKS = 24

/**
 * Ruler ticks across [0, duration]: roughly 10–24 minor ticks, with labeled
 * majors at round intervals. A non-positive or non-finite duration yields none.
 */
export function rulerTicks(duration: number): RulerTick[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    return []
  }
  const [minor, major] =
    TICK_STEPS.find(([step]) => duration / step <= MAX_MINOR_TICKS) ??
    TICK_STEPS[TICK_STEPS.length - 1]
  // Integer arithmetic on the index avoids floating-point drift for 0.5s steps.
  const majorEvery = Math.round(major / minor)
  const count = Math.floor(duration / minor + 1e-9)
  const ticks: RulerTick[] = []
  for (let i = 0; i <= count; i++) {
    ticks.push({ time: i * minor, major: i % majorEvery === 0 })
  }
  return ticks
}

/** Source ranges NOT kept by the EDL: the gaps before, between, and after segments. */
export function removedRanges(edl: EDL): SourceRange[] {
  const duration = edl.source.duration
  if (!Number.isFinite(duration) || duration <= 0) {
    return []
  }
  const ranges: SourceRange[] = []
  let cursor = 0
  for (const segment of edl.segments) {
    if (segment.start > cursor) {
      ranges.push({ start: cursor, end: segment.start })
    }
    cursor = Math.max(cursor, segment.end)
  }
  if (cursor < duration) {
    ranges.push({ start: cursor, end: duration })
  }
  return ranges
}

/** Boundaries where one kept segment ends exactly where the next begins (a split). */
export function splitPoints(edl: EDL): number[] {
  const points: number[] = []
  for (let i = 1; i < edl.segments.length; i++) {
    if (edl.segments[i].start === edl.segments[i - 1].end) {
      points.push(edl.segments[i].start)
    }
  }
  return points
}

/**
 * Speech activity for `count` equal buckets across the source: the fraction of
 * each bucket covered by transcript words, in [0, 1]. This is derived from word
 * timings, not audio samples, so it shows where speech is rather than loudness.
 */
export function speechActivity(
  words: readonly SourceRange[],
  duration: number,
  count: number,
): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count <= 0) {
    return []
  }
  const coverage = new Array<number>(count).fill(0)
  const bucket = duration / count
  for (const word of words) {
    const start = Math.max(0, word.start)
    const end = Math.min(duration, word.end)
    if (!(end > start)) {
      continue
    }
    const first = Math.min(count - 1, Math.floor(start / bucket))
    const last = Math.min(count - 1, Math.floor(end / bucket))
    for (let i = first; i <= last; i++) {
      const overlap =
        Math.min(end, (i + 1) * bucket) - Math.max(start, i * bucket)
      if (overlap > 0) {
        coverage[i] += overlap / bucket
      }
    }
  }
  return coverage.map((value) => Math.min(1, value))
}
