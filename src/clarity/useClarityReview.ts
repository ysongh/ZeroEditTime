// Ephemeral analysis/review state. No editor dispatch, content history, or edits.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import { normalizeClarityAnalysisResult, type ClarityAnalysisResult } from './analysis'
import { analyzeClarityContext } from './analysisApi'
import type { ClarityCutProposal } from './edit'
import {
  captureClaritySnapshot,
  isClaritySnapshotCurrent,
  isClaritySnapshotEdlCurrent,
  type ClaritySnapshot,
} from './freshness'
import {
  createClarityDraft,
  prepareClarityReview,
  summarizeClaritySelection,
  type ClarityDraft,
} from './review'

type PreparedInput = ReturnType<typeof prepareClarityReview>
type ReadyInput = Extract<PreparedInput, { status: 'ready' }>
type ReviewSession = {
  input: PreparedInput
  edl: EDL | null
  transcript: Transcript | null
  draft: ClarityDraft
  snapshot: ClaritySnapshot | null
  revision: number
}
type ReadySession = ReviewSession & {
  input: ReadyInput
  snapshot: ClaritySnapshot
  edl: EDL
  transcript: Transcript
}
type ActiveAnalysis = { session: ReadySession; controller: AbortController }
type CompleteReview = {
  owner: ActiveAnalysis
  status: 'complete'
  result: ClarityAnalysisResult
  selectedIds: string[]
}
type ReviewOutcome =
  | { owner: ActiveAnalysis; status: 'analyzing' }
  | { owner: ActiveAnalysis; status: 'error'; error: string }
  | CompleteReview

export type ClarityEditSelection = {
  key: object
  proposal: ClarityCutProposal
  transcript: Transcript
  draft: ClarityDraft
  isCurrent: () => boolean
}

function isSessionFresh(session: ReviewSession): session is ReadySession {
  return session.input.status === 'ready' && session.snapshot !== null &&
    isClaritySnapshotCurrent(session.snapshot, session.edl, session.transcript, session.draft)
}

export function useClarityReview(edl: EDL | null, transcript: Transcript | null) {
  const [draft, setDraft] = useState(createClarityDraft)
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null)
  const [revision, setRevision] = useState(0)
  const activeRef = useRef<ActiveAnalysis | null>(null)
  const outcomeRef = useRef<ReviewOutcome | null>(null)
  const sessionRef = useRef<ReviewSession | null>(null)

  // Caption edits preserve these references and must not discard review or
  // restart expensive preparation. Snapshots check values at action boundaries.
  const source = edl?.source
  const segments = edl?.segments
  const analysisEdl = useMemo<EDL | null>(
    () => source === undefined || segments === undefined
      ? null
      : { version: 1, source, segments, captions: [] },
    [source, segments],
  )
  const session = useMemo<ReviewSession>(() => {
    const input = prepareClarityReview(analysisEdl, transcript, draft)
    return {
      input, edl: analysisEdl, transcript, draft, revision,
      snapshot: input.status === 'ready' && analysisEdl !== null && transcript !== null
        ? captureClaritySnapshot(analysisEdl, transcript, draft)
        : null,
    }
  }, [analysisEdl, transcript, draft, revision])
  const { input } = session

  // Publish ownership at commit, before browser events or promise continuations.
  // Cleanup revokes callbacks as well as requests, including on unmount. Merely
  // returning to earlier settings never restores an earlier session's authority.
  useLayoutEffect(() => {
    sessionRef.current = session
    return () => {
      if (sessionRef.current === session) sessionRef.current = null
      const active = activeRef.current
      if (active?.session === session) {
        activeRef.current = null
        active.controller.abort()
      }
      if (outcomeRef.current?.owner.session === session) outcomeRef.current = null
    }
  }, [session])

  function publish(next: ReviewOutcome | null) {
    outcomeRef.current = next
    setOutcome(next)
  }

  function clearReview() {
    const active = activeRef.current
    activeRef.current = null
    publish(null)
    active?.controller.abort()
  }

  /** Editor callbacks may be older than the current review. Invalidate the
   * current owner synchronously, before dispatch or the next React commit. */
  function invalidate() {
    sessionRef.current = null
    clearReview()
    setRevision((previous) => previous + 1)
  }

  function invalidateForEdl(next: EDL | null): boolean {
    const reviewed = activeRef.current?.session ?? outcomeRef.current?.owner.session ?? sessionRef.current
    if (reviewed?.snapshot == null || isClaritySnapshotEdlCurrent(reviewed.snapshot, next)) {
      return false
    }
    invalidate()
    return true
  }

  function changeDraft(next: ClarityDraft): boolean {
    if (sessionRef.current !== session || (
      next.targetDuration === draft.targetDuration &&
      next.audience === draft.audience &&
      next.mustStay === draft.mustStay
    )) return false
    invalidate()
    setDraft({ ...next })
    return true
  }

  function reset() {
    invalidate()
    setDraft(createClarityDraft())
  }

  function validateSession(candidate: ReviewSession): candidate is ReadySession {
    if (sessionRef.current !== candidate) return false
    if (isSessionFresh(candidate)) return true
    // Also fail closed if a caller accidentally mutated otherwise stable input
    // objects. Rebuild preparation before permitting another explicit request.
    if (candidate.snapshot !== null) invalidate()
    return false
  }

  async function analyze(onStart?: () => void) {
    if (!validateSession(session) || activeRef.current !== null) return
    const active: ActiveAnalysis = { session, controller: new AbortController() }
    activeRef.current = active
    publish({ owner: active, status: 'analyzing' })
    try {
      onStart?.()
      const reply = await analyzeClarityContext(
        session.input.context, undefined, undefined, active.controller.signal,
      )
      if (activeRef.current !== active || !validateSession(session)) return
      const result = normalizeClarityAnalysisResult(reply, session.input.context)
      if (result === null) throw new Error('Received an invalid clarity proposal.')
      publish({
        owner: active,
        status: 'complete',
        result,
        selectedIds: result.suggestions.map((suggestion) => suggestion.sentenceId),
      })
    } catch (cause) {
      if (activeRef.current !== active || !validateSession(session)) return
      publish({
        owner: active,
        status: 'error',
        error: cause instanceof Error ? cause.message : 'Clarity analysis failed. Try again.',
      })
    } finally {
      if (activeRef.current === active) activeRef.current = null
    }
  }

  const visible = outcome?.owner.session === session && isSessionFresh(session) ? outcome : null
  const complete = visible?.status === 'complete' ? visible : null
  const summary = useMemo(
    () => complete === null || analysisEdl === null ? null : summarizeClaritySelection(
      analysisEdl, complete.owner.session.input.catalog, complete.result, complete.selectedIds,
    ),
    [analysisEdl, complete],
  )

  function currentReview(): CompleteReview | null {
    if (!validateSession(session)) return null
    const latest = outcomeRef.current
    return latest?.status === 'complete' && latest.owner === complete?.owner ? latest : null
  }

  function select(sentenceId: string, selected: boolean): boolean {
    const latest = currentReview()
    if (latest === null || !latest.result.suggestions.some(
      (suggestion) => suggestion.sentenceId === sentenceId,
    )) return false
    const ids = new Set(latest.selectedIds)
    if (ids.has(sentenceId) === selected) return false
    if (selected) ids.add(sentenceId)
    else ids.delete(sentenceId)
    publish({ ...latest, selectedIds: [...ids] })
    return true
  }

  /** Capture the latest selection only after synchronous ownership/freshness
   * checks. The editor resolves these IDs again against its latest EDL. */
  function editSelection(): ClarityEditSelection | null {
    const latest = currentReview()
    if (latest === null) return null
    return {
      key: latest,
      proposal: {
        snapshot: latest.owner.session.snapshot,
        result: latest.result,
        selectedIds: latest.selectedIds,
      },
      transcript: latest.owner.session.transcript,
      draft: latest.owner.session.draft,
      isCurrent: () => currentReview() === latest,
    }
  }

  /** The player receives a freshly checked local sentence, never a model range. */
  function sentenceForPlayback(sentenceId: string) {
    const latest = currentReview()
    if (latest === null || !latest.result.suggestions.some(
      (suggestion) => suggestion.sentenceId === sentenceId,
    )) return null
    return latest.owner.session.input.catalog.find(
      (sentence) => sentence.id === sentenceId && sentence.removalRange !== null,
    ) ?? null
  }

  function discard(): boolean {
    if (sessionRef.current !== session || outcomeRef.current?.owner !== outcome?.owner) return false
    clearReview()
    return true
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
    discard,
    select,
    editSelection,
    selectionKey: complete as object | null,
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
