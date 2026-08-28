// Pure/local Phase-11 cost controls plus a bounded page-session result cache.
// Candidate selection happens before any AI request. Cache keys describe only
// the bounded Part-E context; recommendation staleness remains a later layer.

import type { RetakeAnalysisResult } from './analysis'
import type { RetakeCandidate } from './candidates'
import type { RetakeAnalysisContext } from './context'
import {
  LONG_HESITATION_THRESHOLD_MS,
  MIN_EXCESSIVE_FILLER_COUNT,
  MIN_EXCESSIVE_FILLER_DENSITY,
  MIN_SEVERE_STUMBLE_COUNT,
} from './heuristics'

export const MAX_RETAKE_ANALYSIS_CANDIDATES = 10
export const MAX_RETAKE_ANALYSIS_CONCURRENCY = 2
export const HEAVY_CANDIDATE_OVERLAP_RATIO = 0.8
export const MAX_RETAKE_ANALYSIS_CACHE_ENTRIES = 50
export const RETAKE_ANALYSIS_CACHE_KEY_VERSION = 'retake-analysis-policy-v1'

interface CandidatePriority {
  maximumStrength: number
  qualifyingSignalCount: number
  totalStrength: number
}

function canonicalCandidateTieBreak(candidate: RetakeCandidate): string {
  return JSON.stringify([
    candidate.transcriptText,
    candidate.previousContext ?? null,
    candidate.nextContext ?? null,
    candidate.signals.fillerCount,
    candidate.signals.fillerDensity,
    candidate.signals.longPauseCount,
    candidate.signals.longestPauseMs,
    candidate.signals.stumbleCount,
    candidate.signals.repeatedAttemptScore ?? null,
    candidate.signals.transcriptConfidence ?? null,
  ])
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function candidatePriority(candidate: RetakeCandidate): CandidatePriority {
  const signals = candidate.signals
  const fillerCount = finiteNonNegative(signals.fillerCount)
  const fillerDensity = finiteNonNegative(signals.fillerDensity)
  const longestPauseMs = finiteNonNegative(signals.longestPauseMs)
  const longPauseCount = finiteNonNegative(signals.longPauseCount)
  const stumbleCount = finiteNonNegative(signals.stumbleCount)

  const strengths = [
    fillerCount >= MIN_EXCESSIVE_FILLER_COUNT &&
    fillerDensity >= MIN_EXCESSIVE_FILLER_DENSITY
      ? Math.min(
          fillerCount / MIN_EXCESSIVE_FILLER_COUNT,
          fillerDensity / MIN_EXCESSIVE_FILLER_DENSITY,
        )
      : 0,
    longPauseCount > 0 && longestPauseMs > LONG_HESITATION_THRESHOLD_MS
      ? longestPauseMs / LONG_HESITATION_THRESHOLD_MS
      : 0,
    stumbleCount >= MIN_SEVERE_STUMBLE_COUNT
      ? stumbleCount / MIN_SEVERE_STUMBLE_COUNT
      : 0,
  ].filter((strength) => strength > 0)

  return {
    maximumStrength: Math.max(0, ...strengths),
    qualifyingSignalCount: strengths.length,
    totalStrength: strengths.reduce((total, strength) => total + strength, 0),
  }
}

function comparePriority(
  left: RetakeCandidate,
  right: RetakeCandidate,
): number {
  const leftPriority = candidatePriority(left)
  const rightPriority = candidatePriority(right)
  const priorityOrder =
    rightPriority.maximumStrength - leftPriority.maximumStrength ||
    rightPriority.qualifyingSignalCount -
      leftPriority.qualifyingSignalCount ||
    rightPriority.totalStrength - leftPriority.totalStrength ||
    left.startSourceMs - right.startSourceMs ||
    left.endSourceMs - right.endSourceMs ||
    left.id.localeCompare(right.id)
  if (priorityOrder !== 0) return priorityOrder

  const leftTieBreak = canonicalCandidateTieBreak(left)
  const rightTieBreak = canonicalCandidateTieBreak(right)
  if (leftTieBreak < rightTieBreak) return -1
  if (leftTieBreak > rightTieBreak) return 1
  return 0
}

function compareSourceOrder(
  left: RetakeCandidate,
  right: RetakeCandidate,
): number {
  return (
    left.startSourceMs - right.startSourceMs ||
    left.endSourceMs - right.endSourceMs ||
    left.id.localeCompare(right.id)
  )
}

function hasValidCandidateRange(candidate: RetakeCandidate): boolean {
  return (
    Number.isFinite(candidate.startSourceMs) &&
    Number.isFinite(candidate.endSourceMs) &&
    candidate.startSourceMs >= 0 &&
    candidate.endSourceMs > candidate.startSourceMs &&
    candidate.transcriptText.trim() !== ''
  )
}

function copyCandidate(candidate: RetakeCandidate): RetakeCandidate {
  return {
    id: candidate.id,
    startSourceMs: candidate.startSourceMs,
    endSourceMs: candidate.endSourceMs,
    transcriptText: candidate.transcriptText,
    ...(candidate.previousContext === undefined
      ? {}
      : { previousContext: candidate.previousContext }),
    ...(candidate.nextContext === undefined
      ? {}
      : { nextContext: candidate.nextContext }),
    signals: {
      fillerCount: candidate.signals.fillerCount,
      fillerDensity: candidate.signals.fillerDensity,
      longPauseCount: candidate.signals.longPauseCount,
      longestPauseMs: candidate.signals.longestPauseMs,
      stumbleCount: candidate.signals.stumbleCount,
      ...(candidate.signals.repeatedAttemptScore === undefined
        ? {}
        : {
            repeatedAttemptScore: candidate.signals.repeatedAttemptScore,
          }),
      ...(candidate.signals.transcriptConfidence === undefined
        ? {}
        : {
            transcriptConfidence: candidate.signals.transcriptConfidence,
          }),
    },
  }
}

function overlapRatioOfShorter(
  left: RetakeCandidate,
  right: RetakeCandidate,
): number {
  const overlap =
    Math.min(left.endSourceMs, right.endSourceMs) -
    Math.max(left.startSourceMs, right.startSourceMs)
  if (overlap <= 0) return 0

  const shorterDuration = Math.min(
    left.endSourceMs - left.startSourceMs,
    right.endSourceMs - right.startSourceMs,
  )
  return overlap / shorterDuration
}

/**
 * Pick the strongest bounded work set before any model call.
 *
 * Only Part-C-qualified signal families contribute to priority. A weak
 * co-signal remains zero and cannot raise the selection priority. Heavy
 * overlaps keep the stronger candidate without merging ranges or result copy;
 * post-analysis recommendation merging remains Part L.
 */
export function selectRetakeCandidatesForAnalysis(
  candidates: readonly RetakeCandidate[],
): RetakeCandidate[] {
  const prioritized = candidates
    .filter(hasValidCandidateRange)
    .map(copyCandidate)
    .sort(comparePriority)
  const selected: RetakeCandidate[] = []

  for (const candidate of prioritized) {
    if (
      selected.some(
        (existing) =>
          overlapRatioOfShorter(existing, candidate) >=
          HEAVY_CANDIDATE_OVERLAP_RATIO,
      )
    ) {
      continue
    }

    selected.push(candidate)
    if (selected.length === MAX_RETAKE_ANALYSIS_CANDIDATES) break
  }

  return selected.sort(compareSourceOrder)
}

function textFingerprintPart(
  value:
    | RetakeAnalysisContext['candidate']
    | NonNullable<RetakeAnalysisContext['before']>
    | undefined,
): readonly unknown[] | null {
  return value === undefined
    ? null
    : [value.text, value.truncated === true]
}

/** Canonical key for one already-bounded inference request. */
export function fingerprintRetakeAnalysisContext(
  context: RetakeAnalysisContext,
): string {
  return JSON.stringify([
    RETAKE_ANALYSIS_CACHE_KEY_VERSION,
    [
      context.candidate.startSourceMs,
      context.candidate.endSourceMs,
      ...textFingerprintPart(context.candidate)!,
    ],
    textFingerprintPart(context.before),
    textFingerprintPart(context.after),
    (context.nearbyAlternateTakes ?? []).map((take) => [
      take.startSourceMs,
      take.endSourceMs,
      ...textFingerprintPart(take)!,
    ]),
    [
      context.signals.fillerCount,
      context.signals.fillerDensity,
      context.signals.longPauseCount,
      context.signals.longestPauseMs,
      context.signals.stumbleCount,
      context.signals.repeatedAttemptScore ?? null,
      context.signals.transcriptConfidence ?? null,
    ],
  ])
}

function copyAnalysisResult(
  result: RetakeAnalysisResult,
): RetakeAnalysisResult {
  if (!result.needsRetake) {
    return {
      needsRetake: false,
      ...(result.explanation === undefined
        ? {}
        : { explanation: result.explanation }),
      confidence: result.confidence,
    }
  }

  return {
    needsRetake: true,
    reason: result.reason,
    severity: result.severity,
    explanation: result.explanation,
    ...(result.suggestedScript === undefined
      ? {}
      : { suggestedScript: result.suggestedScript }),
    confidence: result.confidence,
  }
}

export interface RetakeAnalysisSessionCache {
  readonly size: number
  get(context: RetakeAnalysisContext): RetakeAnalysisResult | undefined
  set(context: RetakeAnalysisContext, result: RetakeAnalysisResult): void
  clear(): void
}

class BoundedRetakeAnalysisSessionCache
  implements RetakeAnalysisSessionCache
{
  private readonly entries = new Map<string, RetakeAnalysisResult>()

  get size(): number {
    return this.entries.size
  }

  get(context: RetakeAnalysisContext): RetakeAnalysisResult | undefined {
    const key = fingerprintRetakeAnalysisContext(context)
    const stored = this.entries.get(key)
    if (stored === undefined) return undefined

    this.entries.delete(key)
    this.entries.set(key, stored)
    return copyAnalysisResult(stored)
  }

  set(
    context: RetakeAnalysisContext,
    result: RetakeAnalysisResult,
  ): void {
    const key = fingerprintRetakeAnalysisContext(context)
    this.entries.delete(key)
    this.entries.set(key, copyAnalysisResult(result))

    while (this.entries.size > MAX_RETAKE_ANALYSIS_CACHE_ENTRIES) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

export function createRetakeAnalysisSessionCache(): RetakeAnalysisSessionCache {
  return new BoundedRetakeAnalysisSessionCache()
}
