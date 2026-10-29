// Controlled clarity review surface. App owns analysis, selection and playback;
// this component only renders their current state and forwards explicit actions.

import Icon from '../ui/Icon'
import { formatClock, formatSeconds } from '../ui/time'
import type { ClarityReason } from './analysis'
import type { ClarityDraft, ClarityReviewSuggestion } from './review'

export interface ClarityPanelProps {
  draft: ClarityDraft
  onDraftChange: (draft: ClarityDraft) => void
  availability: 'ready' | 'unavailable' | 'invalid' | 'oversized'
  message?: string
  status: 'idle' | 'analyzing' | 'complete' | 'error'
  error?: string
  suggestions: readonly ClarityReviewSuggestion[]
  currentDurationSeconds: number
  proposedDurationSeconds: number | null
  targetDurationSeconds?: number
  onAnalyze: () => void | Promise<void>
  onSelect: (sentenceId: string, selected: boolean) => void
  onPlaySentence: (sentenceId: string) => void | Promise<void>
  onDiscard: () => void
}

const REASON_LABELS: Record<ClarityReason, string> = {
  'repeated-explanation': 'Repeated explanation',
  'off-topic-detail': 'Off-topic detail',
  'redundant-example': 'Redundant example',
  'excessive-introduction': 'Excessive introduction',
}

const AVAILABILITY_MESSAGES = {
  ready: '',
  unavailable: 'Load a video and transcribe it to suggest clarity edits.',
  invalid: 'Check the analysis settings and transcript before continuing.',
  oversized: 'This transcript is too large for one clarity analysis.',
} as const

export default function ClarityPanel({
  draft,
  onDraftChange,
  availability,
  message,
  status,
  error,
  suggestions,
  currentDurationSeconds,
  proposedDurationSeconds,
  targetDurationSeconds,
  onAnalyze,
  onSelect,
  onPlaySentence,
  onDiscard,
}: ClarityPanelProps) {
  const isAnalyzing = status === 'analyzing'
  const isReady = availability === 'ready'
  const showResult = isReady && status === 'complete'
  const selectedCount = suggestions.filter((suggestion) => suggestion.selected).length
  const feedback = message?.trim() || AVAILABILITY_MESSAGES[availability]
  const showProposedDuration = showResult && proposedDurationSeconds !== null
  const targetNotReached =
    showProposedDuration &&
    targetDurationSeconds !== undefined &&
    proposedDurationSeconds > targetDurationSeconds + 1e-9

  return (
    <section className="clarity-panel" aria-labelledby="clarity-panel-heading">
      <h2 id="clarity-panel-heading" tabIndex={-1} className="sr-only">
        Clarity
      </h2>
      <p className="panel-note">
        Find repeated explanations, tangents, and redundant examples. Review
        suggestions before changing your edit.
      </p>

      <div className="clarity-panel__settings">
        <label className="clarity-panel__field" htmlFor="clarity-target-duration">
          <span>Target duration (seconds) <span className="clarity-panel__optional">Optional</span></span>
          <input
            id="clarity-target-duration"
            className="text-input clarity-panel__input clarity-panel__input--duration"
            type="text"
            inputMode="decimal"
            value={draft.targetDuration}
            placeholder="e.g. 60"
            aria-describedby="clarity-target-hint clarity-panel-status"
            onChange={(event) => onDraftChange({ ...draft, targetDuration: event.target.value })}
          />
          <span id="clarity-target-hint" className="clarity-panel__hint">
            A guide for suggestions; coherence comes first.
          </span>
        </label>
        <label className="clarity-panel__field" htmlFor="clarity-audience">
          <span>Audience <span className="clarity-panel__optional">Optional</span></span>
          <input
            id="clarity-audience"
            className="text-input clarity-panel__input"
            type="text"
            value={draft.audience}
            placeholder="e.g. Developers trying the product"
            aria-describedby="clarity-panel-status"
            onChange={(event) => onDraftChange({ ...draft, audience: event.target.value })}
          />
        </label>
        <label className="clarity-panel__field" htmlFor="clarity-must-stay">
          <span>What must stay? <span className="clarity-panel__optional">Optional</span></span>
          <textarea
            id="clarity-must-stay"
            className="text-input clarity-panel__input clarity-panel__instructions"
            rows={3}
            value={draft.mustStay}
            placeholder="e.g. Setup steps, main benefit, and final result"
            aria-describedby="clarity-panel-status"
            onChange={(event) => onDraftChange({ ...draft, mustStay: event.target.value })}
          />
        </label>
      </div>

      <div className="clarity-panel__actions">
        <button
          type="button"
          className="btn btn--outline"
          disabled={!isReady || isAnalyzing}
          onClick={() => void onAnalyze()}
        >
          <Icon name="search" />
          {isAnalyzing ? 'Analyzing…' : 'Suggest clarity edits'}
        </button>
        {status !== 'idle' && (
          <button type="button" className="link-btn" onClick={onDiscard}>
            Discard
          </button>
        )}
      </div>

      <div
        id="clarity-panel-status"
        className="clarity-panel__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedback !== '' && <p>{feedback}</p>}
        {isAnalyzing && <p>Analyzing the kept speech for clarity edits…</p>}
        {showResult && (
          suggestions.length === 0 ? (
            <>
              <p className="clarity-panel__status-strong">No clarity edits suggested</p>
              <p>The analysis did not identify useful sentence removals.</p>
            </>
          ) : (
            <p>
              {suggestions.length} suggested {suggestions.length === 1 ? 'removal' : 'removals'}
              {' · '}{selectedCount} selected
            </p>
          )
        )}
      </div>

      {status === 'error' && (
        <div className="clarity-panel__error" role="alert">
          <strong>Couldn’t suggest clarity edits.</strong>
          <p>{error?.trim() || 'Try again.'}</p>
        </div>
      )}

      {currentDurationSeconds > 0 && (
        <dl className="clarity-panel__durations">
          <div>
            <dt>Current duration</dt>
            <dd>{formatSeconds(currentDurationSeconds)}</dd>
          </div>
          {showProposedDuration && (
            <div>
              <dt>Proposed duration</dt>
              <dd>{formatSeconds(proposedDurationSeconds)}</dd>
            </div>
          )}
          {showResult && targetDurationSeconds !== undefined && (
            <div>
              <dt>Target duration</dt>
              <dd>{formatSeconds(targetDurationSeconds)}</dd>
            </div>
          )}
        </dl>
      )}
      {targetNotReached && (
        <p className="clarity-panel__target-note">
          <strong>Target not reached.</strong> The proposed edit is longer than your target.
        </p>
      )}

      {showResult && suggestions.length > 0 && (
        <ul className="clarity-list">
          {suggestions.map((suggestion) => {
            const cardId = `clarity-card-${encodeURIComponent(suggestion.sentenceId)}`
            const { start, end } = suggestion.sourceRange
            const sourceDescription = `Original source time: from ${start} to ${end} seconds.`
            return (
              <li key={suggestion.sentenceId}>
                <article
                  className={suggestion.selected ? 'clarity-card clarity-card--selected' : 'clarity-card'}
                  aria-labelledby={`${cardId}-heading`}
                  aria-describedby={`${cardId}-text ${cardId}-source`}
                >
                  <div className="clarity-card__meta">
                    <h3 id={`${cardId}-heading`}>{REASON_LABELS[suggestion.reason]}</h3>
                    <span
                      className="clarity-card__time"
                      title={`Original source time: ${start}s–${end}s`}
                      aria-hidden="true"
                    >
                      {formatClock(start)} – {formatClock(end)}
                    </span>
                    <span id={`${cardId}-source`} className="sr-only">{sourceDescription}</span>
                  </div>
                  <p id={`${cardId}-text`} className="clarity-card__text">{suggestion.text}</p>
                  <p className="clarity-card__explanation">{suggestion.explanation}</p>
                  <div className="clarity-card__actions">
                    <label className="clarity-card__selection" htmlFor={`${cardId}-selected`}>
                      <input
                        id={`${cardId}-selected`}
                        type="checkbox"
                        checked={suggestion.selected}
                        aria-describedby={`${cardId}-text ${cardId}-source`}
                        onChange={(event) => onSelect(suggestion.sentenceId, event.target.checked)}
                      />
                      Remove this sentence
                    </label>
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Play original sentence. ${sourceDescription}`}
                      onClick={() => void onPlaySentence(suggestion.sentenceId)}
                    >
                      <Icon name="play" size={12} />
                      Play original
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
