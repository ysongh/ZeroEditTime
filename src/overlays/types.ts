// Serializable still-image-overlay domain contracts. Local image bytes and
// browser objects stay outside editor state; `src` is only a runtime asset
// reference such as an object URL.

export type OverlayAssetKind = 'image'

export interface OverlayAsset {
  id: string
  kind: OverlayAssetKind
  name: string
  mimeType: string
  width: number
  height: number
  src: string
}

export type OverlayFit = 'contain' | 'cover' | 'stretch'

export interface ImageOverlay {
  id: string
  assetId: string

  /** Half-open range [startSourceMs, endSourceMs) in source-video time. */
  startSourceMs: number
  endSourceMs: number

  /** Position and size normalized relative to the video frame. */
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
