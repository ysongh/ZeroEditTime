// Pure preparation and review of advisory clarity suggestions. Temporary EDLs
// below only calculate durations; no editor content or history is returned.

import { applyRemovedRange, totalKeptDuration } from '../edl/edl'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import {
  normalizeClarityAnalysisResult,
  type ClarityAnalysisResult,
  type ClarityReason,
} from './analysis'
import {
  buildClarityAnalysisContext,
  validateClarityAnalysisContext,
  type ClarityAnalysisContext,
  type ClarityAnalysisSettings,
} from './context'
import {
  buildClaritySentenceCatalog,
  buildClaritySentenceContext,
  type ClaritySentence,
  type ClaritySourceRange,
} from './sentences'

export type ClarityDraft = {
  targetDuration: string
  audience: string
  mustStay: string
}

export function createClarityDraft(): ClarityDraft {
  return { targetDuration: '', audience: '', mustStay: '' }
}

export type PreparedClarityReview =
  | {
      status: 'ready'
      catalog: ClaritySentence[]
      context: ClarityAnalysisContext
      currentDurationSeconds: number
    }
  | {
      status: 'unavailable' | 'invalid' | 'oversized'
      message: string
      currentDurationSeconds: number
    }

/** Prepare the full currently kept context without calling the analysis API. */
export function prepareClarityReview(
  edl: EDL | null,
  transcript: Transcript | null,
  draft: ClarityDraft,
): PreparedClarityReview {
  const duration = edl === null ? 0 : totalKeptDuration(edl)
  const currentDurationSeconds = Number.isFinite(duration) && duration >= 0
    ? duration
    : 0
  const unavailable = (message: string): PreparedClarityReview => ({
    status: 'unavailable', message, currentDurationSeconds,
  })
  const invalid = (message: string): PreparedClarityReview => ({
    status: 'invalid', message, currentDurationSeconds,
  })

  if (edl === null) return unavailable('Load a video to suggest clarity edits.')
  if (transcript === null || transcript.words.length === 0) {
    return unavailable('Transcribe the video before suggesting clarity edits.')
  }
  if (
    typeof draft !== 'object' ||
    draft === null ||
    typeof draft.targetDuration !== 'string' ||
    typeof draft.audience !== 'string' ||
    typeof draft.mustStay !== 'string'
  ) {
    return invalid('Clarity settings must contain text values.')
  }

  const settings: ClarityAnalysisSettings = {
    audience: draft.audience,
    mustStay: draft.mustStay,
  }
  const target = draft.targetDuration.trim()
  if (target !== '') {
    const seconds = Number(target)
    if (
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(target) ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    ) {
      return invalid('Enter a positive target duration in seconds, such as 60 or 60.5.')
    }
    settings.targetDurationSeconds = seconds
  }

  let catalog: ClaritySentence[]
  try {
    catalog = buildClaritySentenceCatalog(transcript, edl)
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'Unable to read the current transcript timings.')
  }
  if (catalog.length === 0) {
    return unavailable('No kept speech is available. Restore some speech before suggesting clarity edits.')
  }

  const validated = validateClarityAnalysisContext({
    sentences: buildClaritySentenceContext(catalog),
    currentDurationSeconds: duration,
    settings,
  })
  if (!validated.ok) {
    return { status: validated.kind, message: validated.message, currentDurationSeconds }
  }
  return { status: 'ready', catalog, context: validated.context, currentDurationSeconds }
}

export type ClarityReviewSuggestion = {
  sentenceId: string
  text: string
  sourceRange: ClaritySourceRange
  reason: ClarityReason
  explanation: string
  selected: boolean
}

export type ClaritySelectionSummary = {
  suggestions: ClarityReviewSuggestion[]
  selectedCount: number
  currentDurationSeconds: number
  proposedDurationSeconds: number
}

/**
 * Resolve model IDs through the local catalog and measure selected cuts without
 * committing them. Callers must establish that the catalog belongs to this EDL;
 * IDs alone are not proof of source/transcript/proposal freshness.
 */
export function summarizeClaritySelection(
  edl: EDL,
  catalog: readonly ClaritySentence[],
  result: ClarityAnalysisResult,
  selectedIds: readonly string[],
): ClaritySelectionSummary {
  const currentDurationSeconds = totalKeptDuration(edl)
  const context = buildClarityAnalysisContext(catalog, currentDurationSeconds)
  const normalized = normalizeClarityAnalysisResult(result, context)
  if (normalized === null) {
    throw new Error('These clarity suggestions are invalid for the current sentence catalog.')
  }
  const proposalIds = new Set(normalized.suggestions.map((suggestion) => suggestion.sentenceId))
  const selected = new Set(selectedIds)
  for (const id of selected) {
    if (!proposalIds.has(id)) {
      throw new Error('A selected clarity sentence is not part of this proposal.')
    }
  }

  const sentencesById = new Map(catalog.map((sentence) => [sentence.id, sentence]))
  let temporaryEdl = edl
  let selectedCount = 0
  const suggestions: ClarityReviewSuggestion[] = normalized.suggestions.map((suggestion) => {
    const sentence = sentencesById.get(suggestion.sentenceId)
    if (sentence === undefined || sentence.removalRange === null) {
      throw new Error('This clarity sentence is protected or unavailable.')
    }
    const isSelected = selected.has(sentence.id)
    if (isSelected) {
      selectedCount += 1
      temporaryEdl = applyRemovedRange(
        temporaryEdl,
        sentence.removalRange.start,
        sentence.removalRange.end,
      )
    }
    return {
      sentenceId: sentence.id,
      text: sentence.text,
      sourceRange: { ...sentence.sourceRange },
      reason: suggestion.reason,
      explanation: suggestion.explanation,
      selected: isSelected,
    }
  })

  return {
    suggestions,
    selectedCount,
    currentDurationSeconds,
    proposedDurationSeconds: totalKeptDuration(temporaryEdl),
  }
}
