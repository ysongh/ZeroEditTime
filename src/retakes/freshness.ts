// Pure Phase-11 recommendation provenance. A recommendation is tied to the
// relevant original-source transcript, never to the editable output timeline.

import type { Transcript } from '../transcript/types'
import type { RetakeCandidate } from './candidates'
import {
  buildRetakeAnalysisContext,
  normalizeRetakeAnalysisContext,
  type RetakeAnalysisContext,
  type RetakeAnalysisSourceContext,
  type RetakeAnalysisTextContext,
} from './context'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import type {
  RetakeRecommendation,
  RetakeTranscriptFingerprint,
} from './recommendation'

export const RETAKE_TRANSCRIPT_FINGERPRINT_VERSION = 'retake-transcript-v1'

export type RetakeRecommendationFreshness =
  | 'current'
  | 'stale'
  | 'requires-reanalysis'

type FingerprintIndex = Map<string, Set<string>>

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

function textFingerprintPart(
  value: RetakeAnalysisTextContext | undefined,
): readonly [string, boolean] | null {
  return value === undefined
    ? null
    : [value.text, value.truncated === true]
}

function sourceFingerprintPart(
  value: RetakeAnalysisSourceContext,
): readonly [number, number, string, boolean] {
  return [
    value.startSourceMs,
    value.endSourceMs,
    value.text,
    value.truncated === true,
  ]
}

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n

  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * prime)
  }

  return hash.toString(16).padStart(16, '0')
}

function fingerprintValue(canonical: string): string {
  const bytes = new TextEncoder().encode(canonical)
  return `${RETAKE_TRANSCRIPT_FINGERPRINT_VERSION}:${bytes.length}:${fnv1a64(bytes)}`
}

function rangeKey(startSourceMs: number, endSourceMs: number): string {
  return JSON.stringify([startSourceMs, endSourceMs])
}

function hasValidRange(
  value: Readonly<{ startSourceMs: number; endSourceMs: number }>,
): boolean {
  return (
    Number.isFinite(value.startSourceMs) &&
    Number.isFinite(value.endSourceMs) &&
    value.startSourceMs >= 0 &&
    value.endSourceMs > value.startSourceMs
  )
}

function hasCurrentFingerprintFormat(value: string): boolean {
  const [version, byteLength, hash, extra] = value.split(':')
  return (
    version === RETAKE_TRANSCRIPT_FINGERPRINT_VERSION &&
    extra === undefined &&
    /^[1-9]\d*$/u.test(byteLength ?? '') &&
    /^[0-9a-f]{16}$/u.test(hash ?? '')
  )
}

function hasValidTranscriptShape(transcript: Transcript): boolean {
  return transcript.words.every(
    (word) =>
      typeof word.text === 'string' &&
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.start >= 0 &&
      word.end > word.start,
  )
}

/**
 * Fingerprint the complete local candidate text plus the exact bounded
 * transcript evidence and signals supplied to its model request. The complete
 * text closes Part E's intentional head/tail omission without expanding the
 * network payload.
 */
export function buildRetakeTranscriptFingerprint(
  candidate: Readonly<RetakeCandidate>,
  context: Readonly<RetakeAnalysisContext>,
): RetakeTranscriptFingerprint | null {
  if (!hasValidRange(candidate)) return null

  const transcriptText = normalizeText(candidate.transcriptText)
  const normalizedContext = normalizeRetakeAnalysisContext(context)
  if (
    transcriptText === '' ||
    normalizedContext === null ||
    normalizedContext.candidate.startSourceMs !==
      candidate.startSourceMs ||
    normalizedContext.candidate.endSourceMs !== candidate.endSourceMs
  ) {
    return null
  }

  const signals = normalizedContext.signals
  const canonical = JSON.stringify([
    RETAKE_TRANSCRIPT_FINGERPRINT_VERSION,
    [candidate.startSourceMs, candidate.endSourceMs, transcriptText],
    sourceFingerprintPart(normalizedContext.candidate),
    textFingerprintPart(normalizedContext.before),
    textFingerprintPart(normalizedContext.after),
    (normalizedContext.nearbyAlternateTakes ?? []).map(
      sourceFingerprintPart,
    ),
    [
      signals.fillerCount,
      signals.fillerDensity,
      signals.longPauseCount,
      signals.longestPauseMs,
      signals.stumbleCount,
      signals.repeatedAttemptScore ?? null,
      signals.transcriptConfidence ?? null,
    ],
  ])

  return {
    startSourceMs: candidate.startSourceMs,
    endSourceMs: candidate.endSourceMs,
    fingerprint: fingerprintValue(canonical),
  }
}

function buildCurrentFingerprintIndex(
  transcript: Transcript,
): FingerprintIndex {
  const index: FingerprintIndex = new Map()
  if (!hasValidTranscriptShape(transcript)) return index

  for (const candidate of buildScreenedRetakeCandidates(transcript)) {
    const context = buildRetakeAnalysisContext(transcript, candidate)
    if (context === null) continue
    const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)
    if (fingerprint === null) continue

    const key = rangeKey(
      fingerprint.startSourceMs,
      fingerprint.endSourceMs,
    )
    const values = index.get(key) ?? new Set<string>()
    values.add(fingerprint.fingerprint)
    index.set(key, values)
  }

  return index
}

export function isRetakeTranscriptFingerprint(
  value: unknown,
): value is RetakeTranscriptFingerprint {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false
  }
  const fingerprint = value as Partial<RetakeTranscriptFingerprint>
  return (
    typeof fingerprint.startSourceMs === 'number' &&
    typeof fingerprint.endSourceMs === 'number' &&
    typeof fingerprint.fingerprint === 'string' &&
    hasValidRange({
      startSourceMs: fingerprint.startSourceMs,
      endSourceMs: fingerprint.endSourceMs,
    }) &&
    hasCurrentFingerprintFormat(fingerprint.fingerprint)
  )
}

function freshnessFromIndex(
  index: FingerprintIndex,
  recommendation: Readonly<RetakeRecommendation>,
): RetakeRecommendationFreshness {
  const fingerprints = recommendation.transcriptFingerprints
  if (
    !Array.isArray(fingerprints) ||
    fingerprints.length === 0 ||
    !fingerprints.every(isRetakeTranscriptFingerprint)
  ) {
    return 'requires-reanalysis'
  }
  if (!hasValidRange(recommendation)) return 'stale'

  for (const fingerprint of fingerprints) {
    if (
      fingerprint.startSourceMs < recommendation.startSourceMs ||
      fingerprint.endSourceMs > recommendation.endSourceMs
    ) {
      return 'stale'
    }
    const currentValues = index.get(
      rangeKey(fingerprint.startSourceMs, fingerprint.endSourceMs),
    )
    if (!currentValues?.has(fingerprint.fingerprint)) return 'stale'
  }

  return 'current'
}

/** Attach a captured local proof without mutating or trusting model output. */
export function withRetakeTranscriptFingerprint(
  recommendation: Readonly<RetakeRecommendation>,
  fingerprint: Readonly<RetakeTranscriptFingerprint>,
): RetakeRecommendation | null {
  if (
    !hasValidRange(recommendation) ||
    !isRetakeTranscriptFingerprint(fingerprint) ||
    fingerprint.startSourceMs < recommendation.startSourceMs ||
    fingerprint.endSourceMs > recommendation.endSourceMs
  ) {
    return null
  }

  return {
    ...recommendation,
    ...(recommendation.evidence === undefined
      ? {}
      : { evidence: { ...recommendation.evidence } }),
    transcriptFingerprints: [
      {
        startSourceMs: fingerprint.startSourceMs,
        endSourceMs: fingerprint.endSourceMs,
        fingerprint: fingerprint.fingerprint,
      },
    ],
  }
}

/**
 * Compare completed advice with candidates rebuilt from the current source
 * transcript. Missing or obsolete local provenance requires a new analysis;
 * removed candidates or changed relevant evidence are stale.
 */
export function getRetakeRecommendationFreshness(
  transcript: Transcript,
  recommendation: Readonly<RetakeRecommendation>,
): RetakeRecommendationFreshness {
  return freshnessFromIndex(
    buildCurrentFingerprintIndex(transcript),
    recommendation,
  )
}

/** Fail closed while preserving the order and identity of current advice. */
export function removeStaleRetakeRecommendations(
  transcript: Transcript,
  recommendations: readonly RetakeRecommendation[],
): RetakeRecommendation[] {
  const index = buildCurrentFingerprintIndex(transcript)
  return recommendations.filter(
    (recommendation) =>
      freshnessFromIndex(index, recommendation) === 'current',
  )
}
