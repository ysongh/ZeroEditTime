import { describe, expect, it } from 'vitest'
import {
  buildImageOverlayPreviewItems,
  previewObjectFit,
  previewOpacityAtSourceTime,
} from './preview'
import type { ImageOverlay, OverlayAsset } from './types'

const ASSET: OverlayAsset = {
  id: 'asset-1',
  kind: 'image',
  name: 'slide.png',
  mimeType: 'image/png',
  width: 1600,
  height: 900,
  src: 'blob:slide',
}

const OVERLAY: ImageOverlay = {
  id: 'overlay-1',
  assetId: ASSET.id,
  startSourceMs: 1_000,
  endSourceMs: 5_000,
  x: 0.1,
  y: 0.2,
  width: 0.4,
  height: 0.3,
  fit: 'contain',
  opacity: 0.8,
  zIndex: 2,
  fadeInMs: 0,
  fadeOutMs: 0,
}

describe('buildImageOverlayPreviewItems', () => {
  it('uses exact half-open source-time visibility', () => {
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [ASSET], 999),
    ).toHaveLength(0)
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [ASSET], 1_000),
    ).toHaveLength(1)
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [ASSET], 4_999),
    ).toHaveLength(1)
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [ASSET], 5_000),
    ).toHaveLength(0)
  })

  it('returns simultaneous layers back-to-front by z-index then id', () => {
    const front = { ...OVERLAY, id: 'front', zIndex: 8 }
    const tiedB = { ...OVERLAY, id: 'tied-b', zIndex: 3 }
    const tiedA = { ...OVERLAY, id: 'tied-a', zIndex: 3 }

    expect(
      buildImageOverlayPreviewItems(
        [front, tiedB, tiedA],
        [ASSET],
        2_000,
      ).map((item) => item.overlay.id),
    ).toEqual(['tied-a', 'tied-b', 'front'])
  })

  it('ignores missing and empty asset references without crashing', () => {
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [], 2_000),
    ).toEqual([])
    expect(
      buildImageOverlayPreviewItems(
        [OVERLAY],
        [{ ...ASSET, src: '   ' }],
        2_000,
      ),
    ).toEqual([])
  })

  it('normalizes defensive runtime values and does not mutate inputs', () => {
    const invalidGeometry = {
      ...OVERLAY,
      x: -0.5,
      y: 0.9,
      width: 0.6,
      height: 0.4,
      opacity: 3,
    }
    const overlays = [invalidGeometry]
    const assets = [ASSET]
    const overlaysBefore = structuredClone(overlays)
    const assetsBefore = structuredClone(assets)

    const [item] = buildImageOverlayPreviewItems(overlays, assets, 2_000)

    expect(item.overlay).toMatchObject({
      x: 0,
      y: 0.6,
      width: 0.6,
      height: 0.4,
      opacity: 1,
    })
    expect(item.opacity).toBe(1)
    expect(overlays).toEqual(overlaysBefore)
    expect(assets).toEqual(assetsBefore)
  })

  it('returns no items for an invalid source clock or timing range', () => {
    expect(
      buildImageOverlayPreviewItems([OVERLAY], [ASSET], Number.NaN),
    ).toEqual([])
    expect(
      buildImageOverlayPreviewItems(
        [{ ...OVERLAY, endSourceMs: OVERLAY.startSourceMs }],
        [ASSET],
        1_000,
      ),
    ).toEqual([])
  })
})

describe('previewOpacityAtSourceTime', () => {
  const faded = {
    ...OVERLAY,
    fadeInMs: 1_000,
    fadeOutMs: 2_000,
  }

  it('applies base opacity when fades are disabled', () => {
    expect(previewOpacityAtSourceTime(OVERLAY, 2_000)).toBe(0.8)
  })

  it('applies source-time fade-in and fade-out ramps', () => {
    expect(previewOpacityAtSourceTime(faded, 1_000)).toBe(0)
    expect(previewOpacityAtSourceTime(faded, 1_500)).toBeCloseTo(0.4)
    expect(previewOpacityAtSourceTime(faded, 2_500)).toBeCloseTo(0.8)
    expect(previewOpacityAtSourceTime(faded, 4_000)).toBeCloseTo(0.4)
    expect(previewOpacityAtSourceTime(faded, 4_500)).toBeCloseTo(0.2)
    expect(previewOpacityAtSourceTime(faded, 5_000)).toBe(0)
  })

  it('uses the nearer ramp when fades overlap', () => {
    const overlapping = {
      ...OVERLAY,
      opacity: 1,
      fadeInMs: 4_000,
      fadeOutMs: 4_000,
    }

    expect(previewOpacityAtSourceTime(overlapping, 2_000)).toBeCloseTo(0.25)
    expect(previewOpacityAtSourceTime(overlapping, 3_000)).toBeCloseTo(0.5)
    expect(previewOpacityAtSourceTime(overlapping, 4_000)).toBeCloseTo(0.25)
  })

  it('returns zero outside the range or for invalid values', () => {
    expect(previewOpacityAtSourceTime(OVERLAY, 999)).toBe(0)
    expect(previewOpacityAtSourceTime(OVERLAY, 5_000)).toBe(0)
    expect(previewOpacityAtSourceTime(OVERLAY, Number.POSITIVE_INFINITY)).toBe(
      0,
    )
    expect(
      previewOpacityAtSourceTime(
        { ...OVERLAY, startSourceMs: Number.NaN },
        2_000,
      ),
    ).toBe(0)
  })
})

describe('previewObjectFit', () => {
  it('maps every overlay fit mode to CSS object-fit', () => {
    expect(previewObjectFit('contain')).toBe('contain')
    expect(previewObjectFit('cover')).toBe('cover')
    expect(previewObjectFit('stretch')).toBe('fill')
  })
})
