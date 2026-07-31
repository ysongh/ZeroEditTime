import { describe, expect, it } from 'vitest'
import {
  createDefaultImageOverlay,
  createImageOverlayFromPreset,
  DEFAULT_IMAGE_OVERLAY_DURATION_MS,
  LOGO_WIDTH,
  nextImageOverlayZIndex,
  OVERLAY_SAFE_MARGIN,
  PICTURE_IN_PICTURE_WIDTH,
  type ImageOverlayPreset,
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

describe('createImageOverlayFromPreset', () => {
  function create(
    preset: ImageOverlayPreset,
    overrides: Partial<Parameters<typeof createImageOverlayFromPreset>[0]> = {},
  ) {
    return createImageOverlayFromPreset(
      {
        id: 'overlay-1',
        asset: LANDSCAPE_ASSET,
        currentSourceMs: 2_000,
        sourceDurationMs: 10_000,
        videoWidth: 1920,
        videoHeight: 1080,
        zIndex: 4,
        ...overrides,
      },
      preset,
    )
  }

  it('creates a full-frame contain cutaway for three seconds', () => {
    expect(create('cutaway')).toMatchObject({
      startSourceMs: 2_000,
      endSourceMs: 5_000,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fit: 'contain',
      opacity: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
    })
  })

  it('creates a bottom-right, safe-area picture-in-picture', () => {
    const overlay = create('picture-in-picture')

    expect(overlay).not.toBeNull()
    expect(overlay?.width).toBe(PICTURE_IN_PICTURE_WIDTH)
    expect(overlay?.height).toBe(PICTURE_IN_PICTURE_WIDTH)
    expect((overlay?.x ?? 0) + (overlay?.width ?? 0)).toBeCloseTo(
      1 - OVERLAY_SAFE_MARGIN,
    )
    expect((overlay?.y ?? 0) + (overlay?.height ?? 0)).toBeCloseTo(
      1 - OVERLAY_SAFE_MARGIN,
    )
    expect(overlay?.fit).toBe('contain')
  })

  it('uses a 16:9 frame fallback when source dimensions are unavailable', () => {
    const overlay = create('picture-in-picture', {
      videoWidth: undefined,
      videoHeight: undefined,
    })
    expect(overlay?.x).toBeCloseTo(0.66)
    expect(overlay?.y).toBeCloseTo(0.66)
    expect(overlay?.width).toBeCloseTo(0.3)
    expect(overlay?.height).toBeCloseTo(0.3)
  })

  it('creates a top-right logo from the playhead to the source end', () => {
    const overlay = create('logo')

    expect(overlay).not.toBeNull()
    expect(overlay?.startSourceMs).toBe(2_000)
    expect(overlay?.endSourceMs).toBe(10_000)
    expect(overlay?.width).toBe(LOGO_WIDTH)
    expect(overlay?.height).toBe(LOGO_WIDTH)
    expect(overlay?.y).toBe(OVERLAY_SAFE_MARGIN)
    expect((overlay?.x ?? 0) + (overlay?.width ?? 0)).toBeCloseTo(
      1 - OVERLAY_SAFE_MARGIN,
    )
  })

  it.each<ImageOverlayPreset>([
    'default',
    'cutaway',
    'picture-in-picture',
  ])('clamps the %s preset to the source end', (preset) => {
    expect(create(preset, { currentSourceMs: 9_000 })).toMatchObject({
      startSourceMs: 9_000,
      endSourceMs: 10_000,
    })
  })

  it('keeps tall PIP and logo images inside their safe areas', () => {
    const asset = { ...LANDSCAPE_ASSET, width: 100, height: 2000 }
    for (const preset of ['picture-in-picture', 'logo'] as const) {
      const overlay = create(preset, { asset })
      expect(overlay).not.toBeNull()
      expect(overlay?.x).toBeGreaterThanOrEqual(OVERLAY_SAFE_MARGIN - 1e-10)
      expect(overlay?.y).toBeGreaterThanOrEqual(OVERLAY_SAFE_MARGIN - 1e-10)
      expect((overlay?.x ?? 1) + (overlay?.width ?? 1)).toBeLessThanOrEqual(
        1 - OVERLAY_SAFE_MARGIN + 1e-10,
      )
      expect((overlay?.y ?? 1) + (overlay?.height ?? 1)).toBeLessThanOrEqual(
        1 - OVERLAY_SAFE_MARGIN + 1e-10,
      )
      const displayedAspect =
        ((overlay?.width ?? 0) * 1920) /
        ((overlay?.height ?? 1) * 1080)
      expect(displayedAspect).toBeCloseTo(asset.width / asset.height)
    }
  })

  it.each<ImageOverlayPreset>([
    'default',
    'cutaway',
    'picture-in-picture',
    'logo',
  ])('returns null for %s at the source end', (preset) => {
    expect(create(preset, { currentSourceMs: 10_000 })).toBeNull()
  })

  it('returns null for invalid source duration', () => {
    expect(create('logo', { sourceDurationMs: Number.NaN })).toBeNull()
  })

  it('does not mutate the source asset', () => {
    const asset = { ...LANDSCAPE_ASSET }
    const before = structuredClone(asset)
    create('picture-in-picture', { asset })
    expect(asset).toEqual(before)
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
