// Ephemeral analysis/review state. No editor dispatch, content history, or edits.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import { normalizeClarityAnalysisResult, type ClarityAnalysisResult } from './analysis'
import { analyzeClarityContext } from './analysisApi'
import {
  createClarityDraft,
  prepareClarityReview,
  summarizeClaritySelection,
  type ClarityDraft,
} from './review'

type PreparedInput = ReturnType<typeof prepareClarityReview>
type ReadyInput = Extract<PreparedInput, { status: 'ready' }>
type ActiveAnalysis = { input: ReadyInput; edl: EDL; controller: AbortController }
type CompleteReview = {
  input: ReadyInput
  edl: EDL
  status: 'complete'
  result: ClarityAnalysisResult
  selectedIds: string[]
}
type ReviewOutcome =
  | { input: ReadyInput; status: 'analyzing' }
  | { input: ReadyInput; status: 'error'; error: string }
  | CompleteReview

export function useClarityReview(edl: EDL | null, transcript: Transcript | null) {
  const [draft, setDraft] = useState(createClarityDraft)
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null)
  const activeRef = useRef<ActiveAnalysis | null>(null)
  const acceptedRef = useRef<CompleteReview | null>(null)
  const invalidatedInputRef = useRef<PreparedInput | null>(null)

  // Only source/kept-range changes affect analysis. Caption edits keep the same
  // segments, so they must not discard review or restart expensive preparation.
  const source = edl?.source
  const segments = edl?.segments
  const analysisEdl = useMemo<EDL | null>(
    () => source === undefined || segments === undefined
      ? null
      : { version: 1, source, segments, captions: [] },
    [source, segments],
  )
  const input = useMemo(
    () => prepareClarityReview(analysisEdl, transcript, draft),
    [analysisEdl, transcript, draft],
  )

  // Render never exposes results for a different input, even before effects
  // run. Cleanup stops obsolete requests without scheduling background work.
  useEffect(() => () => {
    const active = activeRef.current
    if (active?.input === input) {
      activeRef.current = null
      active.controller.abort()
    }
    if (acceptedRef.current?.input === input) acceptedRef.current = null
  }, [input])

  function clearReview() {
    const active = activeRef.current
    activeRef.current = null
    acceptedRef.current = null
    active?.controller.abort()
    setOutcome(null)
  }

  /** Call before an editor input change, closing the pre-render callback gap. */
  function invalidate() {
    invalidatedInputRef.current = activeRef.current?.input ?? acceptedRef.current?.input ?? input
    clearReview()
  }

  /** Async editor callbacks may come from an older render. Compare the EDL
   * actually under review, not the EDL captured by that callback's closure. */
  function invalidateForEdl(next: EDL | null): boolean {
    const reviewed = activeRef.current?.edl ?? acceptedRef.current?.edl ?? analysisEdl
    if (reviewed?.source === next?.source && reviewed?.segments === next?.segments) {
      return false
    }
    invalidate()
    return true
  }

  function changeDraft(next: ClarityDraft) {
    if (
      next.targetDuration === draft.targetDuration &&
      next.audience === draft.audience &&
      next.mustStay === draft.mustStay
    ) return
    invalidate()
    setDraft({ ...next })
  }

  function reset() {
    invalidate()
    setDraft(createClarityDraft())
  }

  async function analyze() {
    if (
      input.status !== 'ready' ||
      analysisEdl === null ||
      activeRef.current !== null ||
      invalidatedInputRef.current === input
    ) return
    const active: ActiveAnalysis = { input, edl: analysisEdl, controller: new AbortController() }
    activeRef.current = active
    acceptedRef.current = null
    setOutcome({ input, status: 'analyzing' })
    try {
      const reply = await analyzeClarityContext(
        input.context, undefined, undefined, active.controller.signal,
      )
      if (activeRef.current !== active) return
      const result = normalizeClarityAnalysisResult(reply, input.context)
      if (result === null) throw new Error('Received an invalid clarity proposal.')
      const complete: CompleteReview = {
        input,
        edl: active.edl,
        status: 'complete',
        result,
        selectedIds: result.suggestions.map((suggestion) => suggestion.sentenceId),
      }
      acceptedRef.current = complete
      setOutcome(complete)
    } catch (cause) {
      if (activeRef.current !== active) return
      setOutcome({
        input,
        status: 'error',
        error: cause instanceof Error ? cause.message : 'Clarity analysis failed. Try again.',
      })
    } finally {
      if (activeRef.current === active) activeRef.current = null
    }
  }

  const visible = outcome?.input === input ? outcome : null
  const complete = visible?.status === 'complete' ? visible : null
  const summary = useMemo(
    () => complete === null || analysisEdl === null ? null : summarizeClaritySelection(
      analysisEdl, complete.input.catalog, complete.result, complete.selectedIds,
    ),
    [analysisEdl, complete],
  )

  function currentReview(): CompleteReview | null {
    const latest = acceptedRef.current
    return latest !== null && latest.input === input &&
      latest.result === complete?.result && invalidatedInputRef.current !== input
      ? latest
      : null
  }

  function select(sentenceId: string, selected: boolean) {
    const latest = currentReview()
    if (latest === null || !latest.result.suggestions.some(
      (suggestion) => suggestion.sentenceId === sentenceId,
    )) return
    const ids = new Set(latest.selectedIds)
    if (ids.has(sentenceId) === selected) return
    if (selected) ids.add(sentenceId)
    else ids.delete(sentenceId)
    const next = { ...latest, selectedIds: [...ids] }
    acceptedRef.current = next
    setOutcome(next)
  }

  /** The player receives a locally validated sentence, never a model range. */
  function sentenceForPlayback(sentenceId: string) {
    const latest = currentReview()
    if (latest === null || !latest.result.suggestions.some(
      (suggestion) => suggestion.sentenceId === sentenceId,
    )) return null
    return latest.input.catalog.find(
      (sentence) => sentence.id === sentenceId && sentence.removalRange !== null,
    ) ?? null
  }

  const status: ReviewOutcome['status'] | 'idle' = visible?.status ?? 'idle'

  return {
    input,
    draft,
    changeDraft,
    reset,
    invalidate,
    invalidateForEdl,
    analyze,
    discard: clearReview,
    select,
    sentenceForPlayback,
    status,
    error: visible?.status === 'error' ? visible.error : undefined,
    suggestions: summary?.suggestions ?? [],
    currentDurationSeconds: input.currentDurationSeconds,
    proposedDurationSeconds: summary?.proposedDurationSeconds ?? null,
    targetDurationSeconds: input.status === 'ready'
      ? input.context.settings.targetDurationSeconds
      : undefined,
  }
}
