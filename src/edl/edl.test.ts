import { describe, it, expect } from 'vitest'
import type { EDL } from './types'
import {
  applyRemovedRange,
  createEdl,
  edlTimeToSource,
  isSourceTimeKept,
  nextSourceTime,
  sourceTimeToEdlTime,
  splitSegmentAt,
  totalKeptDuration,
} from './edl'

const SOURCE = { id: 's1', url: 'blob:test', duration: 10 }

/** Reduce segments to plain [start, end] pairs for concise assertions. */
function ranges(edl: EDL): Array<[number, number]> {
  return edl.segments.map((seg) => [seg.start, seg.end])
}

describe('createEdl', () => {
  it('initializes to a single full-length segment', () => {
    const edl = createEdl(SOURCE)
    expect(ranges(edl)).toEqual([[0, 10]])
    expect(edl.version).toBe(1)
    expect(edl.captions).toEqual([])
  })

  it('produces no segments for a zero-duration source', () => {
    expect(createEdl({ id: 's', url: 'blob:x', duration: 0 }).segments).toEqual([])
  })
})

describe('applyRemovedRange', () => {
  it('splits a segment when removing an interior range', () => {
    const edl = applyRemovedRange(createEdl(SOURCE), 3, 6)
    expect(ranges(edl)).toEqual([
      [0, 3],
      [6, 10],
    ])
  })

  it('trims the head when removing from the start', () => {
    expect(ranges(applyRemovedRange(createEdl(SOURCE), 0, 4))).toEqual([[4, 10]])
  })

  it('trims the tail when removing to the end', () => {
    expect(ranges(applyRemovedRange(createEdl(SOURCE), 7, 10))).toEqual([[0, 7]])
  })

  it('drops a segment fully covered by the removed range', () => {
    // Start with two segments, then fully cover the first one.
    const split = applyRemovedRange(createEdl(SOURCE), 4, 6) // -> [0,4],[6,10]
    expect(ranges(applyRemovedRange(split, 0, 4))).toEqual([[6, 10]])
  })

  it('drops a segment that a removal reduces to zero length', () => {
    // Removing [0,10] covers everything.
    expect(applyRemovedRange(createEdl(SOURCE), 0, 10).segments).toEqual([])
  })

  it('merges overlapping removed ranges', () => {
    const a = applyRemovedRange(createEdl(SOURCE), 3, 6)
    const b = applyRemovedRange(a, 5, 8)
    // union of [3,6] and [5,8] is [3,8]
    expect(ranges(b)).toEqual([
      [0, 3],
      [8, 10],
    ])
  })

  it('merges adjacent removed ranges', () => {
    const a = applyRemovedRange(createEdl(SOURCE), 3, 5)
    const b = applyRemovedRange(a, 5, 7)
    // union of [3,5] and [5,7] is [3,7]
    expect(ranges(b)).toEqual([
      [0, 3],
      [7, 10],
    ])
  })

  it('clamps out-of-bounds ranges to [0, duration]', () => {
    expect(ranges(applyRemovedRange(createEdl(SOURCE), -5, 4))).toEqual([[4, 10]])
    expect(ranges(applyRemovedRange(createEdl(SOURCE), 6, 999))).toEqual([[0, 6]])
    expect(ranges(applyRemovedRange(createEdl(SOURCE), -100, 100))).toEqual([])
  })

  it('is a no-op when start >= end', () => {
    const edl = createEdl(SOURCE)
    expect(applyRemovedRange(edl, 5, 5)).toBe(edl)
    expect(applyRemovedRange(edl, 6, 2)).toBe(edl)
  })

  it('is a no-op when the range clamps to nothing (fully out of bounds)', () => {
    const edl = createEdl(SOURCE)
    expect(applyRemovedRange(edl, 20, 30)).toBe(edl)
  })

  it('does not mutate its input', () => {
    const edl = createEdl(SOURCE)
    const before = structuredClone(edl)
    applyRemovedRange(edl, 3, 6)
    expect(edl).toEqual(before)
    expect(edl.segments).toEqual(before.segments)
  })

  it('expresses trim-to-in/out as two removals', () => {
    const trimmed = applyRemovedRange(applyRemovedRange(createEdl(SOURCE), 0, 2), 8, 10)
    expect(ranges(trimmed)).toEqual([[2, 8]])
  })

  it('produces >= 2 non-contiguous segments from a middle delete', () => {
    const edl = applyRemovedRange(createEdl(SOURCE), 4, 6)
    expect(edl.segments.length).toBeGreaterThanOrEqual(2)
    // there is a real gap between them
    expect(edl.segments[0].end).toBeLessThan(edl.segments[1].start)
  })
})

describe('splitSegmentAt', () => {
  it('splits the containing segment into two adjacent segments', () => {
    const edl = splitSegmentAt(createEdl(SOURCE), 4)
    expect(ranges(edl)).toEqual([
      [0, 4],
      [4, 10],
    ])
  })

  it('is a no-op on a boundary or inside a gap', () => {
    const withGap = applyRemovedRange(createEdl(SOURCE), 3, 6) // [0,3],[6,10]
    expect(splitSegmentAt(withGap, 3)).toBe(withGap) // boundary
    expect(splitSegmentAt(withGap, 4.5)).toBe(withGap) // inside the gap
  })

  it('does not mutate its input', () => {
    const edl = createEdl(SOURCE)
    const before = structuredClone(edl)
    splitSegmentAt(edl, 4)
    expect(edl).toEqual(before)
  })
})

describe('time mapping', () => {
  // [0,3] then [6,10]: kept timeline is 7s long.
  const edl = applyRemovedRange(createEdl(SOURCE), 3, 6)

  it('reports total kept duration', () => {
    expect(totalKeptDuration(edl)).toBe(7)
  })

  it('maps EDL-time to source time across the gap', () => {
    expect(edlTimeToSource(edl, 0)).toBe(0)
    expect(edlTimeToSource(edl, 2)).toBe(2)
    expect(edlTimeToSource(edl, 3)).toBe(3) // boundary stays in the first segment
    expect(edlTimeToSource(edl, 4)).toBe(7) // 1s into the second segment
    expect(edlTimeToSource(edl, 7)).toBe(10)
    expect(edlTimeToSource(edl, 99)).toBe(10) // clamped to the end
  })

  it('maps source time back to EDL-time, collapsing gaps', () => {
    expect(sourceTimeToEdlTime(edl, 2)).toBe(2)
    expect(sourceTimeToEdlTime(edl, 4.5)).toBe(3) // inside the gap -> boundary
    expect(sourceTimeToEdlTime(edl, 7)).toBe(4)
    expect(sourceTimeToEdlTime(edl, 10)).toBe(7)
  })
})

describe('isSourceTimeKept', () => {
  // [0,3] then [6,10]: [3,6) is a removed gap.
  const edl = applyRemovedRange(createEdl(SOURCE), 3, 6)

  it('is true for a time inside a kept segment', () => {
    expect(isSourceTimeKept(edl, 1)).toBe(true)
    expect(isSourceTimeKept(edl, 8)).toBe(true)
  })

  it('is false for a time inside a removed gap', () => {
    expect(isSourceTimeKept(edl, 4.5)).toBe(false)
  })

  it('treats segments as half-open [start, end)', () => {
    expect(isSourceTimeKept(edl, 0)).toBe(true) // segment start is kept
    expect(isSourceTimeKept(edl, 3)).toBe(false) // removed boundary is not kept
    expect(isSourceTimeKept(edl, 6)).toBe(true) // start of the next segment
    expect(isSourceTimeKept(edl, 10)).toBe(false) // past the last segment end
  })

  it('derives word kept-ness from the midpoint of its span', () => {
    // A word's kept-ness is decided by its midpoint, not by whether its span
    // overlaps a cut boundary.
    const mid = (start: number, end: number) => (start + end) / 2
    expect(isSourceTimeKept(edl, mid(1, 2))).toBe(true) // wholly in [0,3) -> kept
    expect(isSourceTimeKept(edl, mid(4, 5))).toBe(false) // wholly in the gap -> struck
    expect(isSourceTimeKept(edl, mid(2.8, 3.4))).toBe(false) // straddles cut, midpoint 3.1 in gap
    expect(isSourceTimeKept(edl, mid(5.6, 6.4))).toBe(true) // straddles cut, midpoint 6.0 kept
  })

  it('is false for every time when the EDL has no segments', () => {
    expect(isSourceTimeKept(applyRemovedRange(edl, 0, 10), 5)).toBe(false)
  })
})

describe('nextSourceTime', () => {
  const edl = applyRemovedRange(createEdl(SOURCE), 3, 6) // [0,3],[6,10]

  it('keeps playing inside a kept segment', () => {
    expect(nextSourceTime(edl, 1)).toBe(1)
  })

  it('skips forward to the next segment when inside a gap', () => {
    expect(nextSourceTime(edl, 3)).toBe(6) // reached the end of [0,3]
    expect(nextSourceTime(edl, 4.5)).toBe(6)
  })

  it('returns null past the last kept segment', () => {
    expect(nextSourceTime(edl, 10)).toBeNull()
  })
})
