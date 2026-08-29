// Pure Phase-11 collection normalization. Singular model validation remains
// in recommendation.ts; this layer sorts and conservatively combines trusted
// local recommendations without touching editor state or the EDL.

import { isRetakeTranscriptFingerprint } from './freshness'
import {
  RETAKE_SEVERITIES,
  makeRetakeRecommendationId,
  normalizeRetakeRecommendation,
  type RetakeEvidence,
  type RetakeReason,
  type RetakeRecommendation,
  type RetakeTranscriptFingerprint,
} from './recommendation'

/** The specification's 41-46s / 43-49s example overlaps 60% of the shorter. */
export const MIN_RETAKE_MERGE_OVERLAP_OF_SHORTER = 0.6

/** Reject a tiny issue merely contained somewhere inside a much wider one. */
export const MIN_RETAKE_MERGE_OVERLAP_OF_LONGER = 0.3

interface NormalizedEntry {
  recommendation: RetakeRecommendation
  /** Valid proofs remain useful for matching even when emission must fail closed. */
  fingerprints: RetakeTranscriptFingerprint[]
  /** Merged provenance is emitted only when every contributor supplied it. */
  hasCompleteProvenance: boolean
  /** Original owners prevent pairwise aggregation from changing copy ranking. */
  copyOwner: RetakeRecommendation
  scriptOwner: RetakeRecommendation | null
}

interface MergePair {
  leftIndex: number
  rightIndex: number
  strength: number
  key: string
}

const SPEECH_CONTENT_REASONS = new Set<RetakeReason>([
  'no-clean-take',
  'incomplete-thought',
  'repeated-failed-takes',
  'severe-stumble',
  'unclear-explanation',
  'excessive-fillers',
  'long-hesitation',
])

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fingerprintKey(
  fingerprint: Readonly<RetakeTranscriptFingerprint>,
): string {
  return JSON.stringify([
    fingerprint.startSourceMs,
    fingerprint.endSourceMs,
    fingerprint.fingerprint,
  ])
}

function compareFingerprints(
  left: Readonly<RetakeTranscriptFingerprint>,
  right: Readonly<RetakeTranscriptFingerprint>,
): number {
  return (
    left.startSourceMs - right.startSourceMs ||
    left.endSourceMs - right.endSourceMs ||
    compareText(left.fingerprint, right.fingerprint)
  )
}

function normalizeFingerprints(
  value: unknown,
  recommendation: Readonly<RetakeRecommendation>,
): RetakeTranscriptFingerprint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const fingerprints: RetakeTranscriptFingerprint[] = []
  for (const item of value) {
    if (
      !isRetakeTranscriptFingerprint(item) ||
      item.startSourceMs < recommendation.startSourceMs ||
      item.endSourceMs > recommendation.endSourceMs
    ) {
      return null
    }
    fingerprints.push({
      startSourceMs: item.startSourceMs,
      endSourceMs: item.endSourceMs,
      fingerprint: item.fingerprint,
    })
  }

  fingerprints.sort(compareFingerprints)
  return fingerprints.filter(
    (fingerprint, index) =>
      index === 0 ||
      fingerprintKey(fingerprint) !==
        fingerprintKey(fingerprints[index - 1]),
  )
}

function unionFingerprints(
  fingerprints: readonly RetakeTranscriptFingerprint[],
): RetakeTranscriptFingerprint[] {
  return fingerprints
    .map((fingerprint) => ({ ...fingerprint }))
    .sort(compareFingerprints)
    .filter(
      (fingerprint, index, sorted) =>
        index === 0 ||
        fingerprintKey(fingerprint) !==
          fingerprintKey(sorted[index - 1]),
    )
}

function inputFingerprints(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as { transcriptFingerprints?: unknown })
    .transcriptFingerprints
}

function normalizeEntry(
  value: unknown,
  sourceDurationMs: number,
): NormalizedEntry | null {
  const recommendation = normalizeRetakeRecommendation(
    value,
    sourceDurationMs,
  )
  if (recommendation === null) return null

  const fingerprints = normalizeFingerprints(
    inputFingerprints(value),
    recommendation,
  )

  return {
    recommendation,
    fingerprints: fingerprints ?? [],
    hasCompleteProvenance: fingerprints !== null,
    copyOwner: recommendation,
    scriptOwner:
      recommendation.suggestedScript === undefined
        ? null
        : recommendation,
  }
}

function evidenceKey(evidence: RetakeEvidence | undefined): readonly unknown[] {
  return evidence === undefined
    ? []
    : [
        evidence.fillerCount ?? null,
        evidence.silenceDurationMs ?? null,
        evidence.stumbleCount ?? null,
        evidence.transcriptConfidence ?? null,
      ]
}

function recommendationKey(
  recommendation: Readonly<RetakeRecommendation>,
): string {
  return JSON.stringify([
    recommendation.reason,
    recommendation.severity,
    recommendation.title,
    recommendation.explanation,
    recommendation.suggestedScript ?? null,
    recommendation.confidence,
    recommendation.status,
    evidenceKey(recommendation.evidence),
  ])
}

function entryKey(entry: Readonly<NormalizedEntry>): string {
  return JSON.stringify([
    entry.recommendation.startSourceMs,
    entry.recommendation.endSourceMs,
    recommendationKey(entry.recommendation),
    entry.fingerprints.map(fingerprintKey),
    entry.hasCompleteProvenance,
    recommendationKey(entry.copyOwner),
    entry.scriptOwner === null
      ? null
      : recommendationKey(entry.scriptOwner),
  ])
}

function compareEntries(
  left: Readonly<NormalizedEntry>,
  right: Readonly<NormalizedEntry>,
): number {
  return (
    left.recommendation.startSourceMs -
      right.recommendation.startSourceMs ||
    left.recommendation.endSourceMs - right.recommendation.endSourceMs ||
    compareText(entryKey(left), entryKey(right))
  )
}

function reasonFamily(reason: RetakeReason): string {
  return SPEECH_CONTENT_REASONS.has(reason) ? 'speech-content' : reason
}

function sharedFingerprint(
  left: Readonly<NormalizedEntry>,
  right: Readonly<NormalizedEntry>,
): boolean {
  const leftKeys = new Set(left.fingerprints.map(fingerprintKey))
  return right.fingerprints.some((fingerprint) =>
    leftKeys.has(fingerprintKey(fingerprint)),
  )
}

/** Higher values mean a clearer duplicate relationship; `null` means none. */
function relationshipStrength(
  left: Readonly<NormalizedEntry>,
  right: Readonly<NormalizedEntry>,
): number | null {
  const leftRecommendation = left.recommendation
  const rightRecommendation = right.recommendation
  const sameIdentity = leftRecommendation.id === rightRecommendation.id
  if (
    (!sameIdentity &&
      leftRecommendation.status !== rightRecommendation.status) ||
    reasonFamily(leftRecommendation.reason) !==
      reasonFamily(rightRecommendation.reason)
  ) {
    return null
  }

  // Conflicting workflow copies of one derived identity must collapse so the
  // collection never exposes duplicate ids to later state/UI actions.
  if (sameIdentity) return 4
  if (sharedFingerprint(left, right)) return 3

  const intersection =
    Math.min(
      leftRecommendation.endSourceMs,
      rightRecommendation.endSourceMs,
    ) -
    Math.max(
      leftRecommendation.startSourceMs,
      rightRecommendation.startSourceMs,
    )
  if (intersection <= 0) return null

  const leftDuration =
    leftRecommendation.endSourceMs - leftRecommendation.startSourceMs
  const rightDuration =
    rightRecommendation.endSourceMs - rightRecommendation.startSourceMs
  const shorterOverlap =
    intersection / Math.min(leftDuration, rightDuration)
  const longerOverlap = intersection / Math.max(leftDuration, rightDuration)
  if (
    shorterOverlap < MIN_RETAKE_MERGE_OVERLAP_OF_SHORTER ||
    longerOverlap < MIN_RETAKE_MERGE_OVERLAP_OF_LONGER
  ) {
    return null
  }

  return shorterOverlap + longerOverlap
}

function findBestMergePair(
  entries: readonly NormalizedEntry[],
): MergePair | null {
  let best: MergePair | null = null

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex++
    ) {
      const strength = relationshipStrength(
        entries[leftIndex],
        entries[rightIndex],
      )
      if (strength === null) continue
      const key = JSON.stringify([
        entryKey(entries[leftIndex]),
        entryKey(entries[rightIndex]),
      ])
      if (
        best === null ||
        strength > best.strength ||
        (strength === best.strength && compareText(key, best.key) < 0)
      ) {
        best = { leftIndex, rightIndex, strength, key }
      }
    }
  }

  return best
}

function severityRank(recommendation: RetakeRecommendation): number {
  return RETAKE_SEVERITIES.indexOf(recommendation.severity)
}

function usefulTextLength(value: string): number {
  return value.replace(/\s+/gu, '').length
}

function compareCopyOwners(
  left: Readonly<RetakeRecommendation>,
  right: Readonly<RetakeRecommendation>,
): number {
  return (
    usefulTextLength(right.explanation) -
      usefulTextLength(left.explanation) ||
    severityRank(right) - severityRank(left) ||
    right.confidence - left.confidence ||
    Number(right.suggestedScript !== undefined) -
      Number(left.suggestedScript !== undefined) ||
    compareText(recommendationKey(left), recommendationKey(right))
  )
}

function compareScriptOwners(
  left: Readonly<RetakeRecommendation>,
  right: Readonly<RetakeRecommendation>,
): number {
  return (
    usefulTextLength(right.suggestedScript ?? '') -
      usefulTextLength(left.suggestedScript ?? '') ||
    severityRank(right) - severityRank(left) ||
    right.confidence - left.confidence ||
    compareText(left.suggestedScript ?? '', right.suggestedScript ?? '') ||
    compareText(recommendationKey(left), recommendationKey(right))
  )
}

function strongestSeverity(
  recommendations: readonly RetakeRecommendation[],
): RetakeRecommendation['severity'] {
  return [...recommendations].sort(
    (left, right) =>
      severityRank(right) - severityRank(left) ||
      compareText(recommendationKey(left), recommendationKey(right)),
  )[0].severity
}

function statusRank(status: RetakeRecommendation['status']): number {
  switch (status) {
    case 'resolved':
      return 2
    case 'dismissed':
      return 1
    case 'open':
      return 0
  }
}

function strongestStatus(
  recommendations: readonly RetakeRecommendation[],
): RetakeRecommendation['status'] {
  return [...recommendations].sort(
    (left, right) =>
      statusRank(right.status) - statusRank(left.status) ||
      compareText(recommendationKey(left), recommendationKey(right)),
  )[0].status
}

function maximum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter(
    (value): value is number => value !== undefined,
  )
  return present.length === 0 ? undefined : Math.max(...present)
}

function minimum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter(
    (value): value is number => value !== undefined,
  )
  return present.length === 0 ? undefined : Math.min(...present)
}

function mergeEvidence(
  recommendations: readonly RetakeRecommendation[],
): RetakeEvidence | undefined {
  const evidence = recommendations.map((recommendation) =>
    recommendation.evidence,
  )
  const merged: RetakeEvidence = {}
  const fillerCount = maximum(evidence.map((value) => value?.fillerCount))
  const silenceDurationMs = maximum(
    evidence.map((value) => value?.silenceDurationMs),
  )
  const stumbleCount = maximum(
    evidence.map((value) => value?.stumbleCount),
  )
  const transcriptConfidence = minimum(
    evidence.map((value) => value?.transcriptConfidence),
  )

  if (fillerCount !== undefined) merged.fillerCount = fillerCount
  if (silenceDurationMs !== undefined) {
    merged.silenceDurationMs = silenceDurationMs
  }
  if (stumbleCount !== undefined) merged.stumbleCount = stumbleCount
  if (transcriptConfidence !== undefined) {
    merged.transcriptConfidence = transcriptConfidence
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

function mergeEntries(
  members: readonly NormalizedEntry[],
): NormalizedEntry {
  const recommendations = members.map(
    (member) => member.recommendation,
  )
  const copyOwner = members
    .map((member) => member.copyOwner)
    .sort(compareCopyOwners)[0]
  const scriptOwner = members
    .map((member) => member.scriptOwner)
    .filter(
      (recommendation): recommendation is RetakeRecommendation =>
        recommendation !== null,
    )
    .sort(compareScriptOwners)[0]
  const startSourceMs = Math.min(
    ...recommendations.map((recommendation) => recommendation.startSourceMs),
  )
  const endSourceMs = Math.max(
    ...recommendations.map((recommendation) => recommendation.endSourceMs),
  )
  const confidence = Math.max(
    ...recommendations.map((recommendation) => recommendation.confidence),
  )
  const evidence = mergeEvidence(recommendations)
  const recommendation: RetakeRecommendation = {
    id: makeRetakeRecommendationId(
      startSourceMs,
      endSourceMs,
      copyOwner.reason,
    ),
    startSourceMs,
    endSourceMs,
    reason: copyOwner.reason,
    severity: strongestSeverity(recommendations),
    title: copyOwner.title,
    explanation: copyOwner.explanation,
    ...(scriptOwner?.suggestedScript === undefined
      ? {}
      : { suggestedScript: scriptOwner.suggestedScript }),
    confidence,
    status: strongestStatus(recommendations),
    ...(evidence === undefined ? {} : { evidence }),
  }

  const hasCompleteProvenance = members.every(
    (member) => member.hasCompleteProvenance,
  )
  const fingerprints = unionFingerprints(
    members.flatMap((member) => member.fingerprints),
  )

  return {
    recommendation,
    fingerprints,
    hasCompleteProvenance,
    copyOwner,
    scriptOwner: scriptOwner ?? null,
  }
}

function mergeUntilStable(
  entries: readonly NormalizedEntry[],
): NormalizedEntry[] {
  let merged = [...entries].sort(compareEntries)

  while (true) {
    const pair = findBestMergePair(merged)
    if (pair === null) return merged

    const combined = mergeEntries([
      merged[pair.leftIndex],
      merged[pair.rightIndex],
    ])
    merged = merged
      .filter(
        (_entry, index) =>
          index !== pair.leftIndex && index !== pair.rightIndex,
      )
      .concat(combined)
      .sort(compareEntries)
  }
}

function materialize(entry: Readonly<NormalizedEntry>): RetakeRecommendation {
  return {
    ...entry.recommendation,
    ...(entry.recommendation.evidence === undefined
      ? {}
      : { evidence: { ...entry.recommendation.evidence } }),
    ...(!entry.hasCompleteProvenance
      ? {}
      : {
          transcriptFingerprints: entry.fingerprints.map(
            (fingerprint) => ({ ...fingerprint }),
          ),
        }),
  }
}

/**
 * Normalize, source-sort, and conservatively deduplicate recommendations.
 * Source duration is required so this plural seam keeps Part A's exact bounds
 * and trust rules rather than inventing a second validation policy.
 */
export function normalizeRetakeRecommendations(
  recommendations: readonly RetakeRecommendation[],
  sourceDurationMs: number,
): RetakeRecommendation[] {
  if (
    !Array.isArray(recommendations) ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs <= 0
  ) {
    return []
  }

  const entries = recommendations
    .map((recommendation) =>
      normalizeEntry(recommendation, sourceDurationMs),
    )
    .filter((entry): entry is NormalizedEntry => entry !== null)
    .sort(compareEntries)
  const normalized = mergeUntilStable(entries)

  return normalized.map(materialize)
}
