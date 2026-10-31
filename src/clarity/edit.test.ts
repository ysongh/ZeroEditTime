import { describe, expect, it } from 'vitest'
import { applyRemovedRange, createEdl, isSourceTimeKept, splitSegmentAt, totalKeptDuration } from '../edl/edl'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import type { ClarityAnalysisResult, ClaritySuggestion } from './analysis'
import { deriveClarityEdit, type ClarityCutProposal } from './edit'
import { captureClaritySnapshot } from './freshness'
import { createClarityDraft, type ClarityDraft } from './review'

function suggestion(sentenceId: string): ClaritySuggestion {
  return { sentenceId, reason: 'redundant-example', explanation: 'This repeats an earlier example.' }
}

function fixture() {
  const edl = createEdl({ id: 'source', url: 'blob:source', duration: 12 })
  const transcript: Transcript = { words: [
    { text: 'Setup.', start: 1, end: 2 },
    { text: 'Repeated', start: 3, end: 3.4 },
    { text: 'example.', start: 3.6, end: 5 },
    { text: 'Aside.', start: 6, end: 7 },
    { text: 'Conclusion.', start: 8, end: 9 },
  ] }
  const draft: ClarityDraft = { ...createClarityDraft(), targetDuration: '5', mustStay: 'Keep setup and conclusion.' }
  const result: ClarityAnalysisResult = { suggestions: [suggestion('sentence:3:3'), suggestion('sentence:1:2')] }
  const proposal: ClarityCutProposal = {
    snapshot: captureClaritySnapshot(edl, transcript, draft),
    result,
    selectedIds: ['sentence:3:3', 'sentence:1:2'],
  }
  return { edl, transcript, draft, proposal }
}

function bounds(edl: EDL) {
  return edl.segments.map(({ start, end }) => [start, end])
}

describe('deriveClarityEdit', () => {
  it('derives all selected whole-sentence cuts in original order without forcing the target', () => {
    const { edl, transcript, draft, proposal } = fixture()
    const result = deriveClarityEdit(edl, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selectedCount).toBe(2)
    expect(bounds(result.edl)).toEqual([[0, 3], [5, 6], [7, 12]])
    expect(totalKeptDuration(result.edl)).toBe(9)
    expect(totalKeptDuration(result.edl)).toBeGreaterThan(Number(draft.targetDuration))
    expect(isSourceTimeKept(result.edl, 1.5)).toBe(true)
    expect(isSourceTimeKept(result.edl, 8.5)).toBe(true)
  })

  it('removes only selected suggestions and preserves existing cuts and outside silence', () => {
    const { edl: original, transcript, draft, proposal } = fixture()
    const edl = applyRemovedRange(original, 10, 11)
    proposal.snapshot = captureClaritySnapshot(edl, transcript, draft)
    proposal.selectedIds = ['sentence:1:2']
    const result = deriveClarityEdit(edl, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selectedCount).toBe(1)
    expect(bounds(result.edl)).toEqual([[0, 3], [5, 10], [11, 12]])
    expect(isSourceTimeKept(result.edl, 6.5)).toBe(true)
    expect(totalKeptDuration(result.edl)).toBe(9)
  })

  it.each(['empty proposal', 'deselected proposal'])(
    'returns the same EDL object for an %s so no history commit is needed',
    (kind) => {
      const { edl, transcript, draft, proposal } = fixture()
      proposal.selectedIds = []
      if (kind === 'empty proposal') proposal.result = { suggestions: [] }
      const result = deriveClarityEdit(edl, transcript, draft, proposal)
      expect(result).toEqual({ ok: true, edl, selectedCount: 0 })
      if (result.ok) expect(result.edl).toBe(edl)
    },
  )

  it('deduplicates both proposal rows and selections and yields the same source-order edit', () => {
    const { edl, transcript, draft, proposal } = fixture()
    const expected = deriveClarityEdit(edl, transcript, draft, proposal)
    proposal.result.suggestions.push({ ...suggestion('sentence:1:2'), explanation: 'Later duplicate.' })
    proposal.selectedIds = ['sentence:1:2', 'sentence:3:3', 'sentence:1:2']
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toEqual(expected)
  })

  it('preserves the latest caption objects and source metadata instead of restoring analyzed content', () => {
    const { edl: analyzed, transcript, draft, proposal } = fixture()
    const latest: EDL = {
      ...analyzed,
      source: { ...analyzed.source, width: 1920, height: 1080 },
      captions: [{ id: 'caption', start: 3, end: 5, text: 'Hand-edited caption kept verbatim.' }],
    }
    const result = deriveClarityEdit(latest, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.edl.source).toBe(latest.source)
    expect(result.edl.captions).toBe(latest.captions)
    expect(result.edl.captions[0]).toBe(latest.captions[0])
    expect(analyzed.captions).toEqual([])
  })

  it('resolves whole sentences across equivalent adjacent splits in the latest EDL', () => {
    const { edl: analyzed, transcript, draft, proposal } = fixture()
    const latest = splitSegmentAt(analyzed, 4)
    const result = deriveClarityEdit(latest, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    if (result.ok) expect(bounds(result.edl)).toEqual([[0, 3], [5, 6], [7, 12]])
  })

  it.each(['source', 'source URL', 'source duration', 'transcript wording', 'transcript timing', 'ranges', 'settings'])(
    'rejects changed %s before deriving any cuts',
    (change) => {
      const { edl, transcript, draft, proposal } = fixture()
      if (change === 'source') edl.source.id = 'replacement'
      if (change === 'source URL') edl.source.url = 'blob:replacement'
      if (change === 'source duration') edl.source.duration = 13
      if (change === 'transcript wording') transcript.words[1].text = 'Different'
      if (change === 'transcript timing') transcript.words[1].start += 0.01
      if (change === 'ranges') edl.segments[0].end = 11
      if (change === 'settings') draft.mustStay = 'Keep every example.'
      const before = structuredClone({ edl, transcript, draft, proposal })
      expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'stale' })
      expect({ edl, transcript, draft, proposal }).toEqual(before)
    },
  )

  it('rejects replay against an already-applied EDL rather than allocating another history edit', () => {
    const { edl, transcript, draft, proposal } = fixture()
    const first = deriveClarityEdit(edl, transcript, draft, proposal)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const before = structuredClone(first.edl)
    expect(deriveClarityEdit(first.edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'stale' })
    expect(first.edl).toEqual(before)
  })

  it.each(['sentence:99:99', 'sentence:4:4'])(
    'rejects selected ID %s outside the proposal, even if it is otherwise removable',
    (sentenceId) => {
      const { edl, transcript, draft, proposal } = fixture()
      proposal.selectedIds = [sentenceId]
      expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
    },
  )

  it.each([null, 'sentence:1:2', [3]])('rejects malformed selection %j without partially applying', (selection) => {
    const { edl, transcript, draft, proposal } = fixture()
    proposal.selectedIds = selection as unknown as readonly string[]
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
    expect(bounds(edl)).toEqual([[0, 12]])
  })

  it('rejects unknown suggestions even when deselected instead of accepting a partial proposal', () => {
    const { edl, transcript, draft, proposal } = fixture()
    proposal.result.suggestions.push(suggestion('sentence:99:99'))
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
    expect(bounds(edl)).toEqual([[0, 12]])
  })

  it.each(['partial word', 'fragmented silence'])(
    'rejects a sentence protected by an existing %s cut and keeps that cut',
    (kind) => {
      const { edl: original, transcript, draft, proposal } = fixture()
      const edl = kind === 'partial word'
        ? applyRemovedRange(original, 3.1, 3.2)
        : applyRemovedRange(original, 3.45, 3.55)
      proposal.snapshot = captureClaritySnapshot(edl, transcript, draft)
      proposal.selectedIds = ['sentence:3:3']
      const before = structuredClone(edl)
      expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
      expect(edl).toEqual(before)
      // A separately valid proposal can still remove another sentence while
      // retaining the protected speech and the precise pre-existing gap.
      proposal.result = { suggestions: [suggestion('sentence:3:3')] }
      const valid = deriveClarityEdit(edl, transcript, draft, proposal)
      expect(valid.ok).toBe(true)
      if (valid.ok) {
        expect(valid.edl.segments.slice(0, 2).map(({ start, end }) => [start, end])).toEqual(
          kind === 'partial word' ? [[0, 3.1], [3.2, 6]] : [[0, 3.45], [3.55, 6]],
        )
      }
    },
  )

  it('rejects removal ranges overlapping a retained neighboring sentence', () => {
    const { edl, transcript, draft, proposal } = fixture()
    transcript.words[0].end = 3.1
    proposal.snapshot = captureClaritySnapshot(edl, transcript, draft)
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('allows exact sentence boundaries that touch retained neighbors without padding into them', () => {
    const { edl, transcript, draft, proposal } = fixture()
    transcript.words[0].end = 3
    transcript.words[3].start = 5
    proposal.snapshot = captureClaritySnapshot(edl, transcript, draft)
    proposal.selectedIds = ['sentence:1:2']
    const result = deriveClarityEdit(edl, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(bounds(result.edl)).toEqual([[0, 3], [5, 12]])
    expect(isSourceTimeKept(result.edl, 2.99)).toBe(true)
    expect(isSourceTimeKept(result.edl, 5)).toBe(true)
  })

  it('rejects proposals removing all kept speech even if silence remains or only a subset is selected', () => {
    const { edl, transcript, draft, proposal } = fixture()
    proposal.result.suggestions.push(suggestion('sentence:0:0'), suggestion('sentence:4:4'))
    proposal.selectedIds = ['sentence:1:2']
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('rejects model ranges or replacement text rather than executing them', () => {
    const { edl, transcript, draft, proposal } = fixture()
    proposal.result.suggestions[0] = {
      ...proposal.result.suggestions[0],
      sourceRange: { start: 0, end: 12 }, text: 'Model replacement.',
    } as ClaritySuggestion
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('revalidates raw draft values even when a snapshot was captured outside ready preparation', () => {
    const { edl, transcript, draft, proposal } = fixture()
    draft.targetDuration = '-1'
    proposal.snapshot = captureClaritySnapshot(edl, transcript, draft)
    expect(deriveClarityEdit(edl, transcript, draft, proposal)).toMatchObject({ ok: false, kind: 'invalid' })
  })

  it('leaves deeply frozen inputs and the captured proposal unchanged', () => {
    const { edl, transcript, draft, proposal } = fixture()
    edl.captions = [{ id: 'caption', start: 3, end: 5, text: 'Current caption.' }]
    const before = structuredClone({ edl, transcript, draft, proposal })
    for (const item of [
      edl, edl.source, edl.segments, ...edl.segments, edl.captions, ...edl.captions,
      transcript, transcript.words, ...transcript.words, draft,
      proposal, proposal.result, proposal.result.suggestions, ...proposal.result.suggestions, proposal.selectedIds,
    ]) Object.freeze(item)
    const result = deriveClarityEdit(edl, transcript, draft, proposal)
    expect(result.ok).toBe(true)
    expect({ edl, transcript, draft, proposal }).toEqual(before)
    if (result.ok) expect(result.edl.captions).toBe(edl.captions)
  })
})
