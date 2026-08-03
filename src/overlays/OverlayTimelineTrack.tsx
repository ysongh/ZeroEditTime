import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { formatSourceTimestamp } from './inspector'
import {
  calculateOverlayTimingDraft,
  clientDeltaToSourceMs,
  fitOverlayTimelineHitArea,
  getOverlayTimelineGeometry,
  type OverlayTimelineEditKind,
  type OverlayTimelineRange,
} from './timeline'
import type { ImageOverlay, OverlayAsset } from './types'

export interface OverlayTimelineTrackProps {
  assets: readonly OverlayAsset[]
  overlays: readonly ImageOverlay[]
  selectedOverlayId: string | null
  sourceDurationMs: number
  playheadSourceMs: number
  onSelectOverlay: (id: string) => void
  onSeekSourceMs: (sourceMs: number) => void
  onCommitTiming: (id: string, range: OverlayTimelineRange) => void
  onBeginTimingEdit: () => void
}

interface TimingEditSession {
  overlayId: string
  pointerId: number
  kind: OverlayTimelineEditKind
  origin: OverlayTimelineRange
  startClientX: number
  trackWidthPx: number
  sourceDurationMs: number
  captureTarget: HTMLElement
}

interface TimingDraft {
  overlayId: string
  range: OverlayTimelineRange
}

const ROW_HEIGHT_PX = 32
const ROW_GAP_PX = 5
const TRACK_PADDING_PX = 6
const MIN_INTERACTION_WIDTH_PX = 72
const HANDLE_WIDTH_PX = 24
const KEYBOARD_STEP_MS = 100
const KEYBOARD_LARGE_STEP_MS = 1_000

const sectionStyle: CSSProperties = {
  marginTop: 8,
  textAlign: 'left',
}

function rangeFromOverlay(
  overlay: Readonly<ImageOverlay>,
): OverlayTimelineRange {
  return {
    startSourceMs: overlay.startSourceMs,
    endSourceMs: overlay.endSourceMs,
  }
}

function rangesEqual(
  a: Readonly<OverlayTimelineRange>,
  b: Readonly<OverlayTimelineRange>,
): boolean {
  return (
    a.startSourceMs === b.startSourceMs &&
    a.endSourceMs === b.endSourceMs
  )
}

function releasePointerCapture(session: TimingEditSession): void {
  try {
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId)
    }
  } catch {
    // The track can unmount while a captured pointer is still active.
  }
}

function rangeLabel(
  name: string,
  range: Readonly<OverlayTimelineRange>,
): string {
  return `${name}, ${formatSourceTimestamp(range.startSourceMs)} to ${formatSourceTimestamp(range.endSourceMs)}`
}

function draftAtClientX(
  session: Readonly<TimingEditSession>,
  clientX: number,
): OverlayTimelineRange {
  const sourceDeltaMs = clientDeltaToSourceMs(
    clientX - session.startClientX,
    session.trackWidthPx,
    session.sourceDurationMs,
  )
  return calculateOverlayTimingDraft(
    session.origin,
    session.kind,
    sourceDeltaMs,
    session.sourceDurationMs,
  )
}

export default function OverlayTimelineTrack({
  assets,
  overlays,
  selectedOverlayId,
  sourceDurationMs,
  playheadSourceMs,
  onSelectOverlay,
  onSeekSourceMs,
  onCommitTiming,
  onBeginTimingEdit,
}: OverlayTimelineTrackProps) {
  const headingId = useId()
  const hintId = useId()
  const trackRef = useRef<HTMLDivElement | null>(null)
  const editRef = useRef<TimingEditSession | null>(null)
  const [draft, setDraft] = useState<TimingDraft | null>(null)
  const [trackWidthPx, setTrackWidthPx] = useState(0)
  const hasOverlays = overlays.length > 0
  const assetNames = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset.name] as const)),
    [assets],
  )

  const cancelActiveEdit = useCallback((): boolean => {
    const session = editRef.current
    if (session === null) {
      return false
    }
    editRef.current = null
    releasePointerCapture(session)
    setDraft(null)
    return true
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && cancelActiveEdit()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (
        editRef.current !== null &&
        (event.key === 'Delete' || event.key === 'Backspace')
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [cancelActiveEdit])

  useEffect(() => {
    if (!hasOverlays) {
      return
    }
    const track = trackRef.current
    if (track === null) {
      return
    }

    const measure = () => setTrackWidthPx(track.clientWidth)
    const frameId = requestAnimationFrame(measure)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(track)
      return () => {
        cancelAnimationFrame(frameId)
        observer.disconnect()
      }
    }

    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', measure)
    }
  }, [hasOverlays])

  useEffect(() => {
    const session = editRef.current
    if (session === null) {
      return
    }
    const authoritative = overlays.find(
      (overlay) => overlay.id === session.overlayId,
    )
    if (
      authoritative === undefined ||
      authoritative.startSourceMs !== session.origin.startSourceMs ||
      authoritative.endSourceMs !== session.origin.endSourceMs ||
      sourceDurationMs !== session.sourceDurationMs
    ) {
      cancelActiveEdit()
    }
  }, [cancelActiveEdit, overlays, sourceDurationMs])

  useEffect(() => {
    return () => {
      const session = editRef.current
      editRef.current = null
      if (session !== null) {
        releasePointerCapture(session)
      }
    }
  }, [])

  function activateOverlay(
    overlayId: string,
    range: Readonly<OverlayTimelineRange>,
  ) {
    onSelectOverlay(overlayId)
    onBeginTimingEdit()
    onSeekSourceMs(range.startSourceMs)
  }

  function beginEdit(
    event: ReactPointerEvent<HTMLElement>,
    overlay: Readonly<ImageOverlay>,
    kind: OverlayTimelineEditKind,
  ) {
    event.stopPropagation()
    if (event.button !== 0 || editRef.current !== null) {
      return
    }

    const trackWidth = trackRef.current?.clientWidth
    if (
      trackWidth === undefined ||
      trackWidth <= 0 ||
      !Number.isFinite(sourceDurationMs) ||
      sourceDurationMs <= 0
    ) {
      return
    }

    event.preventDefault()
    const origin = rangeFromOverlay(overlay)
    // Delay persistent selection until pointer-up. If edit mode is active but
    // nothing is selected, mounting the inspector here would move this track
    // vertically underneath the captured pointer mid-gesture.
    onBeginTimingEdit()
    onSeekSourceMs(origin.startSourceMs)

    const captureTarget = event.currentTarget
    captureTarget.focus({ preventScroll: true })
    captureTarget.setPointerCapture(event.pointerId)
    const session: TimingEditSession = {
      overlayId: overlay.id,
      pointerId: event.pointerId,
      kind,
      origin,
      startClientX: event.clientX,
      trackWidthPx: trackWidth,
      sourceDurationMs,
      captureTarget,
    }
    editRef.current = session
    setDraft({ overlayId: overlay.id, range: origin })
  }

  function continueEdit(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current
    if (session === null || session.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setDraft({
      overlayId: session.overlayId,
      range: draftAtClientX(session, event.clientX),
    })
  }

  function finishEdit(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current
    if (session === null || session.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const range = draftAtClientX(session, event.clientX)
    editRef.current = null
    releasePointerCapture(session)
    setDraft(null)

    onSelectOverlay(session.overlayId)
    if (!rangesEqual(session.origin, range)) {
      onCommitTiming(session.overlayId, range)
      onSeekSourceMs(range.startSourceMs)
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current
    if (session !== null && session.pointerId === event.pointerId) {
      event.stopPropagation()
      cancelActiveEdit()
    }
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current
    if (
      session !== null &&
      session.pointerId === event.pointerId &&
      session.captureTarget === event.currentTarget
    ) {
      cancelActiveEdit()
    }
  }

  function handleKeyboardEdit(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    overlay: Readonly<ImageOverlay>,
    kind: OverlayTimelineEditKind,
  ) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (editRef.current !== null) {
      return
    }
    const step = event.shiftKey
      ? KEYBOARD_LARGE_STEP_MS
      : KEYBOARD_STEP_MS
    const sourceDeltaMs = event.key === 'ArrowLeft' ? -step : step
    const origin = rangeFromOverlay(overlay)
    const range = calculateOverlayTimingDraft(
      origin,
      kind,
      sourceDeltaMs,
      sourceDurationMs,
    )
    activateOverlay(overlay.id, origin)
    if (!rangesEqual(origin, range)) {
      onCommitTiming(overlay.id, range)
      onSeekSourceMs(range.startSourceMs)
    }
  }

  function handleKeyboardClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    overlay: Readonly<ImageOverlay>,
  ) {
    if (editRef.current !== null) {
      event.preventDefault()
      return
    }
    // Pointer activation is handled at pointer-down so drag and trim share the
    // same selection/seek path. `detail === 0` covers keyboard/AT activation.
    if (event.detail === 0) {
      activateOverlay(overlay.id, rangeFromOverlay(overlay))
    }
  }

  if (!hasOverlays) {
    return null
  }

  const trackHeight =
    TRACK_PADDING_PX * 2 +
    overlays.length * ROW_HEIGHT_PX +
    Math.max(0, overlays.length - 1) * ROW_GAP_PX
  const playheadFraction =
    Number.isFinite(sourceDurationMs) && sourceDurationMs > 0
      ? Math.min(1, Math.max(0, playheadSourceMs / sourceDurationMs))
      : 0
  const activeSelectedId = draft?.overlayId ?? selectedOverlayId

  return (
    <section style={sectionStyle} aria-labelledby={headingId}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 5,
        }}
      >
        <h2 id={headingId} style={{ margin: 0, fontSize: 14 }}>
          Image overlays
        </h2>
        <span id={hintId} style={{ fontSize: 12, color: 'var(--text)' }}>
          Drag to move · drag either edge to trim · Shift+Arrow moves 1s
        </span>
      </div>

      <div
        ref={trackRef}
        role="group"
        aria-label="Image overlay source-time track"
        aria-describedby={hintId}
        style={{
          position: 'relative',
          width: '100%',
          height: trackHeight,
          overflow: 'hidden',
          boxSizing: 'border-box',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--code-bg)',
          userSelect: 'none',
        }}
      >
        {overlays.map((overlay, index) => {
          const authoritativeRange = rangeFromOverlay(overlay)
          const displayedRange =
            draft?.overlayId === overlay.id
              ? draft.range
              : authoritativeRange
          const geometry = getOverlayTimelineGeometry(
            displayedRange,
            sourceDurationMs,
          )
          if (geometry === null) {
            return null
          }

          const hitArea = fitOverlayTimelineHitArea(
            geometry,
            trackWidthPx,
            MIN_INTERACTION_WIDTH_PX,
          )
          const handleWidthPx =
            hitArea === null
              ? HANDLE_WIDTH_PX
              : Math.min(HANDLE_WIDTH_PX, hitArea.widthPx / 3)

          const name = assetNames.get(overlay.assetId) ?? 'Image overlay'
          const accessibleName = `${name}, image overlay ${index + 1} of ${overlays.length}`
          const label = rangeLabel(accessibleName, displayedRange)
          const selected = activeSelectedId === overlay.id
          const commonPointerHandlers = {
            onPointerMove: continueEdit,
            onPointerUp: finishEdit,
            onPointerCancel: handlePointerCancel,
            onLostPointerCapture: handleLostPointerCapture,
          }

          return (
            <div
              key={overlay.id}
              role="group"
              aria-label={label}
              style={{
                position: 'absolute',
                top:
                  TRACK_PADDING_PX + index * (ROW_HEIGHT_PX + ROW_GAP_PX),
                left:
                  hitArea === null
                    ? `${geometry.leftFraction * 100}%`
                    : hitArea.leftPx,
                width:
                  hitArea === null
                    ? `${geometry.widthFraction * 100}%`
                    : hitArea.widthPx,
                height: ROW_HEIGHT_PX,
                minWidth: 0,
                overflow: 'hidden',
                boxSizing: 'border-box',
                border: selected
                  ? '2px solid var(--accent)'
                  : '1px solid var(--accent-border)',
                borderRadius: 4,
                background: 'var(--accent-bg)',
              }}
            >
              {hitArea !== null && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    zIndex: 0,
                    top: 3,
                    bottom: 3,
                    left: hitArea.contentLeftPx,
                    width: Math.max(2, hitArea.contentWidthPx),
                    borderInline: '1px solid var(--accent)',
                    boxSizing: 'border-box',
                    background: 'var(--accent-border)',
                    pointerEvents: 'none',
                  }}
                />
              )}
              <button
                type="button"
                aria-label={`Select and move ${label}`}
                aria-pressed={selected}
                aria-describedby={hintId}
                aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
                title={`${label}. Drag to move; Arrow keys move by 0.1 seconds.`}
                onPointerDown={(event) => beginEdit(event, overlay, 'move')}
                onClick={(event) => handleKeyboardClick(event, overlay)}
                onKeyDown={(event) =>
                  handleKeyboardEdit(event, overlay, 'move')
                }
                {...commonPointerHandlers}
                style={{
                  position: 'absolute',
                  zIndex: 1,
                  top: 0,
                  right: handleWidthPx,
                  bottom: 0,
                  left: handleWidthPx,
                  display: 'block',
                  margin: 0,
                  padding: '0 3px',
                  overflow: 'hidden',
                  border: 0,
                  borderRadius: 0,
                  background: 'transparent',
                  color: 'var(--text-h)',
                  cursor: 'grab',
                  touchAction: 'none',
                  textAlign: 'left',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  outlineOffset: -2,
                }}
              >
                {name}
              </button>

              <button
                type="button"
                aria-label={`Trim start of ${label}`}
                aria-describedby={hintId}
                aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
                title={`Trim start of ${name}; Arrow keys trim by 0.1 seconds.`}
                onPointerDown={(event) =>
                  beginEdit(event, overlay, 'trim-start')
                }
                onClick={(event) => handleKeyboardClick(event, overlay)}
                onKeyDown={(event) =>
                  handleKeyboardEdit(event, overlay, 'trim-start')
                }
                {...commonPointerHandlers}
                style={{
                  position: 'absolute',
                  zIndex: 2,
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: handleWidthPx,
                  margin: 0,
                  padding: 0,
                  border: 0,
                  borderRight: '2px solid var(--accent)',
                  borderRadius: '3px 0 0 3px',
                  background: 'var(--accent-border)',
                  cursor: 'ew-resize',
                  touchAction: 'none',
                  outlineOffset: -2,
                }}
              />

              <button
                type="button"
                aria-label={`Trim end of ${label}`}
                aria-describedby={hintId}
                aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
                title={`Trim end of ${name}; Arrow keys trim by 0.1 seconds.`}
                onPointerDown={(event) =>
                  beginEdit(event, overlay, 'trim-end')
                }
                onClick={(event) => handleKeyboardClick(event, overlay)}
                onKeyDown={(event) =>
                  handleKeyboardEdit(event, overlay, 'trim-end')
                }
                {...commonPointerHandlers}
                style={{
                  position: 'absolute',
                  zIndex: 2,
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: handleWidthPx,
                  margin: 0,
                  padding: 0,
                  border: 0,
                  borderLeft: '2px solid var(--accent)',
                  borderRadius: '0 3px 3px 0',
                  background: 'var(--accent-border)',
                  cursor: 'ew-resize',
                  touchAction: 'none',
                  outlineOffset: -2,
                }}
              />
            </div>
          )
        })}

        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            zIndex: 3,
            top: 0,
            bottom: 0,
            left: `${playheadFraction * 100}%`,
            width: 2,
            background: 'var(--text-h)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </section>
  )
}
