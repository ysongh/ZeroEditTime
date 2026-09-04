// Framework-free Phase-11 batch orchestration. This module stays inert until
// App's explicit Retakes-panel action invokes it; the UI owns state while this
// layer composes the existing local and one-candidate APIs.

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
import { normalizeRetakeRecommendations } from './recommendations'

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
  /** Successfully completed candidate analyses. */
  completed: number
  total: number
  /** Failed candidate analyses; omitted while zero. */
  failed?: number
}

export interface RetakeBatchResult {
  candidateCount: number
  analyzedCount: number
  recommendations: RetakeRecommendation[]
}

export type RetakeContextAnalyzer = (
  context: RetakeAnalysisContext,
  signal?: AbortSignal,
) => Promise<RetakeAnalysisResult>

export interface RetakeBatchOptions {
  analyzeContext?: RetakeContextAnalyzer
  onProgress?: (progress: RetakeBatchProgress) => void
  signal?: AbortSignal
}

// Keep one adapter identity across runs so the session cache remains useful for
// the default analyzer while still forwarding each run's cancellation signal.
const DEFAULT_RETAKE_CONTEXT_ANALYZER: RetakeContextAnalyzer = (
  context,
  signal,
) => analyzeRetakeContext(context, undefined, undefined, signal)

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
  if (recommendation === null) {
    throw new Error('Could not create a valid retake recommendation.')
  }
  const withFingerprint = withRetakeTranscriptFingerprint(
    recommendation,
    transcriptFingerprint,
  )
  if (withFingerprint === null) {
    throw new Error('Could not verify a retake recommendation.')
  }
  return withFingerprint
}

function candidateFitsSource(
  candidate: Readonly<RetakeCandidate>,
  sourceDurationMs: number,
): boolean {
  return (
    Number.isFinite(candidate.startSourceMs) &&
    Number.isFinite(candidate.endSourceMs) &&
    candidate.startSourceMs >= 0 &&
    candidate.endSourceMs > candidate.startSourceMs &&
    candidate.endSourceMs <= sourceDurationMs
  )
}

/**
 * Analyze every locally screened candidate after an explicit caller action.
 *
 * The existing relay accepts exactly one bounded context per request and the
 * server-owned schema returns exactly one result, so Part J keeps one candidate
 * per request and uses a fixed small worker pool. Local selection deduplicates,
 * prioritizes, and caps requests before this point; successful decisions are
 * cached only by their complete bounded context. Part L normalization removes
 * invalid and clearly duplicate overlapping recommendations, while Part M
 * owns storage. Candidate failures are isolated so valid sibling decisions
 * and recommendations survive.
 */
export async function analyzeRetakes(
  transcript: Transcript | null | undefined,
  sourceDurationMs: number,
  options: Readonly<RetakeBatchOptions> = {},
): Promise<RetakeBatchResult> {
  if (transcript === null || transcript === undefined) {
    throw new Error('Generate a transcript before checking for retakes.')
  }
  const availableTranscript = transcript
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new Error('Cannot analyze retakes without a valid source duration.')
  }

  const candidates = selectRetakeCandidatesForAnalysis(
    buildScreenedRetakeCandidates(availableTranscript),
  )
  const total = candidates.length
  const analyzeContext =
    options.analyzeContext ?? DEFAULT_RETAKE_CONTEXT_ANALYZER
  const signal = options.signal
  const cache = sessionCacheFor(analyzeContext)
  const recommendations: Array<RetakeRecommendation | null> = Array.from(
    { length: total },
    () => null,
  )
  let nextCandidateIndex = 0
  let analyzedCount = 0
  let failedCount = 0
  const failures: Array<{ cause: unknown } | undefined> = Array.from(
    { length: total },
  )

  // A pre-cancelled run must not look as though analysis started.
  signal?.throwIfAborted()
  options.onProgress?.({ completed: 0, total })

  function reportProgress(): void {
    // Cancellation is a batch lifecycle event, not a failed candidate.
    signal?.throwIfAborted()
    options.onProgress?.({
      completed: analyzedCount,
      total,
      ...(failedCount === 0 ? {} : { failed: failedCount }),
    })
  }

  async function runWorker(): Promise<void> {
    while (true) {
      // No worker may dequeue more model work after this run is superseded.
      signal?.throwIfAborted()
      if (nextCandidateIndex >= total) return

      const candidateIndex = nextCandidateIndex
      nextCandidateIndex++
      const candidate = candidates[candidateIndex]
      try {
        if (!candidateFitsSource(candidate, sourceDurationMs)) {
          throw new Error(
            'A retake-analysis section falls outside the source duration.',
          )
        }
        const context = buildRetakeAnalysisContext(
          availableTranscript,
          candidate,
        )
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
        let shouldCache = false
        if (result === undefined) {
          result = await analyzeContext(context, signal)
          // An analyzer is allowed to ignore AbortSignal. Recheck before its
          // late result can enter recommendations or the shared session cache.
          signal?.throwIfAborted()
          shouldCache = true
        }

        // Cached work must obey the same cancellation boundary as fresh work.
        signal?.throwIfAborted()

        recommendations[candidateIndex] = recommendationFromResult(
          candidate,
          result,
          sourceDurationMs,
          transcriptFingerprint,
        )
        if (shouldCache) {
          cache?.set(
            context,
            result,
            transcriptFingerprint.fingerprint,
          )
        }
        analyzedCount++
      } catch (error) {
        // Only this batch's signal cancels the whole run. An AbortError from a
        // live analyzer (including its own timeout) remains an isolated Part-T
        // candidate failure so valid sibling results still survive.
        signal?.throwIfAborted()
        failedCount++
        failures[candidateIndex] = { cause: error }
      }
      reportProgress()
    }
  }

  const workerCount = Math.min(MAX_RETAKE_ANALYSIS_CONCURRENCY, total)
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  )
  signal?.throwIfAborted()
  if (analyzedCount === 0 && failedCount > 0) {
    const firstFailure = failures.find(
      (failure) => failure !== undefined,
    )
    throw firstFailure?.cause instanceof Error
      ? firstFailure.cause
      : new Error('Retake analysis failed. Try again.')
  }

  const completedRecommendations = recommendations.filter(
    (recommendation): recommendation is RetakeRecommendation =>
      recommendation !== null,
  )

  return {
    candidateCount: total,
    analyzedCount,
    recommendations: normalizeRetakeRecommendations(
      completedRecommendations,
      sourceDurationMs,
    ),
  }
}
