// Pure image-overlay placement presets. All timing is source milliseconds and
// all geometry is normalized to the source video frame.

import type { ImageOverlay, OverlayAsset } from './types'

export const DEFAULT_IMAGE_OVERLAY_DURATION_MS = 3_000
export const DEFAULT_IMAGE_OVERLAY_WIDTH = 0.4
export const PICTURE_IN_PICTURE_WIDTH = 0.3
export const LOGO_WIDTH = 0.12
export const OVERLAY_SAFE_MARGIN = 0.04

export type ImageOverlayPreset =
  | 'default'
  | 'cutaway'
  | 'picture-in-picture'
  | 'logo'

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
 * Backward-compatible Part-D default; Part E routes all quick actions through
 * `createImageOverlayFromPreset`.
 */
export function createDefaultImageOverlay(
  options: DefaultImageOverlayOptions,
): ImageOverlay | null {
  return createImageOverlayFromPreset(options, 'default')
}

/**
 * Build an overlay at the current source playhead using a quick-add preset.
 * Returns `null` at/after the source end, where no positive range can be made.
 */
export function createImageOverlayFromPreset(
  {
    id,
    asset,
    currentSourceMs,
    sourceDurationMs,
    videoWidth,
    videoHeight,
    zIndex,
  }: DefaultImageOverlayOptions,
  preset: ImageOverlayPreset,
): ImageOverlay | null {
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
  const endSourceMs =
    preset === 'logo'
      ? sourceDurationMs
      : Math.min(
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
  const geometry = geometryForPreset(preset, frameAspect, imageAspect)

  return {
    id,
    assetId: asset.id,
    startSourceMs,
    endSourceMs,
    ...geometry,
    opacity: 1,
    zIndex: finiteOr(zIndex, 0),
    fadeInMs: 0,
    fadeOutMs: 0,
  }
}

function geometryForPreset(
  preset: ImageOverlayPreset,
  frameAspect: number,
  imageAspect: number,
): Pick<ImageOverlay, 'x' | 'y' | 'width' | 'height' | 'fit'> {
  if (preset === 'cutaway') {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fit: 'contain',
    }
  }

  const targetWidth =
    preset === 'picture-in-picture'
      ? PICTURE_IN_PICTURE_WIDTH
      : preset === 'logo'
        ? LOGO_WIDTH
        : DEFAULT_IMAGE_OVERLAY_WIDTH
  const margin = preset === 'default' ? 0 : OVERLAY_SAFE_MARGIN
  const { width, height } = aspectPreservingSize(
    targetWidth,
    1 - margin * 2,
    frameAspect,
    imageAspect,
  )

  if (preset === 'picture-in-picture') {
    return {
      x: 1 - margin - width,
      y: 1 - margin - height,
      width,
      height,
      fit: 'contain',
    }
  }
  if (preset === 'logo') {
    return {
      x: 1 - margin - width,
      y: margin,
      width,
      height,
      fit: 'contain',
    }
  }
  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
    fit: 'contain',
  }
}

function aspectPreservingSize(
  targetWidth: number,
  maxHeight: number,
  frameAspect: number,
  imageAspect: number,
): { width: number; height: number } {
  let width = targetWidth
  let height = (width * frameAspect) / imageAspect
  if (height > maxHeight) {
    height = maxHeight
    width = (height * imageAspect) / frameAspect
  }
  return { width, height }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function validDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}
