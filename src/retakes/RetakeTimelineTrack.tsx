import type { CSSProperties } from 'react'
import type { RetakeRecommendation } from './recommendation'

export interface RetakeTimelineTrackProps {
  recommendations: readonly RetakeRecommendation[]
  selectedRecommendationId: string | null
  sourceDurationMs: number
  onSelectRecommendation: (id: string) => void
  onSeekSourceMs: (sourceMs: number) => void
}

const MARKER_WIDTH_PX = 24

function formatSourceTime(sourceMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(sourceMs / 1_000))
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = String(totalMinutes % 60).padStart(2, '0')
  const hours = Math.floor(totalMinutes / 60)
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`
}

function markerPosition(
  sourceMs: number,
  sourceDurationMs: number,
): Pick<CSSProperties, 'left' | 'transform'> {
  const safeSourceMs = Number.isFinite(sourceMs) ? sourceMs : 0
  const fraction = Math.min(
    1,
    Math.max(0, safeSourceMs / sourceDurationMs),
  )

  if (fraction === 0) {
    return { left: '0%', transform: 'translateX(0)' }
  }
  if (fraction === 1) {
    return { left: '100%', transform: 'translateX(-100%)' }
  }
  return {
    left: `${fraction * 100}%`,
    transform: 'translateX(-50%)',
  }
}

/** A compact, read-only source-time lane for actionable retake advice. */
export default function RetakeTimelineTrack({
  recommendations,
  selectedRecommendationId,
  sourceDurationMs,
  onSelectRecommendation,
  onSeekSourceMs,
}: RetakeTimelineTrackProps) {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    return null
  }

  const openRecommendations = recommendations.filter(
    (recommendation) => recommendation.status === 'open',
  )
  if (openRecommendations.length === 0) {
    return null
  }

  return (
    <section style={{ marginTop: 8, textAlign: 'left' }}>
      <h2 style={{ margin: '0 0 5px', fontSize: 14 }}>Retakes</h2>
      <div
        role="group"
        aria-label="Retake recommendation source-time markers"
        style={{
          position: 'relative',
          width: '100%',
          height: 30,
          boxSizing: 'border-box',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--code-bg)',
        }}
      >
        {openRecommendations.map((recommendation) => {
          const selected = recommendation.id === selectedRecommendationId
          const start = formatSourceTime(recommendation.startSourceMs)
          const end = formatSourceTime(recommendation.endSourceMs)
          return (
            <button
              key={recommendation.id}
              type="button"
              aria-label={`${recommendation.title}, ${start} to ${end} source time`}
              aria-pressed={selected}
              title={`${recommendation.title} · ${start}–${end}`}
              onClick={() => {
                onSelectRecommendation(recommendation.id)
                onSeekSourceMs(recommendation.startSourceMs)
              }}
              style={{
                position: 'absolute',
                top: 2,
                width: MARKER_WIDTH_PX,
                height: 24,
                padding: 0,
                lineHeight: 1,
                color: selected ? 'var(--text-h)' : 'var(--accent)',
                background: selected ? 'var(--accent-bg)' : 'transparent',
                border: selected
                  ? '1px solid var(--accent)'
                  : '1px solid transparent',
                borderRadius: 4,
                cursor: 'pointer',
                ...markerPosition(
                  recommendation.startSourceMs,
                  sourceDurationMs,
                ),
              }}
            >
              <span aria-hidden="true">▲</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
