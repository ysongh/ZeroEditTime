// Local provenance only. Never send this original transcript/source snapshot
// to the analysis API; the bounded, kept-speech context is a separate contract.
import type { EDL } from '../edl/types'
import type { Transcript, Word } from '../transcript/types'
import type { ClarityDraft } from './review'

type SourceIdentity = Readonly<Pick<EDL['source'], 'id' | 'url' | 'duration'>>
type KeptRange = Readonly<{ start: number; end: number }>

export type ClaritySnapshot = Readonly<{
  source: SourceIdentity
  words: readonly Readonly<Word>[]
  keptRanges: readonly KeptRange[]
  draft: Readonly<ClarityDraft>
}>

/** Compare coverage, not segment IDs or structural splits. No gap tolerance. */
function readKeptRanges(edl: EDL | null): KeptRange[] | null {
  const source = edl?.source
  if (
    source == null ||
    typeof source.id !== 'string' ||
    typeof source.url !== 'string' ||
    !Number.isFinite(source.duration) ||
    source.duration < 0 ||
    !Array.isArray(edl?.segments)
  ) return null

  const ranges: { start: number; end: number }[] = []
  for (const segment of edl.segments) {
    const previous = ranges.at(-1)
    if (
      segment == null ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > source.duration ||
      (previous !== undefined && segment.start < previous.end)
    ) return null
    if (previous !== undefined && previous.end === segment.start) {
      previous.end = segment.end
    } else {
      ranges.push({ start: segment.start, end: segment.end })
    }
  }
  return ranges
}

function validWords(transcript: Transcript | null, duration: number): boolean {
  if (!Array.isArray(transcript?.words)) return false
  let previousStart = 0
  for (const word of transcript.words) {
    if (
      word == null ||
      typeof word.text !== 'string' ||
      word.text.trim() === '' ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previousStart ||
      word.end <= word.start ||
      word.end > duration
    ) return false
    previousStart = word.start
  }
  return true
}

function validDraft(draft: ClarityDraft): boolean {
  return typeof draft?.targetDuration === 'string' &&
    typeof draft?.audience === 'string' && typeof draft?.mustStay === 'string'
}

/**
 * Capture only after review preparation succeeds. Values are copied and frozen
 * so later mutations cannot make an old request's provenance appear current.
 * All original words matter, including deleted words that define sentence IDs.
 */
export function captureClaritySnapshot(
  edl: EDL,
  transcript: Transcript,
  draft: ClarityDraft,
): ClaritySnapshot {
  const keptRanges = readKeptRanges(edl)
  if (keptRanges === null || !validWords(transcript, edl.source.duration) || !validDraft(draft)) {
    throw new Error('Cannot capture clarity review with invalid source, transcript, ranges, or settings.')
  }
  return Object.freeze({
    source: Object.freeze({
      id: edl.source.id,
      url: edl.source.url,
      duration: edl.source.duration,
    }),
    words: Object.freeze(transcript.words.map((word) => Object.freeze({
      text: word.text, start: word.start, end: word.end,
    }))),
    keptRanges: Object.freeze(keptRanges.map((range) => Object.freeze(range))),
    draft: Object.freeze({
      targetDuration: draft.targetDuration,
      audience: draft.audience,
      mustStay: draft.mustStay,
    }),
  })
}

/** Caption edits and equivalent structural EDL splits preserve provenance. */
export function isClaritySnapshotEdlCurrent(
  snapshot: ClaritySnapshot,
  edl: EDL | null,
): boolean {
  const keptRanges = readKeptRanges(edl)
  return keptRanges !== null && edl !== null &&
    snapshot.source.id === edl.source.id &&
    snapshot.source.url === edl.source.url &&
    snapshot.source.duration === edl.source.duration &&
    snapshot.keptRanges.length === keptRanges.length &&
    snapshot.keptRanges.every((range, index) =>
      range.start === keptRanges[index].start && range.end === keptRanges[index].end,
    )
}

/** Synchronous value check; request/session ownership must be checked separately. */
export function isClaritySnapshotCurrent(
  snapshot: ClaritySnapshot,
  edl: EDL | null,
  transcript: Transcript | null,
  draft: ClarityDraft,
): boolean {
  return isClaritySnapshotEdlCurrent(snapshot, edl) &&
    validWords(transcript, snapshot.source.duration) && transcript !== null &&
    validDraft(draft) &&
    snapshot.draft.targetDuration === draft.targetDuration &&
    snapshot.draft.audience === draft.audience &&
    snapshot.draft.mustStay === draft.mustStay &&
    snapshot.words.length === transcript.words.length &&
    snapshot.words.every((word, index) => {
      const current = transcript.words[index]
      return word.text === current.text && word.start === current.start && word.end === current.end
    })
}
