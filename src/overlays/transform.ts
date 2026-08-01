/** Geometry normalized to the source-video frame. */
export interface OverlayGeometry {
  x: number
  y: number
  width: number
  height: number
}

export type ResizeHandle =
  | 'north-west'
  | 'north-east'
  | 'south-east'
  | 'south-west'

export interface ResizeOverlayOptions {
  /** Aspect ratio stays locked unless a gesture modifier explicitly disables it. */
  preserveAspectRatio?: boolean
  /** Normalized minimum dimensions. Impossible minima yield to frame bounds. */
  minWidth?: number
  minHeight?: number
}

const MIN_DIMENSION = Number.EPSILON

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeGeometry(
  geometry: Readonly<OverlayGeometry>,
): OverlayGeometry {
  const width = clamp(finiteOr(geometry.width, 1), MIN_DIMENSION, 1)
  const height = clamp(finiteOr(geometry.height, 1), MIN_DIMENSION, 1)

  return {
    x: clamp(finiteOr(geometry.x, 0), 0, 1 - width),
    y: clamp(finiteOr(geometry.y, 0), 0, 1 - height),
    width,
    height,
  }
}

function normalizeMinimum(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return MIN_DIMENSION
  }

  return clamp(value, MIN_DIMENSION, 1)
}

/**
 * Move normalized overlay geometry by a normalized pointer delta while keeping
 * the complete overlay inside the frame.
 */
export function moveOverlayGeometry(
  geometry: Readonly<OverlayGeometry>,
  deltaX: number,
  deltaY: number,
): OverlayGeometry {
  const normalized = normalizeGeometry(geometry)

  return {
    ...normalized,
    x: clamp(
      normalized.x + finiteOr(deltaX, 0),
      0,
      1 - normalized.width,
    ),
    y: clamp(
      normalized.y + finiteOr(deltaY, 0),
      0,
      1 - normalized.height,
    ),
  }
}

interface ResizeAxes {
  directionX: -1 | 1
  directionY: -1 | 1
}

function resizeAxes(handle: ResizeHandle): ResizeAxes {
  switch (handle) {
    case 'north-west':
      return { directionX: -1, directionY: -1 }
    case 'north-east':
      return { directionX: 1, directionY: -1 }
    case 'south-east':
      return { directionX: 1, directionY: 1 }
    case 'south-west':
      return { directionX: -1, directionY: 1 }
  }
}

function geometryFromAnchor(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  axes: ResizeAxes,
): OverlayGeometry {
  return {
    x: axes.directionX === 1 ? anchorX : anchorX - width,
    y: axes.directionY === 1 ? anchorY : anchorY - height,
    width,
    height,
  }
}

/**
 * Resize from one corner using normalized pointer deltas. The opposite corner
 * remains fixed. Aspect ratio is preserved by default and can be unlocked for
 * a modifier-key gesture with `preserveAspectRatio: false`.
 */
export function resizeOverlayGeometry(
  geometry: Readonly<OverlayGeometry>,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  options: Readonly<ResizeOverlayOptions> = {},
): OverlayGeometry {
  const normalized = normalizeGeometry(geometry)
  const axes = resizeAxes(handle)
  const safeDeltaX = finiteOr(deltaX, 0)
  const safeDeltaY = finiteOr(deltaY, 0)
  const minWidth = normalizeMinimum(options.minWidth)
  const minHeight = normalizeMinimum(options.minHeight)

  // Preserve exact coordinates for a click/release with no movement. Rebuilding
  // a north/west origin through `anchor - size` can otherwise introduce tiny
  // floating-point differences that look like a persistent edit upstream.
  if (safeDeltaX === 0 && safeDeltaY === 0) {
    return normalized
  }

  const anchorX =
    axes.directionX === 1
      ? normalized.x
      : normalized.x + normalized.width
  const anchorY =
    axes.directionY === 1
      ? normalized.y
      : normalized.y + normalized.height
  const maxWidth = axes.directionX === 1 ? 1 - anchorX : anchorX
  const maxHeight = axes.directionY === 1 ? 1 - anchorY : anchorY

  const requestedWidth =
    normalized.width + axes.directionX * safeDeltaX
  const requestedHeight =
    normalized.height + axes.directionY * safeDeltaY

  if (options.preserveAspectRatio === false) {
    return geometryFromAnchor(
      anchorX,
      anchorY,
      clamp(requestedWidth, Math.min(minWidth, maxWidth), maxWidth),
      clamp(requestedHeight, Math.min(minHeight, maxHeight), maxHeight),
      axes,
    )
  }

  const horizontalScale = requestedWidth / normalized.width
  const verticalScale = requestedHeight / normalized.height
  const requestedScale =
    Math.abs(horizontalScale - 1) >= Math.abs(verticalScale - 1)
      ? horizontalScale
      : verticalScale
  const maxScale = Math.min(
    maxWidth / normalized.width,
    maxHeight / normalized.height,
  )
  const requestedMinScale = Math.max(
    minWidth / normalized.width,
    minHeight / normalized.height,
  )
  const minScale = Math.min(requestedMinScale, maxScale)
  const scale = clamp(requestedScale, minScale, maxScale)

  return geometryFromAnchor(
    anchorX,
    anchorY,
    normalized.width * scale,
    normalized.height * scale,
    axes,
  )
}
