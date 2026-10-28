// Structured advisory output, shared by relay and browser. No model-authored
// timestamp, replacement wording, or executable edit enters this contract.

import {
  validateClarityAnalysisContext,
  type ClarityAnalysisContext,
} from './context'
import { CLARITY_LIMITS } from './limits'

export const CLARITY_ANALYSIS_MODE = 'clarity-analysis'
export const CLARITY_ANALYSIS_TOOL_NAME = 'submit_clarity_analysis'
export const CLARITY_REASONS = [
  'repeated-explanation',
  'off-topic-detail',
  'redundant-example',
  'excessive-introduction',
] as const

export type ClarityReason = (typeof CLARITY_REASONS)[number]
export type ClaritySuggestion = {
  sentenceId: string
  reason: ClarityReason
  explanation: string
}
export type ClarityAnalysisResult = { suggestions: ClaritySuggestion[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isReason(value: unknown): value is ClarityReason {
  return CLARITY_REASONS.some((reason) => reason === value)
}

/**
 * Validate every raw suggestion before deduplication, retaining the first valid
 * occurrence and returning source order. Invalid siblings fail the entire
 * proposal; there is no silent partial success or target-forcing retry.
 */
export function normalizeClarityAnalysisResult(
  value: unknown,
  context: ClarityAnalysisContext,
): ClarityAnalysisResult | null {
  const validated = validateClarityAnalysisContext(context)
  if (
    !validated.ok ||
    !isRecord(value) ||
    !hasOnlyKeys(value, ['suggestions']) ||
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > CLARITY_LIMITS.maxSuggestions
  ) {
    return null
  }
  const sentences = validated.context.sentences
  const eligibleIds = new Set(
    sentences.filter((row) => row.removable).map((row) => row.sentenceId),
  )
  const byId = new Map<string, ClaritySuggestion>()
  for (const item of value.suggestions) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['sentenceId', 'reason', 'explanation']) ||
      typeof item.sentenceId !== 'string' ||
      !eligibleIds.has(item.sentenceId) ||
      !isReason(item.reason) ||
      typeof item.explanation !== 'string' ||
      item.explanation.length > CLARITY_LIMITS.maxExplanationCharacters ||
      item.explanation.trim() === ''
    ) {
      return null
    }
    if (!byId.has(item.sentenceId)) {
      byId.set(item.sentenceId, {
        sentenceId: item.sentenceId,
        reason: item.reason,
        explanation: item.explanation.trim(),
      })
    }
  }
  // Each context entry proves some kept speech, including protected partial
  // words. Leaving only silence is not sufficient. The client will still
  // revalidate local ranges/freshness before any future Apply action.
  if (byId.size === sentences.length) return null

  const suggestions: ClaritySuggestion[] = []
  for (const sentence of sentences) {
    const suggestion = byId.get(sentence.sentenceId)
    if (suggestion !== undefined) suggestions.push(suggestion)
  }
  return { suggestions }
}

/** A truncated, ambiguous, or free-form response is never a usable proposal. */
export function extractClarityAnalysisResult(
  reply: unknown,
  context: ClarityAnalysisContext,
): ClarityAnalysisResult | null {
  if (
    !isRecord(reply) ||
    reply.stop_reason !== 'tool_use' ||
    !Array.isArray(reply.content) ||
    reply.content.length !== 1
  ) {
    return null
  }
  const block: unknown = reply.content[0]
  if (
    !isRecord(block) ||
    block.type !== 'tool_use' ||
    block.name !== CLARITY_ANALYSIS_TOOL_NAME ||
    typeof block.id !== 'string' ||
    block.id.trim() === ''
  ) {
    return null
  }
  return normalizeClarityAnalysisResult(block.input, context)
}
