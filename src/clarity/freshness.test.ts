import { describe, expect, it } from 'vitest'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import {
  captureClaritySnapshot,
  isClaritySnapshotCurrent,
  isClaritySnapshotEdlCurrent,
} from './freshness'
import type { ClarityDraft } from './review'

function fixture() {
  const edl: EDL = {
    version: 1,
    source: { id: 'source', url: 'blob:source', duration: 10 },
    segments: [
      { id: 'first', start: 0, end: 4 },
      { id: 'last', start: 6, end: 10 },
    ],
    captions: [{ id: 'caption', text: 'My edited caption.', start: 1, end: 2 }],
  }
  const transcript: Transcript = { words: [
    { text: 'Setup.', start: 1, end: 2 },
    { text: 'Deleted.', start: 4, end: 5 },
    { text: 'Conclusion.', start: 8, end: 9 },
  ] }
  const draft: ClarityDraft = {
    targetDuration: '6', audience: 'Developers', mustStay: 'Keep the conclusion.',
  }
  return { edl, transcript, draft }
}

describe('clarity snapshots', () => {
  it('accepts independent copies with identical values', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    expect(isClaritySnapshotCurrent(
      snapshot, structuredClone(edl), structuredClone(transcript), { ...draft },
    )).toBe(true)
    expect(isClaritySnapshotEdlCurrent(snapshot, structuredClone(edl))).toBe(true)
  })

  it('detaches and freezes source, original words, kept ranges, and raw settings', () => {
    const { edl, transcript, draft } = fixture()
    const original = structuredClone({ edl, transcript, draft })
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    expect({ edl, transcript, draft }).toEqual(original)
    edl.source.id = 'replacement'
    edl.segments[0].end = 3
    transcript.words[1].text = 'Changed deleted speech.'
    draft.audience = 'Beginners'
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
    expect(isClaritySnapshotCurrent(
      snapshot, original.edl, original.transcript, original.draft,
    )).toBe(true)
    for (const value of [
      snapshot, snapshot.source, snapshot.words, ...snapshot.words,
      snapshot.keptRanges, ...snapshot.keptRanges, snapshot.draft,
    ]) expect(Object.isFrozen(value)).toBe(true)
  })

  it('ignores caption content, source display metadata, and segment identities', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.captions[0].text = 'A newer manual caption edit.'
    edl.source.width = 1920
    edl.source.height = 1080
    edl.source.fps = 30
    edl.segments[0].id = 'different-structural-id'
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(true)
    expect(snapshot).not.toHaveProperty('captions')
    expect(snapshot.source).not.toHaveProperty('width')
    expect(snapshot.keptRanges[0]).not.toHaveProperty('id')
  })

  it('treats exactly adjacent splits as the same retained coverage in both directions', () => {
    const { edl, transcript, draft } = fixture()
    const unsplit = structuredClone(edl)
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.segments.splice(0, 1,
      { id: 'a', start: 0, end: 1 },
      { id: 'b', start: 1, end: 2 },
      { id: 'c', start: 2, end: 4 },
    )
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(true)
    expect(isClaritySnapshotCurrent(
      captureClaritySnapshot(edl, transcript, draft), unsplit, transcript, draft,
    )).toBe(true)
  })

  it.each([
    ['id', 'another-source'], ['url', 'blob:replacement'], ['duration', 11],
  ] as const)('rejects a changed source %s', (field, value) => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    const next = { ...edl, source: { ...edl.source, [field]: value } }
    expect(isClaritySnapshotEdlCurrent(snapshot, next)).toBe(false)
    expect(isClaritySnapshotCurrent(snapshot, next, transcript, draft)).toBe(false)
  })

  it.each([
    { id: 'first', start: 0, end: 4 - Number.EPSILON * 4 },
    { id: 'first', start: Number.EPSILON, end: 4 },
  ])('does not round away a tiny boundary change: %j', (range) => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.segments[0] = range
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
  })

  it('rejects a tiny positive gap at an otherwise structural split', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.segments.splice(0, 1,
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 2 + Number.EPSILON * 2, end: 4 },
    )
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
  })

  it('rejects changed ranges even when total kept duration is unchanged', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.segments[0].end = 3
    edl.segments[1].start = 5
    expect(isClaritySnapshotEdlCurrent(snapshot, edl)).toBe(false)
  })

  it.each([
    ['text', ' Setup.'], ['start', 1 + Number.EPSILON], ['end', 2 + Number.EPSILON * 2],
  ] as const)('rejects exact word %s changes without normalizing or rounding', (field, value) => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    transcript.words[0] = { ...transcript.words[0], [field]: value }
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
  })

  it('binds deleted words as well as the audible analysis context', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    transcript.words[1].text = 'A changed deleted sentence.'
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
  })

  it.each(['reorder', 'remove', 'append'] as const)('rejects %s of original words', (change) => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    if (change === 'reorder') transcript.words.reverse()
    if (change === 'remove') transcript.words.splice(1, 1)
    if (change === 'append') transcript.words.push({ text: 'Extra.', start: 9, end: 10 })
    expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
  })

  it.each(['targetDuration', 'audience', 'mustStay'] as const)(
    'binds raw %s, including whitespace that would normalize away',
    (field) => {
      const { edl, transcript, draft } = fixture()
      const snapshot = captureClaritySnapshot(edl, transcript, draft)
      draft[field] += ' '
      expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
    },
  )

  it('rejects missing source or transcript', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    expect(isClaritySnapshotEdlCurrent(snapshot, null)).toBe(false)
    expect(isClaritySnapshotCurrent(snapshot, null, transcript, draft)).toBe(false)
    expect(isClaritySnapshotCurrent(snapshot, edl, null, draft)).toBe(false)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'fails closed for a nonfinite source/range/word value: %s',
    (value) => {
      const original = fixture()
      const snapshot = captureClaritySnapshot(original.edl, original.transcript, original.draft)
      for (const field of ['duration', 'range', 'word'] as const) {
        const { edl, transcript, draft } = fixture()
        if (field === 'duration') edl.source.duration = value
        if (field === 'range') edl.segments[0].end = value
        if (field === 'word') transcript.words[0].end = value
        expect(isClaritySnapshotCurrent(snapshot, edl, transcript, draft)).toBe(false)
        expect(() => captureClaritySnapshot(edl, transcript, draft)).toThrow(/invalid/)
      }
    },
  )

  it('does not repair overlapping or reversed kept ranges during comparison', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    edl.segments.splice(0, 1,
      { id: 'a', start: 0, end: 3 },
      { id: 'b', start: 2, end: 4 },
    )
    expect(isClaritySnapshotEdlCurrent(snapshot, edl)).toBe(false)
    edl.segments.reverse()
    expect(isClaritySnapshotEdlCurrent(snapshot, edl)).toBe(false)
  })

  it('fails closed for malformed local draft values', () => {
    const { edl, transcript, draft } = fixture()
    const snapshot = captureClaritySnapshot(edl, transcript, draft)
    for (const invalid of [null, { ...draft, audience: 3 }]) {
      const malformed = invalid as unknown as ClarityDraft
      expect(isClaritySnapshotCurrent(snapshot, edl, transcript, malformed)).toBe(false)
      expect(() => captureClaritySnapshot(edl, transcript, malformed)).toThrow(/invalid/)
    }
  })
})
