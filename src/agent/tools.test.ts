import { describe, it, expect } from 'vitest'
import type { EDL } from '../edl/types'
import type { Word } from '../transcript/types'
import { applyRemovedRange, createEdl } from '../edl/edl'
import {
  cutSegment,
  removeFillerWords,
  removeSilences,
  removeStumbles,
  trimToDuration,
} from './tools'

const SOURCE = { id: 's1', url: 'blob:test', duration: 10 }

/** Reduce segments to [start, end] pairs for concise assertions. */
function ranges(edl: EDL): Array<[number, number]> {
  return edl.segments.map((seg) => [seg.start, seg.end])
}

function timed(...specs: Array<[string, number, number]>): Word[] {
  return specs.map(([text, start, end]) => ({ text, start, end }))
}

function texts(...words: string[]): Word[] {
  return words.map((text, i) => ({ text, start: i, end: i + 1 }))
}

const NO_TRANSCRIPT = { words: [] }

describe('cutSegment', () => {
  it('removes one explicit range and reports it', () => {
    const result = cutSegment(createEdl(SOURCE), NO_TRANSCRIPT, {
      start: 3,
      end: 6,
    })
    expect(ranges(result.edl)).toEqual([
      [0, 3],
      [6, 10],
    ])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(3)
  })

  it('is a no-op for an empty range', () => {
    const result = cutSegment(createEdl(SOURCE), NO_TRANSCRIPT, {
      start: 5,
      end: 5,
    })
    expect(ranges(result.edl)).toEqual([[0, 10]])
    expect(result.removed_count).toBe(0)
    expect(result.removed_seconds).toBeCloseTo(0)
  })
})

describe('removeSilences', () => {
  it('shortens every gap over the threshold, defaulting keep_gap_ms when absent', () => {
    const transcript = { words: timed(['a', 0, 2], ['b', 3, 5], ['c', 5, 8]) }
    const result = removeSilences(createEdl(SOURCE), transcript, {
      threshold_ms: 500,
    })
    // Only the 1s gap [2,3] exceeds the threshold; the default 250ms keep
    // survives split half/half, so the removal is the middle [2.125, 2.875].
    expect(ranges(result.edl)).toEqual([
      [0, 2.125],
      [2.875, 10],
    ])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(0.75)
  })

  it('keep_gap_ms: 0 removes each qualifying gap wholly (old behavior)', () => {
    const transcript = { words: timed(['a', 0, 2], ['b', 3, 5], ['c', 5, 8]) }
    const result = removeSilences(createEdl(SOURCE), transcript, {
      threshold_ms: 500,
      keep_gap_ms: 0,
    })
    expect(ranges(result.edl)).toEqual([
      [0, 2],
      [3, 10],
    ])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(1)
  })

  it('clamps keep_gap_ms to the ceiling', () => {
    // A 5000ms keep clamps to 1000ms; the 2s gap [2,4] is trimmed to the middle
    // [2.5, 3.5], keeping the clamped 1s split half/half.
    const transcript = { words: timed(['a', 0, 2], ['b', 4, 5]) }
    const result = removeSilences(createEdl(SOURCE), transcript, {
      threshold_ms: 500,
      keep_gap_ms: 5000,
    })
    expect(ranges(result.edl)).toEqual([
      [0, 2.5],
      [3.5, 10],
    ])
    expect(result.removed_seconds).toBeCloseTo(1)
  })

  it('clamps a too-small threshold to the floor', () => {
    const transcript = { words: timed(['a', 0, 1], ['b', 1.1, 2]) }
    // A 0ms threshold would cut the 0.1s gap; the 150ms floor prevents it.
    const result = removeSilences(createEdl(SOURCE), transcript, {
      threshold_ms: 0,
    })
    expect(ranges(result.edl)).toEqual([[0, 10]])
    expect(result.removed_count).toBe(0)
  })

  it('is a safe no-op when re-run on an already-cut EDL', () => {
    const transcript = { words: timed(['a', 0, 2], ['b', 3, 5]) }
    const once = removeSilences(createEdl(SOURCE), transcript, {
      threshold_ms: 500,
    })
    const twice = removeSilences(once.edl, transcript, { threshold_ms: 500 })
    expect(ranges(twice.edl)).toEqual(ranges(once.edl))
    expect(twice.removed_count).toBe(0)
    expect(twice.removed_seconds).toBeCloseTo(0)
  })
})

describe('removeFillerWords', () => {
  it('removes each default filler occurrence', () => {
    const transcript = { words: texts('I', 'um', 'think', 'uh', 'so') }
    const result = removeFillerWords(createEdl(SOURCE), transcript, {})
    expect(ranges(result.edl)).toEqual([
      [0, 1],
      [2, 3],
      [4, 10],
    ])
    expect(result.removed_count).toBe(2)
    expect(result.removed_seconds).toBeCloseTo(2)
  })

  it('honors a custom word list', () => {
    const transcript = { words: texts('keep', 'cut', 'keep') }
    const result = removeFillerWords(createEdl(SOURCE), transcript, {
      words: ['cut'],
    })
    expect(ranges(result.edl)).toEqual([
      [0, 1],
      [2, 10],
    ])
    expect(result.removed_count).toBe(1)
  })
})

describe('removeStumbles', () => {
  it('funnels detected takes through applyRemovedRange and reports counts', () => {
    // "we we we should": ranges [0,1] and [1,2] merge into one removed [0,2].
    const transcript = { words: texts('we', 'we', 'we', 'should') }
    const result = removeStumbles(createEdl(SOURCE), transcript)
    expect(ranges(result.edl)).toEqual([[2, 10]])
    expect(result.removed_count).toBe(2)
    expect(result.removed_seconds).toBeCloseTo(2)
  })

  it('removes a phrase restart up to the kept take start', () => {
    const transcript = {
      words: texts('the', 'architecture', 'um', 'the', 'architecture'),
    }
    const result = removeStumbles(createEdl(SOURCE), transcript)
    // The abandoned take AND the "um" go; the kept take starts at word 3.
    expect(ranges(result.edl)).toEqual([
      [3, 10],
    ])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(3)
  })

  it('is a no-op on clean speech', () => {
    const transcript = { words: texts('the', 'cat', 'and', 'the', 'dog') }
    const result = removeStumbles(createEdl(SOURCE), transcript)
    expect(ranges(result.edl)).toEqual([[0, 10]])
    expect(result.removed_count).toBe(0)
    expect(result.removed_seconds).toBeCloseTo(0)
  })
})

describe('trimToDuration', () => {
  it('is a no-op when already at or under the target', () => {
    const result = trimToDuration(createEdl(SOURCE), NO_TRANSCRIPT, {
      target_seconds: 20,
    })
    expect(ranges(result.edl)).toEqual([[0, 10]])
    expect(result.removed_count).toBe(0)
    expect(result.removed_seconds).toBeCloseTo(0)
  })

  it('crops the tail of a single segment to the target', () => {
    const result = trimToDuration(createEdl(SOURCE), NO_TRANSCRIPT, {
      target_seconds: 6,
    })
    expect(ranges(result.edl)).toEqual([[0, 6]])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(4)
  })

  it('maps the target through kept gaps (edlTimeToSource) before cropping', () => {
    // Remove [2,4] first -> kept segments [0,2],[4,10], kept duration 8.
    const gapped = applyRemovedRange(createEdl(SOURCE), 2, 4)
    const result = trimToDuration(gapped, NO_TRANSCRIPT, { target_seconds: 5 })
    // EDL-time 5 maps to source 7 (2s in first seg + 3s into the second).
    expect(ranges(result.edl)).toEqual([
      [0, 2],
      [4, 7],
    ])
    expect(result.removed_count).toBe(1)
    expect(result.removed_seconds).toBeCloseTo(3)
  })
})
