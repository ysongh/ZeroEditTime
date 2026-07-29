import { describe, expect, it } from 'vitest'
import {
  buildImageOverlayRenderPlan,
  normalizeImageOverlay,
} from './renderPlan'
import type { RemovedRange } from './timing'
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
  startSourceMs: 10_000,
  endSourceMs: 20_000,
  x: 0.1,
  y: 0.2,
  width: 0.4,
  height: 0.3,
  fit: 'contain',
  opacity: 0.8,
  zIndex: 2,
  fadeInMs: 500,
  fadeOutMs: 750,
}

describe('normalizeImageOverlay', () => {
  it('clamps timing, geometry, opacity, z-index, and fades', () => {
    const normalized = normalizeImageOverlay({
      ...OVERLAY,
      startSourceMs: -1_000,
      endSourceMs: 2_000,
      x: 0.9,
      y: -0.2,
      width: 0.4,
      height: 1.5,
      opacity: 3,
      zIndex: Number.NaN,
      fadeInMs: -100,
      fadeOutMs: 5_000,
    })

    expect(normalized).toEqual({
      ...OVERLAY,
      startSourceMs: 0,
      endSourceMs: 2_000,
      x: 0.6,
      y: 0,
      width: 0.4,
      height: 1,
      opacity: 1,
      zIndex: 0,
      fadeInMs: 0,
      fadeOutMs: 2_000,
    })
  })

  it('uses deterministic defaults for non-finite visual values', () => {
    const normalized = normalizeImageOverlay({
      ...OVERLAY,
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: Number.NaN,
      opacity: Number.NaN,
      fadeInMs: Number.NaN,
      fadeOutMs: Number.POSITIVE_INFINITY,
    })

    expect(normalized).toMatchObject({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
    })
  })

  it('ensures dimensions stay positive and inside the frame', () => {
    const normalized = normalizeImageOverlay({
      ...OVERLAY,
      x: 1,
      y: 1,
      width: 0,
      height: -2,
    })

    expect(normalized).not.toBeNull()
    expect(normalized?.width).toBeGreaterThan(0)
    expect(normalized?.height).toBeGreaterThan(0)
    expect((normalized?.x ?? 1) + (normalized?.width ?? 1)).toBeLessThanOrEqual(
      1,
    )
    expect(
      (normalized?.y ?? 1) + (normalized?.height ?? 1),
    ).toBeLessThanOrEqual(1)
  })

  it('returns null for an invalid source-time range', () => {
    expect(
      normalizeImageOverlay({
        ...OVERLAY,
        startSourceMs: 20_000,
        endSourceMs: 20_000,
      }),
    ).toBeNull()
    expect(
      normalizeImageOverlay({
        ...OVERLAY,
        startSourceMs: Number.NaN,
      }),
    ).toBeNull()
  })

  it('does not mutate its input', () => {
    const overlay = { ...OVERLAY, x: 2 }
    const before = structuredClone(overlay)
    normalizeImageOverlay(overlay)
    expect(overlay).toEqual(before)
  })
})

describe('buildImageOverlayRenderPlan', () => {
  it('builds one normalized render segment when no cut intersects', () => {
    expect(buildImageOverlayRenderPlan([OVERLAY], [ASSET], [])).toEqual([
      {
        overlayId: OVERLAY.id,
        assetId: ASSET.id,
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        outputStartMs: 10_000,
        outputEndMs: 20_000,
        x: 0.1,
        y: 0.2,
        width: 0.4,
        height: 0.3,
        fit: 'contain',
        opacity: 0.8,
        zIndex: 2,
        fadeInMs: 500,
        fadeOutMs: 750,
      },
    ])
  })

  it('splits at cuts and applies fades only to surviving outer segments', () => {
    const removed: RemovedRange[] = [
      { startMs: 16_000, endMs: 18_000 },
      { startMs: 2_000, endMs: 5_000 },
      { startMs: 12_000, endMs: 14_000 },
    ]

    expect(
      buildImageOverlayRenderPlan([OVERLAY], [ASSET], removed),
    ).toMatchObject([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 12_000,
        outputStartMs: 7_000,
        outputEndMs: 9_000,
        fadeInMs: 500,
        fadeOutMs: 0,
      },
      {
        sourceStartMs: 14_000,
        sourceEndMs: 16_000,
        outputStartMs: 9_000,
        outputEndMs: 11_000,
        fadeInMs: 0,
        fadeOutMs: 0,
      },
      {
        sourceStartMs: 18_000,
        sourceEndMs: 20_000,
        outputStartMs: 11_000,
        outputEndMs: 13_000,
        fadeInMs: 0,
        fadeOutMs: 750,
      },
    ])
  })

  it('clamps fades to the surviving segments that own them', () => {
    const plan = buildImageOverlayRenderPlan(
      [{ ...OVERLAY, fadeInMs: 3_000, fadeOutMs: 4_000 }],
      [ASSET],
      [{ startMs: 11_000, endMs: 19_500 }],
    )

    expect(plan).toMatchObject([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 11_000,
        fadeInMs: 1_000,
        fadeOutMs: 0,
      },
      {
        sourceStartMs: 19_500,
        sourceEndMs: 20_000,
        fadeInMs: 0,
        fadeOutMs: 500,
      },
    ])
  })

  it('keeps configured fades when the logical beginning and end are cut', () => {
    const plan = buildImageOverlayRenderPlan(
      [OVERLAY],
      [ASSET],
      [
        { startMs: 0, endMs: 12_000 },
        { startMs: 18_000, endMs: 30_000 },
      ],
    )

    expect(plan).toMatchObject([
      {
        sourceStartMs: 12_000,
        sourceEndMs: 18_000,
        fadeInMs: 500,
        fadeOutMs: 750,
      },
    ])
  })

  it('ignores missing assets, invalid overlays, and fully removed overlays', () => {
    expect(
      buildImageOverlayRenderPlan(
        [
          { ...OVERLAY, id: 'missing', assetId: 'missing-asset' },
          {
            ...OVERLAY,
            id: 'invalid',
            startSourceMs: 20_000,
            endSourceMs: 10_000,
          },
          { ...OVERLAY, id: 'removed' },
        ],
        [ASSET],
        [{ startMs: 10_000, endMs: 20_000 }],
      ),
    ).toEqual([])
  })

  it('sorts by z-index, output start, stable ID, then segment start', () => {
    const overlays: ImageOverlay[] = [
      { ...OVERLAY, id: 'z-high', zIndex: 5, startSourceMs: 0, endSourceMs: 500 },
      { ...OVERLAY, id: 'b', zIndex: 1, startSourceMs: 2_000, endSourceMs: 3_000 },
      { ...OVERLAY, id: 'c', zIndex: 1, startSourceMs: 1_000, endSourceMs: 2_000 },
      { ...OVERLAY, id: 'a', zIndex: 1, startSourceMs: 1_000, endSourceMs: 2_000 },
    ]

    expect(
      buildImageOverlayRenderPlan(overlays, [ASSET], []).map(
        (segment) => segment.overlayId,
      ),
    ).toEqual(['a', 'c', 'b', 'z-high'])
  })

  it('does not mutate assets, overlays, or removed ranges', () => {
    const overlays = [{ ...OVERLAY }]
    const assets = [{ ...ASSET }]
    const removedRanges = [{ startMs: 12_000, endMs: 14_000 }]
    const before = structuredClone({ overlays, assets, removedRanges })

    buildImageOverlayRenderPlan(overlays, assets, removedRanges)

    expect({ overlays, assets, removedRanges }).toEqual(before)
  })
})
