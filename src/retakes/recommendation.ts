// Pure Phase-11 retake-recommendation domain model and trust boundary.
// Recommendations are advisory metadata. Their timing is always authored in
// original source milliseconds and never changes the EDL or output timeline.

export const RETAKE_REASONS = [
  'no-clean-take',
  'incomplete-thought',
  'repeated-failed-takes',
  'severe-stumble',
  'unclear-explanation',
  'excessive-fillers',
  'long-hesitation',
  'audio-quality',
  'low-transcription-confidence',
] as const

export type RetakeReason = (typeof RETAKE_REASONS)[number]

export const RETAKE_SEVERITIES = [
  'suggestion',
  'recommended',
  'strongly-recommended',
] as const

export type RetakeSeverity = (typeof RETAKE_SEVERITIES)[number]

export const RETAKE_STATUSES = ['open', 'dismissed', 'resolved'] as const

export type RetakeStatus = (typeof RETAKE_STATUSES)[number]

export interface RetakeEvidence {
  fillerCount?: number
  silenceDurationMs?: number
  stumbleCount?: number
  transcriptConfidence?: number
}

export interface RetakeTranscriptFingerprint {
  /** Original candidate range retained so merged advice can keep provenance. */
  startSourceMs: number
  endSourceMs: number
  fingerprint: string
}

export interface RetakeRecommendation {
  id: string

  /** Half-open range [startSourceMs, endSourceMs) in source-video time. */
  startSourceMs: number
  endSourceMs: number

  reason: RetakeReason
  severity: RetakeSeverity

  title: string
  explanation: string
  suggestedScript?: string

  /** Normalized confidence in the inclusive range 0..1. */
  confidence: number
  status: RetakeStatus

  /** Optional source signals retained for debugging and UI explanation. */
  evidence?: RetakeEvidence

  /** Versioned local proofs attached only after the untrusted boundary. */
  transcriptFingerprints?: RetakeTranscriptFingerprint[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
}

function requiredText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function normalizeEvidence(value: unknown): RetakeEvidence | undefined {
  if (!isRecord(value)) return undefined

  const evidence: RetakeEvidence = {}
  const fillerCount = nonNegativeInteger(value.fillerCount)
  const silenceDurationMs = nonNegativeNumber(value.silenceDurationMs)
  const stumbleCount = nonNegativeInteger(value.stumbleCount)
  const transcriptConfidence =
    typeof value.transcriptConfidence === 'number' &&
    Number.isFinite(value.transcriptConfidence)
      ? clamp(value.transcriptConfidence, 0, 1)
      : undefined

  if (fillerCount !== undefined) evidence.fillerCount = fillerCount
  if (silenceDurationMs !== undefined) {
    evidence.silenceDurationMs = silenceDurationMs
  }
  if (stumbleCount !== undefined) evidence.stumbleCount = stumbleCount
  if (transcriptConfidence !== undefined) {
    evidence.transcriptConfidence = transcriptConfidence
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined
}

export function makeRetakeRecommendationId(
  startSourceMs: number,
  endSourceMs: number,
  reason: RetakeReason,
): string {
  // Retakes are derived from analysis, so mirror segment/caption ids instead
  // of trusting a model-generated id or introducing random identity.
  return `retake_${startSourceMs}_${endSourceMs}_${reason}`
}

/**
 * Validate and normalize one completed recommendation before it can enter
 * editor state. The input is deliberately `unknown`: callers must not assert a
 * model response into the trusted domain type.
 *
 * Required malformed fields are rejected. Recoverable finite bounds and
 * confidence are clamped, optional malformed metadata is omitted, and unknown
 * fields are discarded by constructing a fresh value. Identity is always
 * derived locally from the normalized source range and reason.
 */
export function normalizeRetakeRecommendation(
  value: unknown,
  sourceDurationMs: number,
): RetakeRecommendation | null {
  if (
    !isRecord(value) ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs <= 0 ||
    typeof value.startSourceMs !== 'number' ||
    !Number.isFinite(value.startSourceMs) ||
    typeof value.endSourceMs !== 'number' ||
    !Number.isFinite(value.endSourceMs) ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    !isOneOf(RETAKE_REASONS, value.reason) ||
    !isOneOf(RETAKE_SEVERITIES, value.severity) ||
    !isOneOf(RETAKE_STATUSES, value.status)
  ) {
    return null
  }

  const title = requiredText(value.title)
  const explanation = requiredText(value.explanation)
  if (title === null || explanation === null) return null

  const startSourceMs = clamp(value.startSourceMs, 0, sourceDurationMs)
  const endSourceMs = clamp(value.endSourceMs, 0, sourceDurationMs)
  if (endSourceMs <= startSourceMs) return null

  const recommendation: RetakeRecommendation = {
    id: makeRetakeRecommendationId(
      startSourceMs,
      endSourceMs,
      value.reason,
    ),
    startSourceMs,
    endSourceMs,
    reason: value.reason,
    severity: value.severity,
    title,
    explanation,
    confidence: clamp(value.confidence, 0, 1),
    status: value.status,
  }

  const suggestedScript = optionalText(value.suggestedScript)
  if (suggestedScript !== undefined) {
    recommendation.suggestedScript = suggestedScript
  }

  const evidence = normalizeEvidence(value.evidence)
  if (evidence !== undefined) recommendation.evidence = evidence

  return recommendation
}
