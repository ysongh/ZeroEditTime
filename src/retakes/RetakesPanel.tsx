// Phase-11 Part-N recommendation surface. This is intentionally a compact,
// controlled view: App owns analysis/state, while later parts add bounded
// playback, timeline markers, richer script UX, and full state copy.

import type { CSSProperties } from 'react'
import type {
  RetakeAnalysisProgress,
  RetakeAnalysisStatus,
} from './editorState'
import type {
  RetakeRecommendation,
  RetakeSeverity,
} from './recommendation'

export interface RetakesPanelProps {
  recommendations: readonly RetakeRecommendation[]
  analysisStatus: RetakeAnalysisStatus
  analysisProgress?: Readonly<RetakeAnalysisProgress>
  onAnalyze: () => void | Promise<void>
  onSeekSourceMs: (sourceMs: number) => void
  onDismiss: (id: string) => void
  onCopyScript: (script: string) => void | Promise<void>
}

const PANEL_STYLE: CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: '1px solid var(--border)',
  borderRadius: 8,
  textAlign: 'left',
}

const SEVERITY_BADGE_STYLE: CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  border: '1px solid',
  borderRadius: 999,
  fontSize: 12,
  lineHeight: 1.5,
  fontWeight: 500,
}

const SEVERITY_PRESENTATION = {
  suggestion: {
    label: 'Suggestion',
    style: {
      color: 'var(--text)',
      background: 'var(--code-bg)',
      borderColor: 'var(--border)',
    },
  },
  recommended: {
    label: 'Recommended',
    style: {
      color: 'var(--text-h)',
      background: 'var(--accent-bg)',
      borderColor: 'var(--accent-border)',
    },
  },
  'strongly-recommended': {
    label: 'Strongly recommended',
    style: {
      color: 'var(--text-h)',
      background: 'var(--accent-bg)',
      borderColor: 'var(--accent)',
      fontWeight: 600,
    },
  },
} as const satisfies Readonly<
  Record<RetakeSeverity, { label: string; style: CSSProperties }>
>

/** Format an ORIGINAL-SOURCE millisecond position for compact display. */
function formatRetakeSourceTime(sourceMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(sourceMs / 1_000))
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = String(totalMinutes % 60).padStart(2, '0')
  const hours = Math.floor(totalMinutes / 60)
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`
}

function recommendationSummary(openCount: number): string {
  if (openCount === 0) return '0 open recommendations.'
  return `${openCount} section${openCount === 1 ? '' : 's'} may be worth recording again.`
}

export default function RetakesPanel({
  recommendations,
  analysisStatus,
  analysisProgress,
  onAnalyze,
  onSeekSourceMs,
  onDismiss,
  onCopyScript,
}: RetakesPanelProps) {
  const openRecommendations = recommendations.filter(
    (recommendation) => recommendation.status === 'open',
  )
  const isAnalyzing = analysisStatus === 'analyzing'

  return (
    <section style={PANEL_STYLE} aria-labelledby="retakes-panel-heading">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 id="retakes-panel-heading" style={{ margin: 0 }}>
            Retakes
          </h2>
          <p style={{ marginTop: 4, fontSize: 14, opacity: 0.75 }}>
            {recommendationSummary(openRecommendations.length)}
          </p>
          {isAnalyzing && analysisProgress !== undefined && (
            <p role="status" style={{ marginTop: 4, fontSize: 13 }}>
              Checked {analysisProgress.completed} of {analysisProgress.total}{' '}
              sections…
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={isAnalyzing}
          onClick={() => void onAnalyze()}
        >
          {isAnalyzing ? 'Checking…' : 'Check for retakes'}
        </button>
      </div>

      {openRecommendations.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '12px 0 0',
            display: 'grid',
            gap: 10,
            maxHeight: '48vh',
            overflowY: 'auto',
          }}
        >
          {openRecommendations.map((recommendation) => {
            const severity = SEVERITY_PRESENTATION[recommendation.severity]
            const start = formatRetakeSourceTime(
              recommendation.startSourceMs,
            )
            const end = formatRetakeSourceTime(recommendation.endSourceMs)
            const suggestedScript = recommendation.suggestedScript
            return (
              <li key={recommendation.id}>
                <article
                  style={{
                    padding: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                >
                  <p style={{ fontSize: 13, opacity: 0.75 }}>
                    <span
                      style={{
                        ...SEVERITY_BADGE_STYLE,
                        ...severity.style,
                      }}
                    >
                      {severity.label}
                    </span>
                    {' · '}
                    <span
                      title={`Original source time: ${(recommendation.startSourceMs / 1_000).toFixed(3)}s–${(recommendation.endSourceMs / 1_000).toFixed(3)}s`}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {start} – {end}
                    </span>
                  </p>
                  <h3
                    style={{
                      margin: '4px 0 0',
                      color: 'var(--text-h)',
                      fontSize: 17,
                    }}
                  >
                    {recommendation.title}
                  </h3>
                  <p style={{ marginTop: 4, fontSize: 14 }}>
                    {recommendation.explanation}
                  </p>

                  {suggestedScript !== undefined && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'var(--code-bg)',
                      }}
                    >
                      <p
                        style={{
                          color: 'var(--text-h)',
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        Suggested retake
                      </p>
                      <p style={{ marginTop: 3, fontSize: 14 }}>
                        “{suggestedScript}”
                      </p>
                      <button
                        type="button"
                        onClick={() => void onCopyScript(suggestedScript)}
                        style={{ marginTop: 7 }}
                      >
                        Copy script
                      </button>
                    </div>
                  )}

                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      marginTop: 9,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        onSeekSourceMs(recommendation.startSourceMs)
                      }
                    >
                      Seek
                    </button>
                    <button
                      type="button"
                      onClick={() => onDismiss(recommendation.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
