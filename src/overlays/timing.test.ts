import { describe, expect, it } from 'vitest'
import {
  normalizeRemovedRanges,
  projectSourceRangeToOutputSegments,
  type RemovedRange,
  type SourceRange,
} from './timing'

describe('normalizeRemovedRanges', () => {
  it('sorts and merges overlapping, adjacent, nested, and duplicate ranges', () => {
    expect(
      normalizeRemovedRanges([
        { startMs: 6_000, endMs: 8_000 },
        { startMs: 2_000, endMs: 4_000 },
        { startMs: 3_000, endMs: 7_000 },
        { startMs: 2_000, endMs: 4_000 },
        { startMs: 8_000, endMs: 9_000 },
      ]),
    ).toEqual([{ startMs: 2_000, endMs: 9_000 }])
  })

  it('clamps to the source origin and ignores invalid ranges', () => {
    expect(
      normalizeRemovedRanges([
        { startMs: -500, endMs: 500 },
        { startMs: 2_000, endMs: 1_000 },
        { startMs: 3_000, endMs: 3_000 },
        { startMs: Number.NaN, endMs: 4_000 },
      ]),
    ).toEqual([{ startMs: 0, endMs: 500 }])
  })
})

describe('projectSourceRangeToOutputSegments', () => {
  it('returns the specified split-range example', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 10_000, endMs: 20_000 },
        [{ startMs: 14_000, endMs: 16_000 }],
      ),
    ).toEqual([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 14_000,
        outputStartMs: 10_000,
        outputEndMs: 14_000,
      },
      {
        sourceStartMs: 16_000,
        sourceEndMs: 20_000,
        outputStartMs: 14_000,
        outputEndMs: 18_000,
      },
    ])
  })

  it('accounts for all removed duration before and within the source range', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 10_000, endMs: 25_000 },
        [
          { startMs: 18_000, endMs: 20_000 },
          { startMs: 2_000, endMs: 5_000 },
          { startMs: 12_000, endMs: 14_000 },
        ],
      ),
    ).toEqual([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 12_000,
        outputStartMs: 7_000,
        outputEndMs: 9_000,
      },
      {
        sourceStartMs: 14_000,
        sourceEndMs: 18_000,
        outputStartMs: 9_000,
        outputEndMs: 13_000,
      },
      {
        sourceStartMs: 20_000,
        sourceEndMs: 25_000,
        outputStartMs: 13_000,
        outputEndMs: 18_000,
      },
    ])
  })

  it('returns one unchanged segment when no cut intersects', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 10_000, endMs: 20_000 },
        [{ startMs: 30_000, endMs: 40_000 }],
      ),
    ).toEqual([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        outputStartMs: 10_000,
        outputEndMs: 20_000,
      },
    ])
  })

  it('returns no segments when the source range is completely removed', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 10_000, endMs: 20_000 },
        [{ startMs: 5_000, endMs: 25_000 }],
      ),
    ).toEqual([])
  })

  it('handles unsorted complex removals without zero-length segments', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 5_000, endMs: 15_000 },
        [
          { startMs: 10_000, endMs: 12_000 },
          { startMs: 7_000, endMs: 9_000 },
          { startMs: 8_000, endMs: 10_000 },
          { startMs: 7_000, endMs: 9_000 },
          { startMs: 12_000, endMs: 12_000 },
        ],
      ),
    ).toEqual([
      {
        sourceStartMs: 5_000,
        sourceEndMs: 7_000,
        outputStartMs: 5_000,
        outputEndMs: 7_000,
      },
      {
        sourceStartMs: 12_000,
        sourceEndMs: 15_000,
        outputStartMs: 7_000,
        outputEndMs: 10_000,
      },
    ])
  })

  it('uses half-open boundaries consistently', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 10_000, endMs: 20_000 },
        [
          { startMs: 0, endMs: 10_000 },
          { startMs: 20_000, endMs: 25_000 },
        ],
      ),
    ).toEqual([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        outputStartMs: 0,
        outputEndMs: 10_000,
      },
    ])
  })

  it('does not mutate any inputs', () => {
    const range: SourceRange = { startMs: 10_000, endMs: 20_000 }
    const removedRanges: RemovedRange[] = [
      { startMs: 14_000, endMs: 16_000 },
      { startMs: 2_000, endMs: 4_000 },
    ]
    const rangeBefore = structuredClone(range)
    const removedBefore = structuredClone(removedRanges)

    projectSourceRangeToOutputSegments(range, removedRanges)

    expect(range).toEqual(rangeBefore)
    expect(removedRanges).toEqual(removedBefore)
  })

  it('returns no segments for invalid or zero-length source ranges', () => {
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 5_000, endMs: 5_000 },
        [],
      ),
    ).toEqual([])
    expect(
      projectSourceRangeToOutputSegments(
        { startMs: 8_000, endMs: 4_000 },
        [],
      ),
    ).toEqual([])
  })
})
