import { describe, expect, it } from 'vitest'
import {
  calculateOverlayTimingDraft,
  clientDeltaToSourceMs,
  fitOverlayTimelineHitArea,
  getOverlayTimelineGeometry,
  MIN_OVERLAY_DURATION_MS,
  type OverlayTimelineEditKind,
  type OverlayTimelineRange,
} from './timeline'

const ORIGIN: OverlayTimelineRange = {
  startSourceMs: 2_000,
  endSourceMs: 5_000,
}
const SOURCE_DURATION_MS = 10_000

describe('getOverlayTimelineGeometry', () => {
  it('maps source timing to fractions of the full source duration', () => {
    expect(getOverlayTimelineGeometry(ORIGIN, SOURCE_DURATION_MS)).toEqual({
      leftFraction: 0.2,
      widthFraction: 0.3,
    })
    expect(
      getOverlayTimelineGeometry(
        { startSourceMs: 0, endSourceMs: SOURCE_DURATION_MS },
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ leftFraction: 0, widthFraction: 1 })
  })

  it('does not mutate its range', () => {
    const range = { ...ORIGIN }
    const before = structuredClone(range)

    getOverlayTimelineGeometry(range, SOURCE_DURATION_MS)

    expect(range).toEqual(before)
  })

  it.each([
    [{ startSourceMs: -1, endSourceMs: 5_000 }, SOURCE_DURATION_MS],
    [{ startSourceMs: 2_000, endSourceMs: 10_001 }, SOURCE_DURATION_MS],
    [{ startSourceMs: 5_000, endSourceMs: 5_000 }, SOURCE_DURATION_MS],
    [{ startSourceMs: Number.NaN, endSourceMs: 5_000 }, SOURCE_DURATION_MS],
    [ORIGIN, 0],
    [ORIGIN, Number.NaN],
  ])('rejects an invalid range or source duration', (range, duration) => {
    expect(getOverlayTimelineGeometry(range, duration)).toBeNull()
  })
})

describe('fitOverlayTimelineHitArea', () => {
  it('leaves a long block at its exact pixel geometry', () => {
    expect(
      fitOverlayTimelineHitArea(
        { leftFraction: 0.2, widthFraction: 0.3 },
        1_000,
        72,
      ),
    ).toEqual({
      leftPx: 200,
      widthPx: 300,
      contentLeftPx: 0,
      contentWidthPx: 300,
    })
  })

  it('centers a minimum-width hit area around a short exact block', () => {
    expect(
      fitOverlayTimelineHitArea(
        { leftFraction: 0.5, widthFraction: 0.001 },
        1_000,
        72,
      ),
    ).toEqual({
      leftPx: 464.5,
      widthPx: 72,
      contentLeftPx: 35.5,
      contentWidthPx: 1,
    })
  })

  it('fits short hit areas at both track boundaries', () => {
    expect(
      fitOverlayTimelineHitArea(
        { leftFraction: 0, widthFraction: 0.001 },
        1_000,
        72,
      ),
    ).toEqual({
      leftPx: 0,
      widthPx: 72,
      contentLeftPx: 0,
      contentWidthPx: 1,
    })
    expect(
      fitOverlayTimelineHitArea(
        { leftFraction: 0.999, widthFraction: 0.001 },
        1_000,
        72,
      ),
    ).toEqual({
      leftPx: 928,
      widthPx: 72,
      contentLeftPx: 71,
      contentWidthPx: 1,
    })
  })

  it('tolerates and clamps a floating-point epsilon at the source end', () => {
    const area = fitOverlayTimelineHitArea(
      { leftFraction: 0.9000000000000001, widthFraction: 0.1 },
      1_000,
      72,
    )

    expect(area).not.toBeNull()
    expect((area?.contentLeftPx ?? 0) + (area?.contentWidthPx ?? 0)).toBe(
      area?.widthPx,
    )
  })

  it('uses the full track when it is narrower than the minimum', () => {
    expect(
      fitOverlayTimelineHitArea(
        { leftFraction: 0.4, widthFraction: 0.1 },
        50,
        72,
      ),
    ).toEqual({
      leftPx: 0,
      widthPx: 50,
      contentLeftPx: 20,
      contentWidthPx: 5,
    })
  })

  it.each([
    [{ leftFraction: -0.1, widthFraction: 0.2 }, 1_000, 72],
    [{ leftFraction: 0.9, widthFraction: 0.2 }, 1_000, 72],
    [{ leftFraction: 0.2, widthFraction: 0 }, 1_000, 72],
    [{ leftFraction: 0.2, widthFraction: 0.3 }, 0, 72],
    [{ leftFraction: 0.2, widthFraction: 0.3 }, 1_000, 0],
  ])('rejects invalid geometry and dimensions', (geometry, width, minimum) => {
    expect(
      fitOverlayTimelineHitArea(geometry, width, minimum),
    ).toBeNull()
  })
})

describe('clientDeltaToSourceMs', () => {
  it('converts positive, negative, and fractional horizontal deltas', () => {
    expect(clientDeltaToSourceMs(100, 500, 10_000)).toBe(2_000)
    expect(clientDeltaToSourceMs(-25, 500, 10_000)).toBe(-500)
    expect(clientDeltaToSourceMs(1, 3, 1_000)).toBeCloseTo(1_000 / 3)
  })

  it.each([
    [Number.NaN, 500, 10_000],
    [Number.POSITIVE_INFINITY, 500, 10_000],
    [100, Number.NaN, 10_000],
    [100, Number.POSITIVE_INFINITY, 10_000],
    [100, 0, 10_000],
    [100, -500, 10_000],
    [100, 500, Number.NaN],
    [100, 500, Number.POSITIVE_INFINITY],
    [100, 500, 0],
    [100, 500, -10_000],
  ])(
    'returns zero for invalid dimensions (%s, %s, %s)',
    (clientXDelta, trackWidthPx, sourceDurationMs) => {
      expect(
        clientDeltaToSourceMs(
          clientXDelta,
          trackWidthPx,
          sourceDurationMs,
        ),
      ).toBe(0)
    },
  )
})

describe('calculateOverlayTimingDraft move', () => {
  it('moves both boundaries by the same source-time delta', () => {
    expect(
      calculateOverlayTimingDraft(ORIGIN, 'move', 1_250, SOURCE_DURATION_MS),
    ).toEqual({ startSourceMs: 3_250, endSourceMs: 6_250 })
  })

  it('clamps large negative movement to the source start', () => {
    expect(
      calculateOverlayTimingDraft(ORIGIN, 'move', -20_000, SOURCE_DURATION_MS),
    ).toEqual({ startSourceMs: 0, endSourceMs: 3_000 })
  })

  it('clamps large positive movement to the source end', () => {
    expect(
      calculateOverlayTimingDraft(ORIGIN, 'move', 20_000, SOURCE_DURATION_MS),
    ).toEqual({ startSourceMs: 7_000, endSourceMs: 10_000 })
  })

  it('assigns a decimal source end exactly when clamped right', () => {
    const duration = 4_998_491.634215276
    const origin = {
      startSourceMs: 4_187_427.7139269295,
      endSourceMs: 4_360_597.108036426,
    }

    const moved = calculateOverlayTimingDraft(
      origin,
      'move',
      duration,
      duration,
    )

    expect(moved.endSourceMs).toBe(duration)
    expect(moved.startSourceMs).toBeLessThan(moved.endSourceMs)
    expect(getOverlayTimelineGeometry(moved, duration)).not.toBeNull()
  })

  it('preserves duration when landing exactly on either boundary', () => {
    expect(
      calculateOverlayTimingDraft(ORIGIN, 'move', -2_000, SOURCE_DURATION_MS),
    ).toEqual({ startSourceMs: 0, endSourceMs: 3_000 })
    expect(
      calculateOverlayTimingDraft(ORIGIN, 'move', 5_000, SOURCE_DURATION_MS),
    ).toEqual({ startSourceMs: 7_000, endSourceMs: 10_000 })
  })
})

describe('calculateOverlayTimingDraft trim-start', () => {
  it('moves only the start boundary', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-start',
        -1_250,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 750, endSourceMs: 5_000 })
  })

  it('clamps a large negative delta to the source start', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-start',
        -20_000,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 0, endSourceMs: 5_000 })
  })

  it('clamps a large positive delta to the exact minimum duration', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-start',
        20_000,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({
      startSourceMs: 5_000 - MIN_OVERLAY_DURATION_MS,
      endSourceMs: 5_000,
    })
  })
})

describe('calculateOverlayTimingDraft trim-end', () => {
  it('moves only the end boundary', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-end',
        1_250,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 2_000, endSourceMs: 6_250 })
  })

  it('clamps a large positive delta to the source end', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-end',
        20_000,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 2_000, endSourceMs: 10_000 })
  })

  it('clamps a large negative delta to the exact minimum duration', () => {
    expect(
      calculateOverlayTimingDraft(
        ORIGIN,
        'trim-end',
        -20_000,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({
      startSourceMs: 2_000,
      endSourceMs: 2_000 + MIN_OVERLAY_DURATION_MS,
    })
  })
})

describe('calculateOverlayTimingDraft defensive behavior', () => {
  it('does not mutate the immutable pointer-down origin', () => {
    const origin = { ...ORIGIN }
    const before = structuredClone(origin)

    const draft = calculateOverlayTimingDraft(
      origin,
      'move',
      1_000,
      SOURCE_DURATION_MS,
    )

    expect(origin).toEqual(before)
    expect(draft).not.toBe(origin)
  })

  it.each<OverlayTimelineEditKind>(['move', 'trim-start', 'trim-end'])(
    'returns the original object for a zero-delta %s no-op',
    (kind) => {
      expect(
        calculateOverlayTimingDraft(ORIGIN, kind, 0, SOURCE_DURATION_MS),
      ).toBe(ORIGIN)
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns the original object for invalid delta %s',
    (delta) => {
      expect(
        calculateOverlayTimingDraft(ORIGIN, 'move', delta, SOURCE_DURATION_MS),
      ).toBe(ORIGIN)
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    'returns the original object for invalid source duration %s',
    (sourceDurationMs) => {
      expect(
        calculateOverlayTimingDraft(ORIGIN, 'move', 1_000, sourceDurationMs),
      ).toBe(ORIGIN)
    },
  )

  it('handles a source shorter than the configured minimum without a jump', () => {
    const shortOrigin: OverlayTimelineRange = {
      startSourceMs: 0,
      endSourceMs: 50,
    }

    expect(
      calculateOverlayTimingDraft(shortOrigin, 'trim-end', -25, 50),
    ).toBe(shortOrigin)
    expect(
      calculateOverlayTimingDraft(shortOrigin, 'trim-start', 25, 50),
    ).toBe(shortOrigin)
    expect(
      calculateOverlayTimingDraft(shortOrigin, 'move', 25, 50),
    ).toBe(shortOrigin)
  })

  it('does not shrink a valid pre-existing sub-minimum range', () => {
    const shortOrigin: OverlayTimelineRange = {
      startSourceMs: 2_000,
      endSourceMs: 2_075,
    }

    expect(
      calculateOverlayTimingDraft(
        shortOrigin,
        'trim-start',
        50,
        SOURCE_DURATION_MS,
      ),
    ).toBe(shortOrigin)
    expect(
      calculateOverlayTimingDraft(
        shortOrigin,
        'trim-end',
        -50,
        SOURCE_DURATION_MS,
      ),
    ).toBe(shortOrigin)
  })

  it('allows a pre-existing sub-minimum range to grow', () => {
    const shortOrigin: OverlayTimelineRange = {
      startSourceMs: 2_000,
      endSourceMs: 2_075,
    }

    expect(
      calculateOverlayTimingDraft(
        shortOrigin,
        'trim-start',
        -50,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 1_950, endSourceMs: 2_075 })
    expect(
      calculateOverlayTimingDraft(
        shortOrigin,
        'trim-end',
        50,
        SOURCE_DURATION_MS,
      ),
    ).toEqual({ startSourceMs: 2_000, endSourceMs: 2_125 })
  })

  it.each([
    { startSourceMs: Number.NaN, endSourceMs: 5_000 },
    { startSourceMs: 2_000, endSourceMs: Number.POSITIVE_INFINITY },
    { startSourceMs: -1, endSourceMs: 5_000 },
    { startSourceMs: 5_000, endSourceMs: 4_000 },
    { startSourceMs: 2_000, endSourceMs: 2_000 },
    { startSourceMs: 2_000, endSourceMs: 10_001 },
  ])('returns an invalid origin unchanged: $startSourceMs..$endSourceMs', (origin) => {
    expect(
      calculateOverlayTimingDraft(origin, 'move', 1_000, SOURCE_DURATION_MS),
    ).toBe(origin)
  })

  it('uses the immutable origin rather than accumulating prior drafts', () => {
    const firstDraft = calculateOverlayTimingDraft(
      ORIGIN,
      'move',
      500,
      SOURCE_DURATION_MS,
    )
    const secondDraft = calculateOverlayTimingDraft(
      ORIGIN,
      'move',
      1_000,
      SOURCE_DURATION_MS,
    )

    expect(firstDraft).toEqual({ startSourceMs: 2_500, endSourceMs: 5_500 })
    expect(secondDraft).toEqual({ startSourceMs: 3_000, endSourceMs: 6_000 })
  })
})
