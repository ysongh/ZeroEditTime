import type { CSSProperties, MouseEvent } from 'react'
import type { EDL } from './edl/types'

// One-track timeline. Rendered one-way from the EDL: kept segments are filled
// blocks against the full source duration, removed ranges show as gaps. A click
// maps a pixel position back to a source time and asks the parent to seek.

type TimelineProps = {
  edl: EDL
  /** Current playhead, in source seconds. */
  playhead: number
  /** Selection in/out points, in source seconds (null when unset). */
  inPoint: number | null
  outPoint: number | null
  onSeek: (sourceTime: number) => void
}

const TRACK_HEIGHT = 56

export default function Timeline({
  edl,
  playhead,
  inPoint,
  outPoint,
  onSeek,
}: TimelineProps) {
  const duration = edl.source.duration
  const pct = (t: number): string => `${duration > 0 ? (t / duration) * 100 : 0}%`

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (duration <= 0) {
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - rect.left) / rect.width
    const clamped = Math.min(1, Math.max(0, fraction))
    onSeek(clamped * duration)
  }

  const selection =
    inPoint !== null && outPoint !== null && inPoint !== outPoint
      ? { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
      : null

  const trackStyle: CSSProperties = {
    position: 'relative',
    height: TRACK_HEIGHT,
    width: '100%',
    background: 'var(--code-bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    cursor: 'pointer',
    userSelect: 'none',
  }

  const markerStyle = (t: number, color: string): CSSProperties => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: pct(t),
    width: 2,
    background: color,
    pointerEvents: 'none',
  })

  return (
    <div style={trackStyle} onClick={handleClick} title="Click to seek">
      {edl.segments.map((seg) => (
        <div
          key={seg.id}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: pct(seg.start),
            width: pct(seg.end - seg.start),
            background: 'var(--accent-bg)',
            borderInline: '1px solid var(--accent-border)',
            boxSizing: 'border-box',
          }}
        />
      ))}

      {selection !== null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: pct(selection.start),
            width: pct(selection.end - selection.start),
            background: 'var(--accent-bg)',
            pointerEvents: 'none',
          }}
        />
      )}

      {inPoint !== null && <div style={markerStyle(inPoint, 'var(--accent)')} />}
      {outPoint !== null && <div style={markerStyle(outPoint, 'var(--accent)')} />}

      <div style={markerStyle(playhead, 'var(--text-h)')} />
    </div>
  )
}
