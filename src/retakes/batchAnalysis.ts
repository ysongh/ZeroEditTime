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
import {
  MAX_RETAKE_ANALYSIS_CONCURRENCY,
  createRetakeAnalysisSessionCache,
  selectRetakeCandidatesForAnalysis,
  type RetakeAnalysisSessionCache,
} from './costControls'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import {
  buildRetakeTranscriptFingerprint,
  withRetakeTranscriptFingerprint,
} from './freshness'
import {
  normalizeRetakeRecommendation,
  type RetakeEvidence,
  type RetakeReason,
  type RetakeRecommendation,
  type RetakeTranscriptFingerprint,
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

let sessionCaches = new WeakMap<
  RetakeContextAnalyzer,
  RetakeAnalysisSessionCache
>()

function sessionCacheFor(
  analyzeContext: RetakeContextAnalyzer,
): RetakeAnalysisSessionCache {
  const existing = sessionCaches.get(analyzeContext)
  if (existing !== undefined) return existing

  const created = createRetakeAnalysisSessionCache()
  sessionCaches.set(analyzeContext, created)
  return created
}

/** Clear transient inference reuse, primarily when a caller ends a session. */
export function clearRetakeAnalysisSessionCaches(): void {
  sessionCaches = new WeakMap()
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
  transcriptFingerprint: RetakeTranscriptFingerprint,
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

  const recommendation = normalizeRetakeRecommendation(
    draft,
    sourceDurationMs,
  )
  return recommendation === null
    ? null
    : withRetakeTranscriptFingerprint(
        recommendation,
        transcriptFingerprint,
      )
}

/**
 * Analyze every locally screened candidate after an explicit caller action.
 *
 * The existing relay accepts exactly one bounded context per request and the
 * server-owned schema returns exactly one result, so Part J keeps one candidate
 * per request and uses a fixed small worker pool. Local selection deduplicates,
 * prioritizes, and caps requests before this point; successful decisions are
 * cached only by their complete bounded context. Part L owns recommendation
 * merging, while Parts M and T own storage and partial-failure recovery.
 */
export async function analyzeRetakes(
  transcript: Transcript,
  sourceDurationMs: number,
  options: Readonly<RetakeBatchOptions> = {},
): Promise<RetakeBatchResult> {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new Error('Cannot analyze retakes without a valid source duration.')
  }

  const candidates = selectRetakeCandidatesForAnalysis(
    buildScreenedRetakeCandidates(transcript),
  )
  const total = candidates.length
  const analyzeContext = options.analyzeContext ?? analyzeRetakeContext
  const cache = sessionCacheFor(analyzeContext)
  const recommendations: Array<RetakeRecommendation | null> = Array.from(
    { length: total },
    () => null,
  )
  let nextCandidateIndex = 0
  let analyzedCount = 0
  let hasFailure = false
  let firstFailure: unknown

  options.onProgress?.({ completed: 0, total })

  async function runWorker(): Promise<void> {
    while (!hasFailure && nextCandidateIndex < total) {
      const candidateIndex = nextCandidateIndex
      nextCandidateIndex++
      const candidate = candidates[candidateIndex]
      try {
        const context = buildRetakeAnalysisContext(transcript, candidate)
        if (context === null) {
          throw new Error('Could not build a valid retake-analysis context.')
        }
        const transcriptFingerprint = buildRetakeTranscriptFingerprint(
          candidate,
          context,
        )
        if (transcriptFingerprint === null) {
          throw new Error('Could not fingerprint retake-analysis context.')
        }

        let result = cache?.get(
          context,
          transcriptFingerprint.fingerprint,
        )
        if (result === undefined) {
          result = await analyzeContext(context)
          cache?.set(
            context,
            result,
            transcriptFingerprint.fingerprint,
          )
        }

        recommendations[candidateIndex] = recommendationFromResult(
          candidate,
          result,
          sourceDurationMs,
          transcriptFingerprint,
        )
        analyzedCount++
        options.onProgress?.({ completed: analyzedCount, total })
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true
          firstFailure = error
        }
      }
    }
  }

  const workerCount = Math.min(MAX_RETAKE_ANALYSIS_CONCURRENCY, total)
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  )
  if (hasFailure) throw firstFailure

  return {
    candidateCount: total,
    analyzedCount,
    recommendations: recommendations.filter(
      (recommendation): recommendation is RetakeRecommendation =>
        recommendation !== null,
    ),
  }
}
