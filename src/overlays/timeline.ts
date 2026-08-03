// Pure source-time math for the image-overlay timeline track. Pointer-event
// state stays in React; each draft is recalculated from the immutable range at
// pointer-down so movement does not accumulate rounding error.

export const MIN_OVERLAY_DURATION_MS = 100
const TIMELINE_FRACTION_EPSILON = 1e-12

export type OverlayTimelineEditKind = 'move' | 'trim-start' | 'trim-end'

export interface OverlayTimelineRange {
  startSourceMs: number
  endSourceMs: number
}

export interface OverlayTimelineGeometry {
  leftFraction: number
  widthFraction: number
}

export interface OverlayTimelineHitArea {
  leftPx: number
  widthPx: number
  /** Exact source-time block position inside the fitted interaction area. */
  contentLeftPx: number
  contentWidthPx: number
}

/**
 * Project a valid source-time range onto the full source timeline. This uses
 * source duration directly: removed EDL ranges never shift or hide a block.
 */
export function getOverlayTimelineGeometry(
  range: Readonly<OverlayTimelineRange>,
  sourceDurationMs: number,
): OverlayTimelineGeometry | null {
  if (!isValidOrigin(range, sourceDurationMs)) {
    return null
  }

  return {
    leftFraction: range.startSourceMs / sourceDurationMs,
    widthFraction:
      (range.endSourceMs - range.startSourceMs) / sourceDurationMs,
  }
}

/**
 * Give short blocks a usable move/trim target without losing their exact
 * source-time geometry. The hit area is centered where possible and fitted
 * inside the track; `content*` retains the true visual block bounds.
 */
export function fitOverlayTimelineHitArea(
  geometry: Readonly<OverlayTimelineGeometry>,
  trackWidthPx: number,
  minimumWidthPx: number,
): OverlayTimelineHitArea | null {
  if (
    !Number.isFinite(geometry.leftFraction) ||
    !Number.isFinite(geometry.widthFraction) ||
    geometry.leftFraction < 0 ||
    geometry.leftFraction >= 1 ||
    geometry.widthFraction <= 0 ||
    geometry.leftFraction + geometry.widthFraction >
      1 + TIMELINE_FRACTION_EPSILON ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0 ||
    !Number.isFinite(minimumWidthPx) ||
    minimumWidthPx <= 0
  ) {
    return null
  }

  const contentLeftOnTrackPx = geometry.leftFraction * trackWidthPx
  const boundedWidthFraction = Math.min(
    geometry.widthFraction,
    1 - geometry.leftFraction,
  )
  const contentWidthPx = boundedWidthFraction * trackWidthPx
  const widthPx = Math.min(
    trackWidthPx,
    Math.max(contentWidthPx, minimumWidthPx),
  )
  const centeredLeftPx =
    contentLeftOnTrackPx - (widthPx - contentWidthPx) / 2
  const leftPx = Math.min(
    trackWidthPx - widthPx,
    Math.max(0, centeredLeftPx),
  )

  return {
    leftPx,
    widthPx,
    contentLeftPx: contentLeftOnTrackPx - leftPx,
    contentWidthPx,
  }
}

function isValidOrigin(
  origin: Readonly<OverlayTimelineRange>,
  sourceDurationMs: number,
): boolean {
  return (
    Number.isFinite(sourceDurationMs) &&
    sourceDurationMs > 0 &&
    Number.isFinite(origin.startSourceMs) &&
    Number.isFinite(origin.endSourceMs) &&
    origin.startSourceMs >= 0 &&
    origin.endSourceMs <= sourceDurationMs &&
    origin.endSourceMs > origin.startSourceMs
  )
}

function rangeOrOrigin(
  origin: Readonly<OverlayTimelineRange>,
  startSourceMs: number,
  endSourceMs: number,
): OverlayTimelineRange {
  return startSourceMs === origin.startSourceMs &&
    endSourceMs === origin.endSourceMs
    ? origin
    : { startSourceMs, endSourceMs }
}

/**
 * Convert horizontal pointer movement into source milliseconds. Invalid track
 * measurements represent no movement so callers never propagate NaN values.
 */
export function clientDeltaToSourceMs(
  clientXDelta: number,
  trackWidthPx: number,
  sourceDurationMs: number,
): number {
  if (
    !Number.isFinite(clientXDelta) ||
    !Number.isFinite(trackWidthPx) ||
    trackWidthPx <= 0 ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs <= 0
  ) {
    return 0
  }

  return (clientXDelta / trackWidthPx) * sourceDurationMs
}

/**
 * Calculate a timeline drag draft from the immutable pointer-down range.
 * Invalid origins, deltas, or source durations are safe identity no-ops.
 */
export function calculateOverlayTimingDraft(
  origin: Readonly<OverlayTimelineRange>,
  kind: OverlayTimelineEditKind,
  sourceDeltaMs: number,
  sourceDurationMs: number,
): OverlayTimelineRange {
  if (
    !Number.isFinite(sourceDeltaMs) ||
    !isValidOrigin(origin, sourceDurationMs)
  ) {
    return origin
  }
  if (sourceDeltaMs === 0) {
    return origin
  }

  if (kind === 'move') {
    const durationMs = origin.endSourceMs - origin.startSourceMs
    const proposedStartSourceMs = origin.startSourceMs + sourceDeltaMs
    if (proposedStartSourceMs <= 0) {
      return rangeOrOrigin(origin, 0, durationMs)
    }

    const latestStartSourceMs = sourceDurationMs - durationMs
    if (proposedStartSourceMs >= latestStartSourceMs) {
      // Assign the source end directly. Re-adding a decimal duration to the
      // clamped start can exceed EOF by one floating-point epsilon.
      return rangeOrOrigin(
        origin,
        latestStartSourceMs,
        sourceDurationMs,
      )
    }

    return rangeOrOrigin(
      origin,
      proposedStartSourceMs,
      proposedStartSourceMs + durationMs,
    )
  }

  if (kind === 'trim-start') {
    // Presets created near EOF may already be shorter than the configured
    // minimum. Preserve that duration as their floor instead of jumping them
    // to a range that cannot fit inside the source.
    const minimumDurationMs = Math.min(
      MIN_OVERLAY_DURATION_MS,
      origin.endSourceMs - origin.startSourceMs,
    )
    const startSourceMs = Math.min(
      origin.endSourceMs - minimumDurationMs,
      Math.max(0, origin.startSourceMs + sourceDeltaMs),
    )
    return rangeOrOrigin(origin, startSourceMs, origin.endSourceMs)
  }

  if (kind === 'trim-end') {
    const minimumDurationMs = Math.min(
      MIN_OVERLAY_DURATION_MS,
      origin.endSourceMs - origin.startSourceMs,
    )
    const endSourceMs = Math.min(
      sourceDurationMs,
      Math.max(
        origin.startSourceMs + minimumDurationMs,
        origin.endSourceMs + sourceDeltaMs,
      ),
    )
    return rangeOrOrigin(origin, origin.startSourceMs, endSourceMs)
  }

  return origin
}
