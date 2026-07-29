// Pure image-overlay export planning — no React, DOM, asset loading, or
// ffmpeg. The eventual renderer consumes this deterministic plan.

import {
  projectSourceRangeToOutputSegments,
  type RemovedRange,
} from './timing'
import type { ImageOverlay, OverlayAsset, OverlayFit } from './types'

export interface OverlayRenderSegment {
  overlayId: string
  assetId: string

  sourceStartMs: number
  sourceEndMs: number
  outputStartMs: number
  outputEndMs: number

  x: number
  y: number
  width: number
  height: number

  fit: OverlayFit
  opacity: number
  zIndex: number

  fadeInMs: number
  fadeOutMs: number
}

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

/**
 * Convert source-authored image overlays into deterministic export segments.
 *
 * Missing asset references and invalid overlay ranges are ignored. Cuts may
 * split one logical overlay into several adjacent output pieces; only the
 * first surviving piece receives fade-in and only the final surviving piece
 * receives fade-out, so cut boundaries never introduce artificial fades.
 */
export function buildImageOverlayRenderPlan(
  overlays: readonly ImageOverlay[],
  assets: readonly OverlayAsset[],
  removedRanges: readonly RemovedRange[],
): OverlayRenderSegment[] {
  const imageAssetIds = new Set(
    assets
      .filter((asset) => asset.kind === 'image')
      .map((asset) => asset.id),
  )
  const plan: OverlayRenderSegment[] = []

  for (const overlay of overlays) {
    if (!imageAssetIds.has(overlay.assetId)) {
      continue
    }

    const normalized = normalizeImageOverlay(overlay)
    if (!normalized) {
      continue
    }

    const projected = projectSourceRangeToOutputSegments(
      {
        startMs: normalized.startSourceMs,
        endMs: normalized.endSourceMs,
      },
      removedRanges,
    )

    for (let index = 0; index < projected.length; index++) {
      const segment = projected[index]
      const durationMs = segment.outputEndMs - segment.outputStartMs
      plan.push({
        overlayId: normalized.id,
        assetId: normalized.assetId,
        ...segment,
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
        fit: normalized.fit,
        opacity: normalized.opacity,
        zIndex: normalized.zIndex,
        fadeInMs:
          index === 0 ? Math.min(normalized.fadeInMs, durationMs) : 0,
        fadeOutMs:
          index === projected.length - 1
            ? Math.min(normalized.fadeOutMs, durationMs)
            : 0,
      })
    }
  }

  return plan.sort(
    (a, b) =>
      a.zIndex - b.zIndex ||
      a.outputStartMs - b.outputStartMs ||
      compareIds(a.overlayId, b.overlayId) ||
      a.sourceStartMs - b.sourceStartMs,
  )
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
