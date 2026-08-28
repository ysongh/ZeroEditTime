// Framework-free Phase-11 batch orchestration. This module is inert until a
// caller explicitly invokes it: later editor/UI parts own the user action and
// state, while this layer composes the existing local and one-candidate APIs.

import type { Transcript } from '../transcript/types'
import type { RetakeAnalysisResult } from './analysis'
import { analyzeRetakeContext } from './analysisApi'
import type {
  RetakeCandidate,
  RetakeCandidateSignals,
} from './candidates'
import {
  buildRetakeAnalysisContext,
  type RetakeAnalysisContext,
} from './context'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import {
  normalizeRetakeRecommendation,
  type RetakeEvidence,
  type RetakeReason,
  type RetakeRecommendation,
} from './recommendation'

const RETAKE_TITLES = {
  'no-clean-take': 'No clean take found',
  'incomplete-thought': 'Incomplete thought',
  'repeated-failed-takes': 'Repeated attempts',
  'severe-stumble': 'Severe stumble',
  'unclear-explanation': 'Unclear explanation',
  'excessive-fillers': 'Filler-heavy section',
  'long-hesitation': 'Long hesitation',
  'audio-quality': 'Audio quality issue',
  'low-transcription-confidence': 'Low transcript confidence',
} as const satisfies Readonly<Record<RetakeReason, string>>

export interface RetakeBatchProgress {
  completed: number
  total: number
}

export interface RetakeBatchResult {
  candidateCount: number
  analyzedCount: number
  recommendations: RetakeRecommendation[]
}

export type RetakeContextAnalyzer = (
  context: RetakeAnalysisContext,
) => Promise<RetakeAnalysisResult>

export interface RetakeBatchOptions {
  analyzeContext?: RetakeContextAnalyzer
  onProgress?: (progress: RetakeBatchProgress) => void
}

function candidateEvidence(
  signals: RetakeCandidateSignals,
): RetakeEvidence | undefined {
  const evidence: RetakeEvidence = {}

  if (signals.fillerCount > 0) evidence.fillerCount = signals.fillerCount
  if (signals.longestPauseMs > 0) {
    evidence.silenceDurationMs = signals.longestPauseMs
  }
  if (signals.stumbleCount > 0) evidence.stumbleCount = signals.stumbleCount
  if (signals.transcriptConfidence !== undefined) {
    evidence.transcriptConfidence = signals.transcriptConfidence
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined
}

function recommendationFromResult(
  candidate: RetakeCandidate,
  result: RetakeAnalysisResult,
  sourceDurationMs: number,
): RetakeRecommendation | null {
  if (!result.needsRetake) return null

  const draft: Record<string, unknown> = {
    startSourceMs: candidate.startSourceMs,
    endSourceMs: candidate.endSourceMs,
    reason: result.reason,
    severity: result.severity,
    title: RETAKE_TITLES[result.reason],
    explanation: result.explanation,
    confidence: result.confidence,
    status: 'open',
  }

  if (result.suggestedScript !== undefined) {
    draft.suggestedScript = result.suggestedScript
  }
  const evidence = candidateEvidence(candidate.signals)
  if (evidence !== undefined) draft.evidence = evidence

  return normalizeRetakeRecommendation(draft, sourceDurationMs)
}

/**
 * Analyze every locally screened candidate after an explicit caller action.
 *
 * The existing relay accepts exactly one bounded context per request and the
 * repository has no multi-request concurrency primitive, so Part I processes
 * candidates serially. Part J owns later caps, prioritization, caching, and any
 * wider bounded-concurrency policy. Screened candidates currently use distinct
 * sentence envelopes and model results own no timestamps, so this path cannot
 * produce overlaps; Part L owns general merging. Parts M and T own storage and
 * partial-failure recovery respectively.
 */
export async function analyzeRetakes(
  transcript: Transcript,
  sourceDurationMs: number,
  options: Readonly<RetakeBatchOptions> = {},
): Promise<RetakeBatchResult> {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new Error('Cannot analyze retakes without a valid source duration.')
  }

  const candidates = buildScreenedRetakeCandidates(transcript)
  const total = candidates.length
  const analyzeContext = options.analyzeContext ?? analyzeRetakeContext
  const recommendations: RetakeRecommendation[] = []
  let analyzedCount = 0

  options.onProgress?.({ completed: 0, total })

  for (const candidate of candidates) {
    const context = buildRetakeAnalysisContext(transcript, candidate)
    if (context === null) {
      throw new Error('Could not build a valid retake-analysis context.')
    }

    const result = await analyzeContext(context)
    analyzedCount++

    const recommendation = recommendationFromResult(
      candidate,
      result,
      sourceDurationMs,
    )
    if (recommendation !== null) recommendations.push(recommendation)

    options.onProgress?.({ completed: analyzedCount, total })
  }

  return {
    candidateCount: total,
    analyzedCount,
    recommendations,
  }
}
