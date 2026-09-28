import { describe, expect, it } from 'vitest'
import type { EDL } from './edl/types'
import {
  removedRanges,
  rulerTicks,
  speechActivity,
  splitPoints,
} from './timelineScale'

function edlWith(duration: number, segments: Array<[number, number]>): EDL {
  return {
    version: 1,
    source: { id: 'source', url: 'blob:source', duration },
    segments: segments.map(([start, end]) => ({ id: `seg_${start}_${end}`, start, end })),
    captions: [],
  }
}

describe('rulerTicks', () => {
  it('uses 10s minor and 30s major ticks for a three-minute source', () => {
    const ticks = rulerTicks(188.81)
    expect(ticks).toHaveLength(19)
    expect(ticks.slice(0, 4)).toEqual([
      { time: 0, major: true },
      { time: 10, major: false },
      { time: 20, major: false },
      { time: 30, major: true },
    ])
    expect(ticks.at(-1)).toEqual({ time: 180, major: true })
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.time))
      .toEqual([0, 30, 60, 90, 120, 150, 180])
  })

  it('keeps at most 24 minor ticks and exact half-second steps', () => {
    for (const duration of [3, 10, 47, 600, 5_400, 20_000]) {
      expect(rulerTicks(duration).length).toBeLessThanOrEqual(25)
    }
    expect(rulerTicks(3).map((tick) => tick.time)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
  })

  it('returns nothing for an empty or invalid duration', () => {
    expect(rulerTicks(0)).toEqual([])
    expect(rulerTicks(Number.NaN)).toEqual([])
  })
})

describe('removedRanges and splitPoints', () => {
  it('derives the head, middle, and tail gaps from the kept segments', () => {
    const edl = edlWith(10, [[1, 3], [3, 5], [7, 9]])
    expect(removedRanges(edl)).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 7 },
      { start: 9, end: 10 },
    ])
    expect(splitPoints(edl)).toEqual([3])
  })

  it('reports no gaps for an untouched source and everything for an empty edit', () => {
    expect(removedRanges(edlWith(10, [[0, 10]]))).toEqual([])
    expect(removedRanges(edlWith(10, []))).toEqual([{ start: 0, end: 10 }])
  })
})

describe('speechActivity', () => {
  it('reports the covered fraction of each bucket', () => {
    expect(
      speechActivity(
        [
          { start: 0, end: 1 },
          { start: 2.5, end: 3.5 },
        ],
        4,
        4,
      ),
    ).toEqual([1, 0, 0.5, 0.5])
  })

  it('clamps words to the source and caps overlapping words at 1', () => {
    expect(
      speechActivity(
        [
          { start: -1, end: 1 },
          { start: 0.5, end: 1 },
          { start: 1.5, end: 9 },
        ],
        2,
        2,
      ),
    ).toEqual([1, 0.5])
    expect(speechActivity([], 0, 10)).toEqual([])
  })
})
