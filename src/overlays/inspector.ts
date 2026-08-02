// Pure value conversion and derived-state helpers for the image-overlay
// inspector. UI drafts and validation messages stay in the React component;
// these helpers only translate valid commits into the overlay domain.

import type { ImageOverlay } from './types'
import type { OverlayGeometry } from './transform'

const TIMESTAMP_PATTERN = /^\d+(?:\.\d{1,3})?$/
const CLOCK_SECONDS_PATTERN = /^\d{2}(?:\.\d{1,3})?$/
const OPACITY_PERCENT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export interface OverlayLayerPosition {
  /** One-based position from the back of the stack. */
  position: number
  total: number
  canBringForward: boolean
  canSendBackward: boolean
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Format SOURCE milliseconds in the project's compact `m:ss` style while
 * retaining millisecond precision. Minutes deliberately continue past 59.
 */
export function formatSourceTimestamp(sourceMs: number): string {
  const totalMs = Number.isFinite(sourceMs)
    ? Math.max(0, Math.round(sourceMs))
    : 0
  const milliseconds = totalMs % 1_000
  const totalSeconds = (totalMs - milliseconds) / 1_000
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)

  return `${minutes}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`
}

function fractionalMilliseconds(secondsField: string): number {
  const dotIndex = secondsField.indexOf('.')
  if (dotIndex === -1) {
    return 0
  }
  return Number(secondsField.slice(dotIndex + 1).padEnd(3, '0'))
}

function wholeSeconds(secondsField: string): number {
  const dotIndex = secondsField.indexOf('.')
  return Number(
    dotIndex === -1 ? secondsField : secondsField.slice(0, dotIndex),
  )
}

/**
 * Parse seconds, `m:ss(.sss)`, or `h:mm:ss(.sss)` into SOURCE milliseconds.
 * Clock seconds (and hours-clock minutes) must be in [0, 59].
 */
export function parseSourceTimestamp(value: string): number | null {
  const fields = value.trim().split(':')
  if (fields.length < 1 || fields.length > 3 || fields.includes('')) {
    return null
  }

  let hours = 0
  let minutes = 0
  let secondsField: string

  if (fields.length === 1) {
    secondsField = fields[0]
    if (!TIMESTAMP_PATTERN.test(secondsField)) {
      return null
    }
  } else {
    secondsField = fields[fields.length - 1]
    if (!CLOCK_SECONDS_PATTERN.test(secondsField)) {
      return null
    }

    if (fields.length === 2) {
      if (!/^\d+$/.test(fields[0])) {
        return null
      }
      minutes = Number(fields[0])
    } else {
      if (!/^\d+$/.test(fields[0]) || !/^\d{2}$/.test(fields[1])) {
        return null
      }
      hours = Number(fields[0])
      minutes = Number(fields[1])
      if (minutes >= 60) {
        return null
      }
    }
  }

  const seconds = wholeSeconds(secondsField)
  if (fields.length > 1 && seconds >= 60) {
    return null
  }

  const result =
    ((hours * 60 + minutes) * 60 + seconds) * 1_000 +
    fractionalMilliseconds(secondsField)

  return Number.isSafeInteger(result) ? result : null
}

/** Parse a timestamp and clamp it to a known finite source duration. */
export function parseClampedSourceTimestamp(
  value: string,
  sourceDurationMs: number,
): number | null {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs < 0) {
    return null
  }

  const parsed = parseSourceTimestamp(value)
  return parsed === null ? null : Math.min(parsed, sourceDurationMs)
}

/** Parse an inspector percentage and convert it to stored opacity in [0, 1]. */
export function parseOpacityPercent(value: string): number | null {
  const trimmed = value.trim()
  if (!OPACITY_PERCENT_PATTERN.test(trimmed)) {
    return null
  }

  const percentage = Number(trimmed)
  if (!Number.isFinite(percentage)) {
    return null
  }

  return Math.min(1, Math.max(0, percentage / 100))
}

/** Center an overlay in the frame without changing its current dimensions. */
export function resetOverlayPosition(
  geometry: Readonly<OverlayGeometry>,
): OverlayGeometry {
  return {
    x: (1 - geometry.width) / 2,
    y: (1 - geometry.height) / 2,
    width: geometry.width,
    height: geometry.height,
  }
}

/** Return the normalized geometry for an overlay that fills the entire frame. */
export function fillFrameGeometry(): OverlayGeometry {
  return { x: 0, y: 0, width: 1, height: 1 }
}

/**
 * Derive the selected layer's deterministic back-to-front position. Equal
 * z-indices use the same ID tie-break as preview rendering.
 */
export function getOverlayLayerPosition(
  overlays: readonly Pick<ImageOverlay, 'id' | 'zIndex'>[],
  id: string,
): OverlayLayerPosition | null {
  const ordered = overlays
    .map((overlay) => ({
      id: overlay.id,
      zIndex: Number.isFinite(overlay.zIndex) ? overlay.zIndex : 0,
    }))
    .sort(
      (a, b) => a.zIndex - b.zIndex || compareIds(a.id, b.id),
    )
  const index = ordered.findIndex((overlay) => overlay.id === id)
  if (index === -1) {
    return null
  }

  const targetZIndex = ordered[index].zIndex

  return {
    position: index + 1,
    total: ordered.length,
    // The reducer gives a tied layer a unique z-index in either direction,
    // even when the ID tie-break already displays it at that stack edge.
    canBringForward: ordered.some(
      (overlay, overlayIndex) =>
        overlayIndex !== index && overlay.zIndex >= targetZIndex,
    ),
    canSendBackward: ordered.some(
      (overlay, overlayIndex) =>
        overlayIndex !== index && overlay.zIndex <= targetZIndex,
    ),
  }
}
