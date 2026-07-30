// Shared overlay-domain normalization. Kept separate from render planning so
// editor state operations and export planning enforce the same invariants
// without either layer depending on the other.

import type { ImageOverlay, OverlayFit } from './types'

const MIN_NORMALIZED_DIMENSION = Number.EPSILON
const OVERLAY_FITS: readonly OverlayFit[] = ['contain', 'cover', 'stretch']

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function isOverlayFit(value: OverlayFit): boolean {
  return OVERLAY_FITS.includes(value)
}

/**
 * Normalize an overlay into valid source timing and in-frame visual bounds.
 *
 * Returns `null` when no positive source-time range can be recovered. Geometry
 * is kept normalized and fully inside the video frame; invalid numeric visual
 * values receive deterministic defaults. Fades are non-negative and initially
 * clamped to the logical overlay duration (the render plan further clamps each
 * fade to the surviving segment that owns it).
 */
export function normalizeImageOverlay(
  overlay: Readonly<ImageOverlay>,
): ImageOverlay | null {
  if (
    !Number.isFinite(overlay.startSourceMs) ||
    !Number.isFinite(overlay.endSourceMs)
  ) {
    return null
  }

  const startSourceMs = Math.max(0, overlay.startSourceMs)
  const endSourceMs = overlay.endSourceMs
  if (endSourceMs <= startSourceMs) {
    return null
  }

  const width = clamp(
    finiteOr(overlay.width, 1),
    MIN_NORMALIZED_DIMENSION,
    1,
  )
  const height = clamp(
    finiteOr(overlay.height, 1),
    MIN_NORMALIZED_DIMENSION,
    1,
  )
  const durationMs = endSourceMs - startSourceMs

  return {
    ...overlay,
    startSourceMs,
    endSourceMs,
    x: clamp(finiteOr(overlay.x, 0), 0, 1 - width),
    y: clamp(finiteOr(overlay.y, 0), 0, 1 - height),
    width,
    height,
    fit: isOverlayFit(overlay.fit) ? overlay.fit : 'contain',
    opacity: clamp(finiteOr(overlay.opacity, 1), 0, 1),
    zIndex: finiteOr(overlay.zIndex, 0),
    fadeInMs: clamp(finiteOr(overlay.fadeInMs, 0), 0, durationMs),
    fadeOutMs: clamp(finiteOr(overlay.fadeOutMs, 0), 0, durationMs),
  }
}
