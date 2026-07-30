// The media panel's minimal "Add at playhead" bridge. Phase 9A Part E adds
// placement presets and richer add behavior; this helper only supplies the
// basic centered, three-second default required by the Part-D media panel.

import type { ImageOverlay, OverlayAsset } from './types'

export const DEFAULT_IMAGE_OVERLAY_DURATION_MS = 3_000
export const DEFAULT_IMAGE_OVERLAY_WIDTH = 0.4

export interface DefaultImageOverlayOptions {
  id: string
  asset: OverlayAsset
  currentSourceMs: number
  sourceDurationMs: number
  videoWidth?: number
  videoHeight?: number
  zIndex: number
}

/** Place a newly-added image above every existing finite layer. */
export function nextImageOverlayZIndex(
  overlays: readonly Pick<ImageOverlay, 'zIndex'>[],
): number {
  return (
    overlays.reduce(
      (highest, overlay) =>
        Number.isFinite(overlay.zIndex)
          ? Math.max(highest, overlay.zIndex)
          : highest,
      -1,
    ) + 1
  )
}

/**
 * Build a centered, aspect-preserving overlay at the current source playhead.
 * Returns `null` at/after the source end, where no positive range can be made.
 */
export function createDefaultImageOverlay({
  id,
  asset,
  currentSourceMs,
  sourceDurationMs,
  videoWidth,
  videoHeight,
  zIndex,
}: DefaultImageOverlayOptions): ImageOverlay | null {
  if (
    id === '' ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs <= 0 ||
    !Number.isFinite(asset.width) ||
    !Number.isFinite(asset.height) ||
    asset.width <= 0 ||
    asset.height <= 0
  ) {
    return null
  }

  const startSourceMs = Math.min(
    sourceDurationMs,
    Math.max(0, finiteOr(currentSourceMs, 0)),
  )
  const endSourceMs = Math.min(
    sourceDurationMs,
    startSourceMs + DEFAULT_IMAGE_OVERLAY_DURATION_MS,
  )
  if (endSourceMs <= startSourceMs) {
    return null
  }

  const frameAspect =
    validDimension(videoWidth) && validDimension(videoHeight)
      ? videoWidth / videoHeight
      : 16 / 9
  const imageAspect = asset.width / asset.height
  let width = DEFAULT_IMAGE_OVERLAY_WIDTH
  let height = (width * frameAspect) / imageAspect
  if (height > 1) {
    height = 1
    width = Math.min(1, imageAspect / frameAspect)
  }

  return {
    id,
    assetId: asset.id,
    startSourceMs,
    endSourceMs,
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    fit: 'contain',
    opacity: 1,
    zIndex: finiteOr(zIndex, 0),
    fadeInMs: 0,
    fadeOutMs: 0,
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function validDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}
