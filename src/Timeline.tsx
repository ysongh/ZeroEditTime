import { Fragment } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import type { EDL } from './edl/types'
import {
  removedRanges,
  rulerTicks,
  speechActivity,
  splitPoints,
  type SourceRange,
} from './timelineScale'
import { formatClock, formatShortClock } from './ui/time'

// One-track timeline. Rendered one-way from the EDL: kept segments are blocks on
// the full source duration and removed ranges are hatched. Pointer positions map
// back to source time and ask the parent to seek; nothing here edits the EDL.

type TimelineProps = {
  edl: EDL
  /** Current playhead, in source seconds. */
  playhead: number
  /** Selection in/out points, in source seconds (null when unset). */
  inPoint: number | null
  outPoint: number | null
  onSeek: (sourceTime: number) => void
  /** Double-clicking a kept segment proposes it as the In/Out selection. */
  onSelectRange?: (start: number, end: number) => void
  /** Transcript word timings, drawn as speech-activity bars when present. */
  speech?: readonly SourceRange[]
}

const SPEECH_BARS = 160
/** Segments narrower than this fraction of the source hide their number. */
const LABEL_MIN_FRACTION = 0.04
const KEY_STEP_SECONDS = 1
const KEY_STEP_LARGE_SECONDS = 5

function segmentLabel(index: number): string {
  return String(index + 1).padStart(2, '0')
}

export default function Timeline({
  edl,
  playhead,
  inPoint,
  outPoint,
  onSeek,
  onSelectRange,
  speech = [],
}: TimelineProps) {
  const duration = edl.source.duration
  const hasDuration = Number.isFinite(duration) && duration > 0
  const fraction = (t: number): number =>
    hasDuration ? Math.min(1, Math.max(0, t / duration)) : 0
  const pct = (t: number): string => `${fraction(t) * 100}%`

  function timeAtPointer(
    event: Pick<PointerEvent<HTMLDivElement>, 'clientX' | 'currentTarget'>,
  ): number | null {
    if (!hasDuration) {
      return null
    }
    const rect = event.currentTarget.getBoundingClientRect()
    if (!(rect.width > 0)) {
      return null
    }
    const position = (event.clientX - rect.left) / rect.width
    return Math.min(1, Math.max(0, position)) * duration
  }

  function seekToPointer(event: PointerEvent<HTMLDivElement>) {
    const time = timeAtPointer(event)
    if (time !== null) {
      onSeek(time)
    }
  }

  // Capture keeps a drag scrubbing even when the pointer leaves the track.
  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    seekToPointer(event)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      seekToPointer(event)
    }
  }

  // Resolved on the track itself: pointer capture retargets the clicks there.
  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    const time = timeAtPointer(event)
    if (time === null || onSelectRange === undefined) {
      return
    }
    const segment = edl.segments.find(
      (seg) => time >= seg.start && time < seg.end,
    )
    if (segment !== undefined) {
      onSelectRange(segment.start, segment.end)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!hasDuration) {
      return
    }
    const step = event.shiftKey ? KEY_STEP_LARGE_SECONDS : KEY_STEP_SECONDS
    let next: number
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = playhead - step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        next = playhead + step
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = duration
        break
      default:
        return
    }
    event.preventDefault()
    onSeek(Math.min(duration, Math.max(0, next)))
  }

  const selection =
    inPoint !== null && outPoint !== null && inPoint !== outPoint
      ? { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
      : null
  const bars =
    speech.length > 0 ? speechActivity(speech, duration, SPEECH_BARS) : []

  return (
    <div
      className="timeline"
      role="slider"
      tabIndex={0}
      aria-label="Timeline playhead"
      aria-valuemin={0}
      aria-valuemax={hasDuration ? duration : 0}
      aria-valuenow={playhead}
      aria-valuetext={formatClock(playhead)}
      title="Drag to scrub"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <div className="timeline__ruler" aria-hidden="true">
        {rulerTicks(duration).map((tick) => {
          const at = fraction(tick.time)
          return (
            <Fragment key={tick.time}>
              <div
                className={
                  tick.major
                    ? 'timeline__tick timeline__tick--major'
                    : 'timeline__tick'
                }
                style={{ left: pct(tick.time) }}
              />
              {tick.major && (
                <span
                  className="timeline__tick-label"
                  style={{
                    left: pct(tick.time),
                    transform:
                      at === 0
                        ? 'none'
                        : at > 0.97
                          ? 'translateX(-100%)'
                          : 'translateX(-50%)',
                  }}
                >
                  {formatShortClock(tick.time)}
                </span>
              )}
            </Fragment>
          )
        })}
      </div>

      <div className="timeline__track">
        {edl.segments.map((seg, index) => (
          <div
            key={seg.id}
            className="timeline__segment"
            title={`Segment ${index + 1} · ${formatClock(seg.start)} – ${formatClock(seg.end)}`}
            style={{ left: pct(seg.start), width: pct(seg.end - seg.start) }}
          >
            {fraction(seg.end - seg.start) > LABEL_MIN_FRACTION && (
              <span className="timeline__segment-label">
                {segmentLabel(index)}
              </span>
            )}
          </div>
        ))}

        {bars.length > 0 && (
          <div className="timeline__speech" aria-hidden="true">
            {bars.map((value, index) => (
              <span
                key={index}
                style={{ height: `${value > 0 ? 25 + 75 * value : 6}%` }}
              />
            ))}
          </div>
        )}

        {removedRanges(edl).map((range) => (
          <div
            key={`cut_${range.start}`}
            className="timeline__cut"
            style={{ left: pct(range.start), width: pct(range.end - range.start) }}
          />
        ))}

        {splitPoints(edl).map((point) => (
          <div
            key={`split_${point}`}
            className="timeline__split"
            style={{ left: pct(point) }}
          />
        ))}

        {selection !== null && (
          <div
            className="timeline__range"
            style={{
              left: pct(selection.start),
              width: pct(selection.end - selection.start),
            }}
          />
        )}
      </div>

      {inPoint !== null && (
        <div
          className="timeline__mark timeline__mark--in"
          style={{ left: pct(inPoint) }}
        >
          <span aria-hidden="true">IN</span>
        </div>
      )}
      {outPoint !== null && (
        <div
          className="timeline__mark timeline__mark--out"
          style={{ left: pct(outPoint) }}
        >
          <span aria-hidden="true">OUT</span>
        </div>
      )}

      <div className="timeline__playhead" style={{ left: pct(playhead) }} />
    </div>
  )
}
