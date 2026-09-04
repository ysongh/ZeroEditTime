// Pure Phase-11 advisory state. Retake recommendations live beside editor
// content, never inside the EDL or its content-only Undo snapshots.

import type {
  RetakeEvidence,
  RetakeRecommendation,
  RetakeTranscriptFingerprint,
} from './recommendation'

export const RETAKE_ANALYSIS_STATUSES = [
  'idle',
  'analyzing',
  'complete',
  'error',
] as const

export type RetakeAnalysisStatus =
  (typeof RETAKE_ANALYSIS_STATUSES)[number]

export interface RetakeAnalysisProgress {
  /** Successfully completed candidate analyses. */
  completed: number
  total: number
  /** Failed candidate analyses; omitted when none have failed. */
  failed?: number
}

export interface RetakeEditorState {
  retakeRecommendations: RetakeRecommendation[]
  retakeAnalysisStatus: RetakeAnalysisStatus
  retakeAnalysisProgress?: RetakeAnalysisProgress
  retakeAnalysisError?: string
}

export type RetakeEditorAction =
  | {
      type: 'set-retake-recommendations'
      recommendations: readonly RetakeRecommendation[]
    }
  | { type: 'dismiss-retake-recommendation'; id: string }
  | { type: 'resolve-retake-recommendation'; id: string }
  | { type: 'clear-retake-recommendations' }
  | {
      type: 'set-retake-analysis-state'
      status: RetakeAnalysisStatus
      progress?: RetakeAnalysisProgress
      error?: string
    }

function isRetakeAnalysisStatus(
  value: unknown,
): value is RetakeAnalysisStatus {
  return RETAKE_ANALYSIS_STATUSES.includes(
    value as RetakeAnalysisStatus,
  )
}

function copyEvidence(
  evidence: Readonly<RetakeEvidence> | undefined,
): RetakeEvidence | undefined {
  if (evidence === undefined) return undefined

  return {
    ...(evidence.fillerCount === undefined
      ? {}
      : { fillerCount: evidence.fillerCount }),
    ...(evidence.silenceDurationMs === undefined
      ? {}
      : { silenceDurationMs: evidence.silenceDurationMs }),
    ...(evidence.stumbleCount === undefined
      ? {}
      : { stumbleCount: evidence.stumbleCount }),
    ...(evidence.transcriptConfidence === undefined
      ? {}
      : { transcriptConfidence: evidence.transcriptConfidence }),
  }
}

function copyFingerprints(
  fingerprints:
    | readonly Readonly<RetakeTranscriptFingerprint>[]
    | undefined,
): RetakeTranscriptFingerprint[] | undefined {
  return fingerprints?.map((fingerprint) => ({
    startSourceMs: fingerprint.startSourceMs,
    endSourceMs: fingerprint.endSourceMs,
    fingerprint: fingerprint.fingerprint,
  }))
}

function copyRecommendation(
  recommendation: Readonly<RetakeRecommendation>,
): RetakeRecommendation {
  const evidence = copyEvidence(recommendation.evidence)
  const transcriptFingerprints = copyFingerprints(
    recommendation.transcriptFingerprints,
  )

  return {
    id: recommendation.id,
    startSourceMs: recommendation.startSourceMs,
    endSourceMs: recommendation.endSourceMs,
    reason: recommendation.reason,
    severity: recommendation.severity,
    title: recommendation.title,
    explanation: recommendation.explanation,
    ...(recommendation.suggestedScript === undefined
      ? {}
      : { suggestedScript: recommendation.suggestedScript }),
    confidence: recommendation.confidence,
    status: recommendation.status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(transcriptFingerprints === undefined
      ? {}
      : { transcriptFingerprints }),
  }
}

function evidenceEqual(
  left: Readonly<RetakeEvidence> | undefined,
  right: Readonly<RetakeEvidence> | undefined,
): boolean {
  return (
    left?.fillerCount === right?.fillerCount &&
    left?.silenceDurationMs === right?.silenceDurationMs &&
    left?.stumbleCount === right?.stumbleCount &&
    left?.transcriptConfidence === right?.transcriptConfidence
  )
}

function fingerprintsEqual(
  left: readonly Readonly<RetakeTranscriptFingerprint>[] | undefined,
  right: readonly Readonly<RetakeTranscriptFingerprint>[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.length === right.length &&
    left.every(
      (fingerprint, index) =>
        fingerprint.startSourceMs === right[index].startSourceMs &&
        fingerprint.endSourceMs === right[index].endSourceMs &&
        fingerprint.fingerprint === right[index].fingerprint,
    )
  )
}

function recommendationsEqual(
  left: Readonly<RetakeRecommendation>,
  right: Readonly<RetakeRecommendation>,
): boolean {
  return (
    left.id === right.id &&
    left.startSourceMs === right.startSourceMs &&
    left.endSourceMs === right.endSourceMs &&
    left.reason === right.reason &&
    left.severity === right.severity &&
    left.title === right.title &&
    left.explanation === right.explanation &&
    left.suggestedScript === right.suggestedScript &&
    left.confidence === right.confidence &&
    left.status === right.status &&
    evidenceEqual(left.evidence, right.evidence) &&
    fingerprintsEqual(
      left.transcriptFingerprints,
      right.transcriptFingerprints,
    )
  )
}

function progressEqual(
  left: Readonly<RetakeAnalysisProgress> | undefined,
  right: Readonly<RetakeAnalysisProgress> | undefined,
): boolean {
  return (
    left?.completed === right?.completed &&
    left?.total === right?.total &&
    left?.failed === right?.failed
  )
}

/** Backward-compatible defaults for editor documents with no retake fields. */
export function createRetakeEditorState(
  initial?: Partial<RetakeEditorState>,
): RetakeEditorState {
  const progress = initial?.retakeAnalysisProgress
  const error = initial?.retakeAnalysisError

  return {
    retakeRecommendations: (initial?.retakeRecommendations ?? []).map(
      copyRecommendation,
    ),
    retakeAnalysisStatus: isRetakeAnalysisStatus(
      initial?.retakeAnalysisStatus,
    )
      ? initial.retakeAnalysisStatus
      : 'idle',
    ...(progress === undefined
      ? {}
      : { retakeAnalysisProgress: { ...progress } }),
    ...(error === undefined ? {} : { retakeAnalysisError: error }),
  }
}

/** Replace trusted, normalized recommendations with a defensive deep copy. */
export function setRetakeRecommendations(
  state: RetakeEditorState,
  recommendations: readonly RetakeRecommendation[],
): RetakeEditorState {
  const ids = new Set<string>()
  for (const recommendation of recommendations) {
    if (ids.has(recommendation.id)) {
      return state
    }
    ids.add(recommendation.id)
  }

  if (
    state.retakeRecommendations.length === recommendations.length &&
    state.retakeRecommendations.every((recommendation, index) =>
      recommendationsEqual(recommendation, recommendations[index]),
    )
  ) {
    return state
  }

  return {
    ...state,
    retakeRecommendations: recommendations.map(copyRecommendation),
  }
}

function setRecommendationStatus(
  state: RetakeEditorState,
  id: string,
  status: RetakeRecommendation['status'],
): RetakeEditorState {
  const statusRank = { open: 0, dismissed: 1, resolved: 2 } as const
  let changed = false
  const retakeRecommendations = state.retakeRecommendations.map(
    (recommendation) => {
      if (
        recommendation.id !== id ||
        statusRank[status] <= statusRank[recommendation.status]
      ) {
        return recommendation
      }
      changed = true
      return { ...recommendation, status }
    },
  )

  return changed ? { ...state, retakeRecommendations } : state
}

export function dismissRetakeRecommendation(
  state: RetakeEditorState,
  id: string,
): RetakeEditorState {
  return setRecommendationStatus(state, id, 'dismissed')
}

export function resolveRetakeRecommendation(
  state: RetakeEditorState,
  id: string,
): RetakeEditorState {
  return setRecommendationStatus(state, id, 'resolved')
}

export function clearRetakeRecommendations(
  state: RetakeEditorState,
): RetakeEditorState {
  return state.retakeRecommendations.length === 0
    ? state
    : { ...state, retakeRecommendations: [] }
}

/** Replace lifecycle metadata without coupling pure state to request policy. */
export function setRetakeAnalysisState(
  state: RetakeEditorState,
  status: RetakeAnalysisStatus,
  progress?: Readonly<RetakeAnalysisProgress>,
  error?: string,
): RetakeEditorState {
  if (
    state.retakeAnalysisStatus === status &&
    progressEqual(state.retakeAnalysisProgress, progress) &&
    state.retakeAnalysisError === error
  ) {
    return state
  }

  return {
    retakeRecommendations: state.retakeRecommendations,
    retakeAnalysisStatus: status,
    ...(progress === undefined
      ? {}
      : { retakeAnalysisProgress: { ...progress } }),
    ...(error === undefined ? {} : { retakeAnalysisError: error }),
  }
}

export function retakeEditorReducer(
  state: RetakeEditorState,
  action: RetakeEditorAction,
): RetakeEditorState {
  switch (action.type) {
    case 'set-retake-recommendations':
      return setRetakeRecommendations(state, action.recommendations)
    case 'dismiss-retake-recommendation':
      return dismissRetakeRecommendation(state, action.id)
    case 'resolve-retake-recommendation':
      return resolveRetakeRecommendation(state, action.id)
    case 'clear-retake-recommendations':
      return clearRetakeRecommendations(state)
    case 'set-retake-analysis-state':
      return setRetakeAnalysisState(
        state,
        action.status,
        action.progress,
        action.error,
      )
  }
}
