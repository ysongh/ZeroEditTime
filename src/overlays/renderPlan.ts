// Pure image-overlay export planning — no React, DOM, asset loading, or
// ffmpeg. The eventual renderer consumes this deterministic plan.

import {
  projectSourceRangeToOutputSegments,
  type RemovedRange,
} from './timing'
import { normalizeImageOverlay } from './normalize'
import type { ImageOverlay, OverlayAsset, OverlayFit } from './types'

export { normalizeImageOverlay } from './normalize'

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
