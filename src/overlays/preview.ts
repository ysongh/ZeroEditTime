// Pure source-time derivation for the browser preview. This deliberately does
// not use the export render plan: preview playback stays on the original video
// clock, while export projection maps the same definitions through EDL cuts.

import { normalizeImageOverlay } from './normalize'
import type { ImageOverlay, OverlayAsset, OverlayFit } from './types'

export interface ImageOverlayPreviewItem {
  overlay: ImageOverlay
  asset: OverlayAsset
  /** Domain opacity after applying the source-time fade envelope. */
  opacity: number
}

export type PreviewObjectFit = 'contain' | 'cover' | 'fill'

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function opacityForNormalizedOverlay(
  overlay: Readonly<ImageOverlay>,
  currentSourceMs: number,
): number {
  if (
    currentSourceMs < overlay.startSourceMs ||
    currentSourceMs >= overlay.endSourceMs
  ) {
    return 0
  }

  const fadeInProgress =
    overlay.fadeInMs === 0
      ? 1
      : clampUnit(
          (currentSourceMs - overlay.startSourceMs) / overlay.fadeInMs,
        )
  const fadeOutProgress =
    overlay.fadeOutMs === 0
      ? 1
      : clampUnit(
          (overlay.endSourceMs - currentSourceMs) / overlay.fadeOutMs,
        )

  // `min` gives overlapping fades one deterministic triangular envelope rather
  // than multiplying both ramps and unintentionally dimming them twice.
  return overlay.opacity * Math.min(fadeInProgress, fadeOutProgress)
}

/** Return effective preview opacity, or zero for invalid/inactive overlays. */
export function previewOpacityAtSourceTime(
  overlay: Readonly<ImageOverlay>,
  currentSourceMs: number,
): number {
  if (!Number.isFinite(currentSourceMs)) {
    return 0
  }
  const normalized = normalizeImageOverlay(overlay)
  return normalized === null
    ? 0
    : opacityForNormalizedOverlay(normalized, currentSourceMs)
}

/** Map the domain's stretch mode to the equivalent CSS object-fit value. */
export function previewObjectFit(fit: OverlayFit): PreviewObjectFit {
  return fit === 'stretch' ? 'fill' : fit
}

/**
 * Resolve the image layers visible at one point on the original source clock.
 * Missing/empty asset references and invalid definitions are ignored without
 * mutating editor state. The returned order is back-to-front and deterministic.
 */
export function buildImageOverlayPreviewItems(
  overlays: readonly ImageOverlay[],
  assets: readonly OverlayAsset[],
  currentSourceMs: number,
): ImageOverlayPreviewItem[] {
  if (!Number.isFinite(currentSourceMs)) {
    return []
  }

  const assetsById = new Map<string, OverlayAsset>()
  for (const asset of assets) {
    if (
      asset.kind === 'image' &&
      asset.src.trim() !== '' &&
      !assetsById.has(asset.id)
    ) {
      assetsById.set(asset.id, asset)
    }
  }

  const items: ImageOverlayPreviewItem[] = []
  for (const overlay of overlays) {
    const asset = assetsById.get(overlay.assetId)
    if (asset === undefined) {
      continue
    }

    const normalized = normalizeImageOverlay(overlay)
    if (
      normalized === null ||
      currentSourceMs < normalized.startSourceMs ||
      currentSourceMs >= normalized.endSourceMs
    ) {
      continue
    }

    items.push({
      overlay: normalized,
      asset,
      opacity: opacityForNormalizedOverlay(normalized, currentSourceMs),
    })
  }

  return items.sort(
    (a, b) =>
      a.overlay.zIndex - b.overlay.zIndex ||
      compareIds(a.overlay.id, b.overlay.id),
  )
}
