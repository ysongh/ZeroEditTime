// Pure Phase-11 retake-analysis result contract and trust boundary. Model
// output stays `unknown` until this module reconstructs a whitelisted value.

import type { AgentReply } from '../agent/api'
import {
  RETAKE_REASONS,
  RETAKE_SEVERITIES,
  type RetakeReason,
  type RetakeSeverity,
} from './recommendation'

export const RETAKE_ANALYSIS_TOOL_NAME = 'submit_retake_analysis'
export const RETAKE_ANALYSIS_MODE = 'retake-analysis'

export interface NoRetakeAnalysisResult {
  needsRetake: false
  explanation?: string
  confidence: number
}

export interface NeedsRetakeAnalysisResult {
  needsRetake: true
  reason: RetakeReason
  severity: RetakeSeverity
  explanation: string
  suggestedScript?: string
  confidence: number
}

export type RetakeAnalysisResult =
  | NoRetakeAnalysisResult
  | NeedsRetakeAnalysisResult

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Validate one model-produced analysis result and copy only trusted fields.
 * A negative result deliberately carries no positive-only metadata, while a
 * positive result must explain a recognized reason and severity.
 */
export function normalizeRetakeAnalysisResult(
  value: unknown,
): RetakeAnalysisResult | null {
  if (
    !isRecord(value) ||
    !hasOwn(value, 'needsRetake') ||
    !hasOwn(value, 'confidence') ||
    typeof value.needsRetake !== 'boolean' ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence)
  ) {
    return null
  }

  const confidence = clampConfidence(value.confidence)

  if (!value.needsRetake) {
    const result: NoRetakeAnalysisResult = {
      needsRetake: false,
      confidence,
    }
    if (hasOwn(value, 'explanation')) {
      const explanation = trimmedText(value.explanation)
      if (explanation !== null) result.explanation = explanation
    }
    return result
  }

  if (
    !hasOwn(value, 'reason') ||
    !hasOwn(value, 'severity') ||
    !hasOwn(value, 'explanation') ||
    !isOneOf(RETAKE_REASONS, value.reason) ||
    !isOneOf(RETAKE_SEVERITIES, value.severity)
  ) {
    return null
  }

  const explanation = trimmedText(value.explanation)
  if (explanation === null) return null

  const result: NeedsRetakeAnalysisResult = {
    needsRetake: true,
    reason: value.reason,
    severity: value.severity,
    explanation,
    confidence,
  }

  if (hasOwn(value, 'suggestedScript')) {
    const suggestedScript = trimmedText(value.suggestedScript)
    if (suggestedScript !== null) result.suggestedScript = suggestedScript
  }

  return result
}

/**
 * Extract the single forced retake-analysis tool call from an Anthropic reply.
 * Any ambiguous, mismatched, or malformed reply is rejected rather than
 * guessing which block should become trusted application data.
 */
export function extractRetakeAnalysisResult(
  reply: AgentReply,
): RetakeAnalysisResult | null {
  if (reply.stop_reason !== 'tool_use' || !Array.isArray(reply.content)) {
    return null
  }

  const toolUses = reply.content.filter(
    (block): block is UnknownRecord =>
      isRecord(block) && hasOwn(block, 'type') && block.type === 'tool_use',
  )

  if (
    toolUses.length !== 1 ||
    !hasOwn(toolUses[0], 'name') ||
    !hasOwn(toolUses[0], 'input') ||
    toolUses[0].name !== RETAKE_ANALYSIS_TOOL_NAME
  ) {
    return null
  }

  return normalizeRetakeAnalysisResult(toolUses[0].input)
}
