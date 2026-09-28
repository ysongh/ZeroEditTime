// Phase-11 Part-N recommendation surface. This is intentionally a compact,
// controlled view: App owns analysis, advisory state, and bounded source
// playback; the sibling Part-Q track owns markers, Part R completes the
// suggested-script/resolved workflow, and Part T supplies aggregate outcomes.
// Part V adds contextual names, announcements, and keyboard focus handling.

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
import Icon from '../ui/Icon'

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

const SEVERITY_PRESENTATION = {
  suggestion: { label: 'Suggestion', className: 'tag' },
  recommended: { label: 'Recommended', className: 'tag tag--accent' },
  'strongly-recommended': {
    label: 'Strongly recommended',
    className: 'tag tag--strong',
  },
} as const satisfies Readonly<
  Record<RetakeSeverity, { label: string; className: string }>
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
    <section className="retakes-panel" aria-labelledby="retakes-panel-heading">
      {/* The tab names this panel visually; the heading stays for AT and focus. */}
      <h2 id="retakes-panel-heading" tabIndex={-1} className="sr-only">
        Retakes
      </h2>

      <div className="retakes-panel__summary">
        <div
          className="retakes-panel__status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {showSuccessfulEmptyState ? (
            <>
              <p className="retakes-panel__status-strong">
                No retakes recommended
              </p>
              <p className="retakes-panel__detail">
                The sections we checked appear fixable through normal editing.
              </p>
            </>
          ) : (
            <p>{recommendationSummary(openRecommendations.length)}</p>
          )}
          {isAnalyzing && (
            <p className="retakes-panel__detail">
              {analysisProgress === undefined
                ? 'Checking for retakes…'
                : `Checked ${checkedCount} of ${analysisProgress.total} sections…`}
            </p>
          )}
          {showPartialResult && (
            <p className="retakes-panel__detail">
              Checked {analysisProgress.total} sections.{' '}
              {analysisProgress.completed} completed; {failedCount} could not
              be analyzed.
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn--outline"
          data-retake-analyze
          aria-label={isAnalyzing ? 'Checking for retakes' : undefined}
          disabled={isAnalyzing}
          onClick={() => void onAnalyze()}
        >
          <Icon name="search" />
          {isAnalyzing ? 'Checking…' : 'Check for Retakes'}
        </button>
      </div>

      {analysisStatus === 'idle' && openRecommendations.length === 0 && (
        <p className="panel-note">
          Finds stumbles and false starts that may be worth recording again.
          Advice only: checking never changes your edit.
        </p>
      )}

      {analysisStatus === 'error' && (
        <div role="alert" className="retakes-panel__error">
          <strong>Couldn’t check for retakes.</strong>
          <p>{errorMessage}</p>
        </div>
      )}

      {openRecommendations.length > 0 && (
        <ul className="retake-list">
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
                  className={
                    recommendation.severity === 'suggestion'
                      ? 'retake-card retake-card--suggestion'
                      : 'retake-card'
                  }
                >
                  <p className="retake-card__meta">
                    <span className={severity.className}>{severity.label}</span>
                    <span className="retake-card__sep">{' · '}</span>
                    <span
                      aria-hidden="true"
                      className="retake-card__time"
                      title={`Original source time: ${(recommendation.startSourceMs / 1_000).toFixed(3)}s–${(recommendation.endSourceMs / 1_000).toFixed(3)}s`}
                    >
                      {start} – {end}
                    </span>
                    <span className="retake-sr-only">{spokenRange}.</span>
                  </p>
                  <h3 id={`${cardId}-heading`}>{recommendation.title}</h3>
                  <p className="retake-card__explanation">
                    {recommendation.explanation}
                  </p>

                  {suggestedScript !== undefined && (
                    <div className="retake-card__script">
                      <p className="retake-card__script-label">
                        Suggested retake
                      </p>
                      <p className="retake-card__script-text">
                        “{suggestedScript}”
                      </p>
                      <div className="retake-card__copy">
                        <button
                          type="button"
                          className="link-btn"
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
                          className="retake-card__copy-status"
                          role="status"
                          aria-live="polite"
                          aria-atomic="true"
                        >
                          {copyStatus === 'copying'
                            ? 'Copying…'
                            : copyStatus === 'copied'
                              ? 'Copied.'
                              : ''}
                        </span>
                        <span
                          id={`${cardId}-copy-error`}
                          className="error-text"
                          role="alert"
                          aria-atomic="true"
                        >
                          {copyStatus === 'error'
                            ? 'Couldn’t copy script. Try again.'
                            : ''}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="retake-card__actions">
                    <button
                      type="button"
                      className="btn btn--primary"
                      data-retake-play
                      aria-label={`Play ${actionContext}`}
                      onClick={() =>
                        onPlaySourceRange(
                          recommendation.startSourceMs,
                          recommendation.endSourceMs,
                        )
                      }
                    >
                      <Icon name="play" size={14} />
                      Play
                    </button>
                    <button
                      type="button"
                      className="btn btn--outline"
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
                      className="btn btn--outline"
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
