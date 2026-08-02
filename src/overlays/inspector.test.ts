import { describe, expect, it } from 'vitest'
import {
  fillFrameGeometry,
  formatSourceTimestamp,
  getOverlayLayerPosition,
  parseClampedSourceTimestamp,
  parseOpacityPercent,
  parseSourceTimestamp,
  resetOverlayPosition,
} from './inspector'
import type { ImageOverlay } from './types'

const OVERLAY: ImageOverlay = {
  id: 'middle',
  assetId: 'asset',
  startSourceMs: 1_000,
  endSourceMs: 4_000,
  x: 0.2,
  y: 0.3,
  width: 0.4,
  height: 0.25,
  fit: 'contain',
  opacity: 0.8,
  zIndex: 10,
  fadeInMs: 0,
  fadeOutMs: 0,
}

describe('formatSourceTimestamp', () => {
  it.each([
    [0, '0:00.000'],
    [7, '0:00.007'],
    [1_234, '0:01.234'],
    [62_005, '1:02.005'],
    [3_661_500, '61:01.500'],
  ])('formats %d source milliseconds as %s', (sourceMs, expected) => {
    expect(formatSourceTimestamp(sourceMs)).toBe(expected)
  })

  it('rounds fractional milliseconds and carries into the next second', () => {
    expect(formatSourceTimestamp(59_999.6)).toBe('1:00.000')
  })

  it('defensively formats negative and non-finite values as zero', () => {
    expect(formatSourceTimestamp(-1)).toBe('0:00.000')
    expect(formatSourceTimestamp(Number.NaN)).toBe('0:00.000')
    expect(formatSourceTimestamp(Number.POSITIVE_INFINITY)).toBe('0:00.000')
  })
})

describe('parseSourceTimestamp', () => {
  it.each([
    ['0', 0],
    ['12', 12_000],
    ['12.3', 12_300],
    ['12.034', 12_034],
    ['1:02', 62_000],
    ['61:01.5', 3_661_500],
    ['2:03:04.005', 7_384_005],
    [' 0:00.007 ', 7],
    ['0001:02:03', 3_723_000],
  ])('parses %j as %d source milliseconds', (value, expected) => {
    expect(parseSourceTimestamp(value)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    '-1',
    '+1',
    'NaN',
    'Infinity',
    '1e3',
    '.5',
    '1.',
    '1.2345',
    ':01',
    '1:',
    '1::02',
    '1:2',
    '1:60',
    '1:2:03',
    '1:60:00',
    '1:00:60',
    '1:00:00:00',
    'one minute',
    '9007199254740992',
  ])('rejects malformed or unsafe timestamp %j', (value) => {
    expect(parseSourceTimestamp(value)).toBeNull()
  })

  it('round-trips compact formatted timestamps exactly', () => {
    for (const sourceMs of [0, 1, 999, 1_000, 61_234, 3_661_500]) {
      expect(parseSourceTimestamp(formatSourceTimestamp(sourceMs))).toBe(
        sourceMs,
      )
    }
  })
})

describe('parseClampedSourceTimestamp', () => {
  it('keeps an in-range timestamp and clamps one beyond the source end', () => {
    expect(parseClampedSourceTimestamp('2.5', 5_000)).toBe(2_500)
    expect(parseClampedSourceTimestamp('8', 5_000)).toBe(5_000)
  })

  it('can clamp to a fractional-millisecond source duration', () => {
    expect(parseClampedSourceTimestamp('8', 5_000.5)).toBe(5_000.5)
  })

  it('rejects malformed timestamps and invalid source durations', () => {
    expect(parseClampedSourceTimestamp('-1', 5_000)).toBeNull()
    expect(parseClampedSourceTimestamp('1', Number.NaN)).toBeNull()
    expect(parseClampedSourceTimestamp('1', Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseClampedSourceTimestamp('1', -1)).toBeNull()
  })
})

describe('parseOpacityPercent', () => {
  it.each([
    ['0', 0],
    ['25', 0.25],
    ['33.3', 0.333],
    [' 100 ', 1],
  ])('converts %j percent to stored opacity %d', (value, expected) => {
    expect(parseOpacityPercent(value)).toBeCloseTo(expected)
  })

  it('clamps percentages to the stored zero-to-one range', () => {
    expect(parseOpacityPercent('-20')).toBe(0)
    expect(parseOpacityPercent('120')).toBe(1)
  })

  it.each(['', ' ', 'NaN', 'Infinity', '1e2', '50%', '20px', '--1']) (
    'rejects malformed percentage %j',
    (value) => {
      expect(parseOpacityPercent(value)).toBeNull()
    },
  )
})

describe('overlay inspector geometry', () => {
  it('resets position to the exact center while preserving dimensions', () => {
    expect(
      resetOverlayPosition({
        x: 0.08,
        y: 0.63,
        width: 0.4,
        height: 0.2,
      }),
    ).toEqual({ x: 0.3, y: 0.4, width: 0.4, height: 0.2 })
  })

  it('does not mutate reset-position input', () => {
    const geometry = { x: 0.1, y: 0.2, width: 0.5, height: 0.25 }
    const before = structuredClone(geometry)
    const result = resetOverlayPosition(geometry)

    expect(geometry).toEqual(before)
    expect(result).not.toBe(geometry)
  })

  it('returns fresh full-frame geometry', () => {
    const first = fillFrameGeometry()
    const second = fillFrameGeometry()

    expect(first).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })
})

describe('getOverlayLayerPosition', () => {
  const overlays: ImageOverlay[] = [
    { ...OVERLAY, id: 'front', zIndex: 20 },
    { ...OVERLAY, id: 'back', zIndex: 0 },
    { ...OVERLAY, id: 'middle', zIndex: 10 },
  ]

  it('reports one-based position and available moves back-to-front', () => {
    expect(getOverlayLayerPosition(overlays, 'back')).toEqual({
      position: 1,
      total: 3,
      canBringForward: true,
      canSendBackward: false,
    })
    expect(getOverlayLayerPosition(overlays, 'middle')).toEqual({
      position: 2,
      total: 3,
      canBringForward: true,
      canSendBackward: true,
    })
    expect(getOverlayLayerPosition(overlays, 'front')).toEqual({
      position: 3,
      total: 3,
      canBringForward: false,
      canSendBackward: true,
    })
  })

  it('breaks equal z-index ties by ID like the preview stack', () => {
    const tied = [
      { ...OVERLAY, id: 'charlie', zIndex: 4 },
      { ...OVERLAY, id: 'alpha', zIndex: 4 },
      { ...OVERLAY, id: 'bravo', zIndex: 4 },
    ]

    expect(getOverlayLayerPosition(tied, 'alpha')?.position).toBe(1)
    expect(getOverlayLayerPosition(tied, 'bravo')?.position).toBe(2)
    expect(getOverlayLayerPosition(tied, 'charlie')?.position).toBe(3)
    expect(getOverlayLayerPosition(tied, 'charlie')?.canBringForward).toBe(
      true,
    )
    expect(getOverlayLayerPosition(tied, 'alpha')?.canSendBackward).toBe(true)
  })

  it('normalizes non-finite z-indices to the domain fallback for ordering', () => {
    const defensive = [
      { ...OVERLAY, id: 'z', zIndex: Number.NaN },
      { ...OVERLAY, id: 'a', zIndex: 0 },
      { ...OVERLAY, id: 'below', zIndex: -1 },
    ]

    expect(getOverlayLayerPosition(defensive, 'z')?.position).toBe(3)
    expect(getOverlayLayerPosition(defensive, 'a')?.position).toBe(2)
  })

  it('returns null for an unknown layer and handles a one-layer stack', () => {
    expect(getOverlayLayerPosition(overlays, 'missing')).toBeNull()
    expect(getOverlayLayerPosition([OVERLAY], OVERLAY.id)).toEqual({
      position: 1,
      total: 1,
      canBringForward: false,
      canSendBackward: false,
    })
  })

  it('does not mutate overlays or their order', () => {
    const before = structuredClone(overlays)

    getOverlayLayerPosition(overlays, 'middle')

    expect(overlays).toEqual(before)
  })
})
