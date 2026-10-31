// Pure, validated edit derivation shared by temporary playback and Apply.
// The caller owns request freshness/history; no saved or model-authored ranges
// are trusted here. Every selected ID is resolved through the current transcript.
import { applyRemovedRange } from '../edl/edl'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import { normalizeClarityAnalysisResult, type ClarityAnalysisResult } from './analysis'
import { isClaritySnapshotCurrent, type ClaritySnapshot } from './freshness'
import { prepareClarityReview, type ClarityDraft } from './review'

export type ClarityCutProposal = {
  snapshot: ClaritySnapshot
  result: ClarityAnalysisResult
  selectedIds: readonly string[]
}

export type ClarityEditResult =
  | { ok: true; edl: EDL; selectedCount: number }
  | { ok: false; kind: 'stale' | 'invalid'; message: string }

/**
 * Recheck exact provenance and local range eligibility against the supplied
 * latest EDL. Caption text is carried through unchanged; it is never rebuilt.
 * Empty and unchanged edits preserve input identity so callers can skip Undo.
 */
export function deriveClarityEdit(
  edl: EDL,
  transcript: Transcript,
  draft: ClarityDraft,
  proposal: ClarityCutProposal,
): ClarityEditResult {
  if (!isClaritySnapshotCurrent(proposal.snapshot, edl, transcript, draft)) {
    return {
      ok: false,
      kind: 'stale',
      message: 'The video, transcript, kept ranges, or clarity settings changed. Suggest clarity edits again.',
    }
  }

  const input = prepareClarityReview(edl, transcript, draft)
  if (input.status !== 'ready') {
    return { ok: false, kind: 'invalid', message: input.message }
  }
  const result = normalizeClarityAnalysisResult(proposal.result, input.context)
  if (result === null) {
    return {
      ok: false, kind: 'invalid',
      message: 'These clarity suggestions are invalid for the current transcript.',
    }
  }

  const proposedIds = new Set(result.suggestions.map((suggestion) => suggestion.sentenceId))
  if (
    !Array.isArray(proposal.selectedIds) ||
    proposal.selectedIds.some((id) => typeof id !== 'string' || !proposedIds.has(id))
  ) {
    return {
      ok: false, kind: 'invalid',
      message: 'A selected clarity sentence is not part of this proposal.',
    }
  }
  const selected = new Set(proposal.selectedIds)
  let nextEdl = edl
  let selectedCount = 0
  for (const sentence of input.catalog) {
    if (!selected.has(sentence.id)) continue
    const range = sentence.removalRange
    // The normalized result already excludes protected sentences. Retain the
    // local guard at the exact point where an ID becomes a source-time cut.
    if (range === null) {
      return {
        ok: false, kind: 'invalid',
        message: 'A selected clarity sentence is protected or unavailable.',
      }
    }
    nextEdl = applyRemovedRange(nextEdl, range.start, range.end)
    selectedCount += 1
  }

  // applyRemovedRange may allocate even when coverage is unchanged. IDs are
  // structural metadata, so only source bounds establish an actual cut.
  const unchanged = nextEdl.segments.length === edl.segments.length &&
    nextEdl.segments.every((segment, index) =>
      segment.start === edl.segments[index].start && segment.end === edl.segments[index].end,
    )
  return { ok: true, edl: unchanged ? edl : nextEdl, selectedCount }
}
