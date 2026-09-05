// Phase-11 Part-N recommendation surface. This is intentionally a compact,
// controlled view: App owns analysis, advisory state, and bounded source
// playback; the sibling Part-Q track owns markers, Part R completes the
// suggested-script/resolved workflow, and Part T supplies aggregate outcomes.
// Part V adds contextual names, announcements, and keyboard focus handling.

import type { CSSProperties } from 'react'
import type {
  RetakeAnalysisProgress,
  RetakeAnalysisStatus,
} from './editorState'
import type {
  RetakeRecommendation,
  RetakeSeverity,
} from './recommendation'
import {
  formatRetakeSourceRangeForSpeech,
  formatRetakeSourceTime,
} from './sourceTime'

export type RetakeScriptCopyStatus = 'copying' | 'copied' | 'error'

export interface RetakeScriptCopyFeedback {
  recommendationId: string
  status: RetakeScriptCopyStatus
}

export interface RetakesPanelProps {
  recommendations: readonly RetakeRecommendation[]
  analysisStatus: RetakeAnalysisStatus
  analysisProgress?: Readonly<RetakeAnalysisProgress>
  analysisError?: string
  hasSuccessfulEmptyAnalysis: boolean
  onAnalyze: () => void | Promise<void>
  onPlaySourceRange: (
    startSourceMs: number,
    endSourceMs: number,
  ) => void | Promise<void>
  copyFeedback: Readonly<RetakeScriptCopyFeedback> | null
  onDismiss: (id: string) => void
  onResolve: (id: string) => void
  onCopyScript: (id: string, script: string) => void | Promise<void>
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

function recommendationSummary(openCount: number): string {
  if (openCount === 0) return '0 open recommendations.'
  return `${openCount} section${openCount === 1 ? '' : 's'} may be worth recording again.`
}

/** Keep keyboard navigation in the panel when its focused card is removed. */
function focusAfterRemovingCard(button: HTMLButtonElement): void {
  if (button.ownerDocument.activeElement !== button) return

  const item = button.closest('li')
  const panel = button.closest('section')
  const target =
    item?.nextElementSibling?.querySelector<HTMLButtonElement>(
      'button[data-retake-play]',
    ) ??
    item?.previousElementSibling?.querySelector<HTMLButtonElement>(
      'button[data-retake-play]',
    ) ??
    panel?.querySelector<HTMLButtonElement>(
      'button[data-retake-analyze]:not(:disabled)',
    ) ??
    panel?.querySelector<HTMLHeadingElement>('h2')
  target?.focus()
}

export default function RetakesPanel({
  recommendations,
  analysisStatus,
  analysisProgress,
  analysisError,
  hasSuccessfulEmptyAnalysis,
  onAnalyze,
  onPlaySourceRange,
  copyFeedback,
  onDismiss,
  onResolve,
  onCopyScript,
}: RetakesPanelProps) {
  const openRecommendations = recommendations.filter(
    (recommendation) => recommendation.status === 'open',
  )
  const isAnalyzing = analysisStatus === 'analyzing'
  const failedCount = analysisProgress?.failed ?? 0
  const checkedCount =
    (analysisProgress?.completed ?? 0) + failedCount
  const showPartialResult =
    analysisStatus === 'complete' &&
    analysisProgress !== undefined &&
    failedCount > 0
  const showSuccessfulEmptyState =
    hasSuccessfulEmptyAnalysis &&
    analysisStatus === 'complete' &&
    recommendations.length === 0 &&
    failedCount === 0
  const errorMessage = analysisError?.trim() || 'Try again.'

  return (
    <section
      className="retakes-panel"
      style={PANEL_STYLE}
      aria-labelledby="retakes-panel-heading"
    >
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
          <h2 id="retakes-panel-heading" tabIndex={-1} style={{ margin: 0 }}>
            Retakes
          </h2>
          <div role="status" aria-live="polite" aria-atomic="true">
            {showSuccessfulEmptyState ? (
              <div style={{ marginTop: 6 }}>
                <p
                  style={{
                    color: 'var(--text-h)',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  No retakes recommended
                </p>
                <p style={{ marginTop: 3, fontSize: 14 }}>
                  The sections we checked appear fixable through normal editing.
                </p>
              </div>
            ) : (
              <p style={{ marginTop: 4, fontSize: 14 }}>
                {recommendationSummary(openRecommendations.length)}
              </p>
            )}
            {isAnalyzing && (
              <p style={{ marginTop: 4, fontSize: 13 }}>
                {analysisProgress === undefined
                  ? 'Checking for retakes…'
                  : `Checked ${checkedCount} of ${analysisProgress.total} sections…`}
              </p>
            )}
            {showPartialResult && (
              <p style={{ marginTop: 4, fontSize: 13 }}>
                Checked {analysisProgress.total} sections.{' '}
                {analysisProgress.completed} completed; {failedCount} could not
                be analyzed.
              </p>
            )}
          </div>
          {analysisStatus === 'error' && (
            <div
              role="alert"
              style={{ marginTop: 6, fontSize: 13, color: 'crimson' }}
            >
              <p style={{ fontWeight: 600 }}>Couldn’t check for retakes.</p>
              <p style={{ marginTop: 2 }}>{errorMessage}</p>
            </div>
          )}
        </div>
        <button
          type="button"
          data-retake-analyze
          aria-label={isAnalyzing ? 'Checking for retakes' : undefined}
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
            const spokenRange = formatRetakeSourceRangeForSpeech(
              recommendation.startSourceMs,
              recommendation.endSourceMs,
            )
            const actionContext = `${recommendation.title}. ${spokenRange}.`
            const cardId = `retake-card-${encodeURIComponent(recommendation.id)}`
            const suggestedScript = recommendation.suggestedScript
            const copyStatus =
              copyFeedback?.recommendationId === recommendation.id
                ? copyFeedback.status
                : null
            return (
              <li key={recommendation.id}>
                <article
                  aria-labelledby={`${cardId}-heading`}
                  style={{
                    padding: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                >
                  <p style={{ fontSize: 13 }}>
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
                      aria-hidden="true"
                      title={`Original source time: ${(recommendation.startSourceMs / 1_000).toFixed(3)}s–${(recommendation.endSourceMs / 1_000).toFixed(3)}s`}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {start} – {end}
                    </span>
                    <span className="retake-sr-only">
                      {spokenRange}.
                    </span>
                  </p>
                  <h3
                    id={`${cardId}-heading`}
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
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 7,
                          marginTop: 7,
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Copy script for ${actionContext}`}
                          aria-describedby={`${cardId}-copy-status ${cardId}-copy-error`}
                          disabled={copyStatus === 'copying'}
                          onClick={() =>
                            void onCopyScript(
                              recommendation.id,
                              suggestedScript,
                            )
                          }
                        >
                          Copy script
                        </button>
                        <span
                          id={`${cardId}-copy-status`}
                          role="status"
                          aria-live="polite"
                          aria-atomic="true"
                          style={{ fontSize: 13 }}
                        >
                          {copyStatus === 'copying'
                            ? 'Copying…'
                            : copyStatus === 'copied'
                              ? 'Copied.'
                              : ''}
                        </span>
                        <span
                          id={`${cardId}-copy-error`}
                          role="alert"
                          aria-atomic="true"
                          style={{ fontSize: 13 }}
                        >
                          {copyStatus === 'error'
                            ? 'Couldn’t copy script. Try again.'
                            : ''}
                        </span>
                      </div>
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
                      data-retake-play
                      aria-label={`Play ${actionContext}`}
                      onClick={() =>
                        onPlaySourceRange(
                          recommendation.startSourceMs,
                          recommendation.endSourceMs,
                        )
                      }
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      aria-label={`Dismiss ${actionContext}`}
                      onClick={(event) => {
                        focusAfterRemovingCard(event.currentTarget)
                        onDismiss(recommendation.id)
                      }}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      aria-label={`Mark as re-recorded: ${actionContext}`}
                      onClick={(event) => {
                        focusAfterRemovingCard(event.currentTarget)
                        onResolve(recommendation.id)
                      }}
                    >
                      Mark as re-recorded
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
