import { describe, expect, it } from 'vitest'
import {
  moveOverlayGeometry,
  resizeOverlayGeometry,
  type OverlayGeometry,
  type ResizeHandle,
} from './transform'

const GEOMETRY: OverlayGeometry = {
  x: 0.2,
  y: 0.25,
  width: 0.4,
  height: 0.2,
}

function expectGeometryClose(
  actual: OverlayGeometry,
  expected: OverlayGeometry,
): void {
  expect(actual.x).toBeCloseTo(expected.x)
  expect(actual.y).toBeCloseTo(expected.y)
  expect(actual.width).toBeCloseTo(expected.width)
  expect(actual.height).toBeCloseTo(expected.height)
}

describe('moveOverlayGeometry', () => {
  it('applies normalized deltas without changing size', () => {
    expect(moveOverlayGeometry(GEOMETRY, 0.15, -0.1)).toEqual({
      x: 0.35,
      y: 0.15,
      width: 0.4,
      height: 0.2,
    })
  })

  it('clamps movement against every frame edge', () => {
    expect(moveOverlayGeometry(GEOMETRY, -10, -10)).toEqual({
      ...GEOMETRY,
      x: 0,
      y: 0,
    })
    expect(moveOverlayGeometry(GEOMETRY, 10, 10)).toEqual({
      ...GEOMETRY,
      x: 0.6,
      y: 0.8,
    })
  })

  it('keeps full-frame and zero-delta geometry stationary', () => {
    const fullFrame = { x: 0, y: 0, width: 1, height: 1 }

    expect(moveOverlayGeometry(fullFrame, 10, -10)).toEqual(fullFrame)
    expect(moveOverlayGeometry(GEOMETRY, 0, 0)).toEqual(GEOMETRY)
  })

  it('defensively normalizes geometry and ignores non-finite deltas', () => {
    expect(
      moveOverlayGeometry(
        { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 2, height: 0.5 },
        Number.NaN,
        Number.NEGATIVE_INFINITY,
      ),
    ).toEqual({ x: 0, y: 0, width: 1, height: 0.5 })
  })

  it('does not mutate its input', () => {
    const input = { ...GEOMETRY }
    const before = structuredClone(input)
    const result = moveOverlayGeometry(input, 0.1, 0.1)

    expect(input).toEqual(before)
    expect(result).not.toBe(input)
  })
})

describe('resizeOverlayGeometry without aspect lock', () => {
  const cases: readonly [
    ResizeHandle,
    OverlayGeometry,
    readonly [number, number],
  ][] = [
    [
      'north-west',
      { x: 0.25, y: 0.28, width: 0.35, height: 0.17 },
      [0.05, 0.03],
    ],
    [
      'north-east',
      { x: 0.2, y: 0.28, width: 0.45, height: 0.17 },
      [0.05, 0.03],
    ],
    [
      'south-east',
      { x: 0.2, y: 0.25, width: 0.45, height: 0.23 },
      [0.05, 0.03],
    ],
    [
      'south-west',
      { x: 0.25, y: 0.25, width: 0.35, height: 0.23 },
      [0.05, 0.03],
    ],
  ]

  it.each(cases)('resizes the %s corner with its opposite fixed', (
    handle,
    expected,
    [deltaX, deltaY],
  ) => {
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, handle, deltaX, deltaY, {
        preserveAspectRatio: false,
      }),
      expected,
    )
  })

  it('allows width and height to change independently', () => {
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, 'south-east', 0.1, 0.01, {
        preserveAspectRatio: false,
      }),
      { ...GEOMETRY, width: 0.5, height: 0.21 },
    )
  })

  it('enforces configurable minimum width and height without flipping', () => {
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, 'south-east', -10, -10, {
        preserveAspectRatio: false,
        minWidth: 0.15,
        minHeight: 0.1,
      }),
      { ...GEOMETRY, width: 0.15, height: 0.1 },
    )
  })

  it('clamps independently against the frame edges', () => {
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, 'south-east', 10, 10, {
        preserveAspectRatio: false,
      }),
      { ...GEOMETRY, width: 0.8, height: 0.75 },
    )
  })
})

describe('resizeOverlayGeometry with aspect lock', () => {
  const cases: readonly [
    ResizeHandle,
    OverlayGeometry,
    readonly [number, number],
  ][] = [
    [
      'north-west',
      { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
      [-0.1, -0.05],
    ],
    [
      'north-east',
      { x: 0.2, y: 0.2, width: 0.5, height: 0.25 },
      [0.1, -0.05],
    ],
    [
      'south-east',
      { x: 0.2, y: 0.25, width: 0.5, height: 0.25 },
      [0.1, 0.05],
    ],
    [
      'south-west',
      { x: 0.1, y: 0.25, width: 0.5, height: 0.25 },
      [-0.1, 0.05],
    ],
  ]

  it.each(cases)('preserves aspect ratio from the %s handle by default', (
    handle,
    expected,
    [deltaX, deltaY],
  ) => {
    const result = resizeOverlayGeometry(
      GEOMETRY,
      handle,
      deltaX,
      deltaY,
    )

    expectGeometryClose(result, expected)
    expect(result.width / result.height).toBeCloseTo(2)
  })

  it('returns exact no-op geometry from every handle', () => {
    const handles: readonly ResizeHandle[] = [
      'north-west',
      'north-east',
      'south-east',
      'south-west',
    ]

    for (const handle of handles) {
      expect(resizeOverlayGeometry(GEOMETRY, handle, 0, 0)).toEqual(
        GEOMETRY,
      )
    }
  })

  it('uses the strongest proportional pointer-axis change', () => {
    const horizontal = resizeOverlayGeometry(
      GEOMETRY,
      'south-east',
      0.1,
      0,
    )
    const vertical = resizeOverlayGeometry(
      GEOMETRY,
      'south-east',
      0,
      0.1,
    )

    expectGeometryClose(horizontal, {
      ...GEOMETRY,
      width: 0.5,
      height: 0.25,
    })
    expectGeometryClose(vertical, {
      ...GEOMETRY,
      width: 0.6,
      height: 0.3,
    })
  })

  it('honors both minimums while retaining the original ratio', () => {
    const result = resizeOverlayGeometry(
      GEOMETRY,
      'south-east',
      -10,
      -10,
      { minWidth: 0.1, minHeight: 0.12 },
    )

    expectGeometryClose(result, {
      ...GEOMETRY,
      width: 0.24,
      height: 0.12,
    })
    expect(result.width / result.height).toBeCloseTo(2)
  })

  it('clamps scale at the nearest frame edge', () => {
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, 'south-east', 10, 10),
      { ...GEOMETRY, width: 0.8, height: 0.4 },
    )
    expectGeometryClose(
      resizeOverlayGeometry(GEOMETRY, 'north-west', -10, -10),
      { x: 0, y: 0.15, width: 0.6, height: 0.3 },
    )
  })

  it('shrinks a full-frame overlay while keeping its opposite corner fixed', () => {
    expectGeometryClose(
      resizeOverlayGeometry(
        { x: 0, y: 0, width: 1, height: 1 },
        'north-west',
        0.25,
        0.25,
      ),
      { x: 0.25, y: 0.25, width: 0.75, height: 0.75 },
    )
  })

  it('preserves an extreme portrait ratio while clamping at the frame', () => {
    const portrait = { x: 0.45, y: 0.1, width: 0.1, height: 0.8 }
    const result = resizeOverlayGeometry(
      portrait,
      'south-east',
      0.4,
      0,
    )

    expectGeometryClose(result, {
      x: 0.45,
      y: 0.1,
      width: 0.1125,
      height: 0.9,
    })
    expect(result.width / result.height).toBeCloseTo(0.125)
  })

  it('reduces an impossible requested minimum to the available frame', () => {
    const nearEdge = { x: 0.9, y: 0.9, width: 0.1, height: 0.1 }

    expectGeometryClose(
      resizeOverlayGeometry(nearEdge, 'south-east', -1, -1, {
        minWidth: 0.5,
        minHeight: 0.5,
      }),
      nearEdge,
    )
  })

  it('does not mutate geometry or options', () => {
    const input = { ...GEOMETRY }
    const options = {
      preserveAspectRatio: true,
      minWidth: 0.1,
      minHeight: 0.1,
    } as const
    const inputBefore = structuredClone(input)
    const optionsBefore = structuredClone(options)
    const result = resizeOverlayGeometry(
      input,
      'north-east',
      0.1,
      -0.05,
      options,
    )

    expect(input).toEqual(inputBefore)
    expect(options).toEqual(optionsBefore)
    expect(result).not.toBe(input)
  })
})
