import { describe, expect, it } from 'vitest'
import {
  createDefaultImageOverlay,
  DEFAULT_IMAGE_OVERLAY_DURATION_MS,
  nextImageOverlayZIndex,
} from './defaultOverlay'
import type { OverlayAsset } from './types'

const LANDSCAPE_ASSET: OverlayAsset = {
  id: 'asset-1',
  kind: 'image',
  name: 'slide.png',
  mimeType: 'image/png',
  width: 1600,
  height: 900,
  src: 'blob:slide',
}

describe('createDefaultImageOverlay', () => {
  it('creates a centered three-second overlay at the source playhead', () => {
    const overlay = createDefaultImageOverlay({
      id: 'overlay-1',
      asset: LANDSCAPE_ASSET,
      currentSourceMs: 2_000,
      sourceDurationMs: 10_000,
      videoWidth: 1920,
      videoHeight: 1080,
      zIndex: 4,
    })

    expect(overlay).toEqual({
      id: 'overlay-1',
      assetId: LANDSCAPE_ASSET.id,
      startSourceMs: 2_000,
      endSourceMs: 2_000 + DEFAULT_IMAGE_OVERLAY_DURATION_MS,
      x: 0.3,
      y: 0.3,
      width: 0.4,
      height: 0.4,
      fit: 'contain',
      opacity: 1,
      zIndex: 4,
      fadeInMs: 0,
      fadeOutMs: 0,
    })
  })

  it('clamps timing to the source end', () => {
    expect(
      createDefaultImageOverlay({
        id: 'overlay-1',
        asset: LANDSCAPE_ASSET,
        currentSourceMs: 9_000,
        sourceDurationMs: 10_000,
        zIndex: 0,
      }),
    ).toMatchObject({ startSourceMs: 9_000, endSourceMs: 10_000 })
  })

  it('preserves a portrait image aspect ratio while keeping it in frame', () => {
    const overlay = createDefaultImageOverlay({
      id: 'portrait',
      asset: { ...LANDSCAPE_ASSET, width: 900, height: 1600 },
      currentSourceMs: 0,
      sourceDurationMs: 5_000,
      videoWidth: 1920,
      videoHeight: 1080,
      zIndex: 0,
    })

    expect(overlay).not.toBeNull()
    expect(overlay?.height).toBe(1)
    expect((overlay?.x ?? 1) + (overlay?.width ?? 1)).toBeLessThanOrEqual(1)
    const displayedAspect =
      ((overlay?.width ?? 0) * 1920) / ((overlay?.height ?? 1) * 1080)
    expect(displayedAspect).toBeCloseTo(900 / 1600)
  })

  it('returns null at the source end or for invalid dimensions', () => {
    expect(
      createDefaultImageOverlay({
        id: 'at-end',
        asset: LANDSCAPE_ASSET,
        currentSourceMs: 10_000,
        sourceDurationMs: 10_000,
        zIndex: 0,
      }),
    ).toBeNull()
    expect(
      createDefaultImageOverlay({
        id: 'bad-image',
        asset: { ...LANDSCAPE_ASSET, width: 0 },
        currentSourceMs: 0,
        sourceDurationMs: 10_000,
        zIndex: 0,
      }),
    ).toBeNull()
  })
})

describe('nextImageOverlayZIndex', () => {
  it('returns zero for an empty stack and one above the highest finite layer', () => {
    expect(nextImageOverlayZIndex([])).toBe(0)
    expect(
      nextImageOverlayZIndex([
        { zIndex: 4 },
        { zIndex: -2 },
        { zIndex: Number.NaN },
      ]),
    ).toBe(5)
  })
})
