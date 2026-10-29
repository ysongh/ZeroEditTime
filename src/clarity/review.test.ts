import { describe, expect, it } from 'vitest'
import { applyRemovedRange, createEdl } from '../edl/edl'
import type { EDL } from '../edl/types'
import type { Transcript } from '../transcript/types'
import type { ClarityAnalysisResult } from './analysis'
import { CLARITY_LIMITS } from './limits'
import {
  createClarityDraft,
  prepareClarityReview,
  summarizeClaritySelection,
  type ClarityDraft,
} from './review'
import { buildClaritySentenceCatalog } from './sentences'

function sourceEdl(): EDL {
  return createEdl({ id: 'source', url: 'blob:source', duration: 12 })
}

function transcript(): Transcript {
  return { words: [
    { text: 'Intro.', start: 1, end: 2 },
    { text: 'Long', start: 3, end: 3.4 },
    { text: 'example.', start: 3.6, end: 5 },
    { text: 'Conclusion.', start: 8, end: 9 },
  ] }
}

function proposal(): ClarityAnalysisResult {
  return { suggestions: [
    {
      sentenceId: 'sentence:1:2',
      reason: 'redundant-example',
      explanation: 'This repeats an earlier example.',
    },
    {
      sentenceId: 'sentence:0:0',
      reason: 'excessive-introduction',
      explanation: 'The introduction can be shortened.',
    },
  ] }
}

describe('createClarityDraft', () => {
  it('returns independent empty settings', () => {
    const first = createClarityDraft()
    const second = createClarityDraft()
    expect(first).toEqual({ targetDuration: '', audience: '', mustStay: '' })
    expect(second).not.toBe(first)
    first.audience = 'Developers'
    expect(second.audience).toBe('')
  })
})

describe('prepareClarityReview', () => {
  it('requires a loaded video and a nonempty transcript', () => {
    expect(prepareClarityReview(null, transcript(), createClarityDraft())).toMatchObject({
      status: 'unavailable', currentDurationSeconds: 0,
    })
    for (const missingTranscript of [null, { words: [] }]) {
      expect(prepareClarityReview(sourceEdl(), missingTranscript, createClarityDraft())).toMatchObject({
        status: 'unavailable', currentDurationSeconds: 12,
      })
    }
  })

  it('uses the committed duration and safely projects the sentence catalog', () => {
    const edl = applyRemovedRange(sourceEdl(), 3, 3.4)
    const draft = {
      targetDuration: ' 6.5 ',
      audience: '  Developers  ',
      mustStay: ' Keep the conclusion. ',
    }
    const prepared = prepareClarityReview(edl, transcript(), draft)

    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.currentDurationSeconds).toBeCloseTo(11.6)
    expect(prepared.context.currentDurationSeconds).toBeCloseTo(11.6)
    expect(prepared.context.settings).toEqual({
      targetDurationSeconds: 6.5,
      audience: 'Developers',
      mustStay: 'Keep the conclusion.',
    })
    expect(prepared.catalog[1].removalRange).toBeNull()
    expect(prepared.catalog[1].text).toBe('Long example.')
    expect(prepared.context.sentences[1]).toMatchObject({
      sentenceId: 'sentence:1:2',
      removable: false,
      parts: [{ kind: 'cut' }, { kind: 'speech', text: 'example.' }],
    })
    expect(JSON.stringify(prepared.context)).not.toContain('Long')
  })

  it('treats a blank target as absent without inventing default settings', () => {
    const prepared = prepareClarityReview(sourceEdl(), transcript(), {
      targetDuration: ' \n\t ', audience: ' ', mustStay: '\t',
    })
    expect(prepared.status).toBe('ready')
    if (prepared.status === 'ready') expect(prepared.context.settings).toEqual({})
  })

  it.each(['60', '60.5', '.5', '5.', '0005.25'])(
    'parses a positive decimal target: %s',
    (targetDuration) => {
      const prepared = prepareClarityReview(sourceEdl(), transcript(), {
        ...createClarityDraft(), targetDuration,
      })
      expect(prepared.status).toBe('ready')
      if (prepared.status === 'ready') {
        expect(prepared.context.settings.targetDurationSeconds).toBe(Number(targetDuration))
      }
    },
  )

  it.each(['0', '-1', 'NaN', 'Infinity', '1e2', '0x10', '1,2', '1 2', '1/2', 'abc', '9'.repeat(400)])(
    'rejects an invalid target without throwing: %s',
    (targetDuration) => {
      const prepared = prepareClarityReview(sourceEdl(), transcript(), {
        ...createClarityDraft(), targetDuration,
      })
      expect(prepared).toMatchObject({ status: 'invalid', currentDurationSeconds: 12 })
      if (prepared.status !== 'ready') expect(prepared.message).toMatch(/positive.*seconds/)
    },
  )

  it.each(['targetDuration', 'audience', 'mustStay'])(
    'rejects nonstring draft %s',
    (field) => {
      const draft = { ...createClarityDraft(), [field]: 5 } as unknown as ClarityDraft
      expect(prepareClarityReview(sourceEdl(), transcript(), draft)).toMatchObject({ status: 'invalid' })
    },
  )

  it.each([null, undefined, 'settings', []])('rejects a malformed draft record: %j', (value) => {
    expect(prepareClarityReview(
      sourceEdl(), transcript(), value as unknown as ClarityDraft,
    )).toMatchObject({ status: 'invalid' })
  })

  it.each([
    ['audience', CLARITY_LIMITS.maxAudienceCharacters],
    ['mustStay', CLARITY_LIMITS.maxMustStayCharacters],
  ])('reports oversized raw %s instructions without truncating or trimming first', (field, limit) => {
    const draft = { ...createClarityDraft(), [field]: ` ${'x'.repeat(limit)}` }
    const prepared = prepareClarityReview(sourceEdl(), transcript(), draft)
    expect(prepared).toMatchObject({ status: 'oversized', currentDurationSeconds: 12 })
    if (prepared.status !== 'ready') expect(prepared.message).toMatch(/never truncated/)
  })

  it('reports oversized transcript context instead of analyzing a shortened transcript', () => {
    const sourceTranscript = { words: [{
      text: 'x'.repeat(CLARITY_LIMITS.maxTranscriptCharacters + 1),
      start: 1,
      end: 2,
    }] }
    expect(prepareClarityReview(sourceEdl(), sourceTranscript, createClarityDraft())).toMatchObject({
      status: 'oversized', currentDurationSeconds: 12,
    })
  })

  it('reports invalid transcript timing as a useful local error', () => {
    const sourceTranscript = transcript()
    sourceTranscript.words[0].end = Number.NaN
    const prepared = prepareClarityReview(sourceEdl(), sourceTranscript, createClarityDraft())
    expect(prepared.status).toBe('invalid')
    if (prepared.status !== 'ready') expect(prepared.message).toMatch(/timings/)
  })

  it('reports invalid kept ranges without displaying a nonfinite duration', () => {
    const edl = sourceEdl()
    edl.segments[0].end = Number.NaN
    expect(prepareClarityReview(edl, transcript(), createClarityDraft())).toMatchObject({
      status: 'invalid', currentDurationSeconds: 0,
    })
  })

  it('reports no kept speech even when silence remains in the edit', () => {
    const sourceTranscript = transcript()
    let edl = sourceEdl()
    for (const word of sourceTranscript.words) {
      edl = applyRemovedRange(edl, word.start, word.end)
    }
    const prepared = prepareClarityReview(edl, sourceTranscript, createClarityDraft())
    expect(prepared.status).toBe('unavailable')
    expect(prepared.currentDurationSeconds).toBeGreaterThan(0)
    if (prepared.status !== 'ready') expect(prepared.message).toMatch(/No kept speech/)
  })

  it('does not modify editor content, transcript, or draft settings', () => {
    const edl = sourceEdl()
    edl.captions = [{ id: 'caption', text: 'Manually edited caption', start: 1, end: 2 }]
    const sourceTranscript = transcript()
    const draft = { ...createClarityDraft(), audience: ' Developers ' }
    const before = structuredClone({ edl, sourceTranscript, draft })

    prepareClarityReview(edl, sourceTranscript, draft)

    expect({ edl, sourceTranscript, draft }).toEqual(before)
  })
})

describe('summarizeClaritySelection', () => {
  it('resolves exact local wording and source ranges in canonical sentence order', () => {
    const edl = applyRemovedRange(sourceEdl(), 6, 7)
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const summary = summarizeClaritySelection(edl, catalog, proposal(), [
      'sentence:1:2', 'sentence:0:0',
    ])

    expect(summary).toEqual({
      suggestions: [
        {
          sentenceId: 'sentence:0:0',
          text: 'Intro.',
          sourceRange: { start: 1, end: 2 },
          reason: 'excessive-introduction',
          explanation: 'The introduction can be shortened.',
          selected: true,
        },
        {
          sentenceId: 'sentence:1:2',
          text: 'Long example.',
          sourceRange: { start: 3, end: 5 },
          reason: 'redundant-example',
          explanation: 'This repeats an earlier example.',
          selected: true,
        },
      ],
      selectedCount: 2,
      currentDurationSeconds: 11,
      proposedDurationSeconds: 8,
    })
    expect(summary.suggestions[0].sourceRange).not.toBe(catalog[0].sourceRange)
  })

  it('counts only selected suggestions and preserves already-existing cuts', () => {
    const edl = applyRemovedRange(sourceEdl(), 6, 7)
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const summary = summarizeClaritySelection(edl, catalog, proposal(), ['sentence:0:0'])

    expect(summary.selectedCount).toBe(1)
    expect(summary.currentDurationSeconds).toBe(11)
    expect(summary.proposedDurationSeconds).toBe(10)
    expect(summary.suggestions.map(({ selected }) => selected)).toEqual([true, false])
  })

  it('keeps silence outside selected sentence ranges in the proposed duration', () => {
    const edl = sourceEdl()
    const prepared = prepareClarityReview(edl, transcript(), {
      ...createClarityDraft(), targetDuration: '1',
    })
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    const summary = summarizeClaritySelection(edl, prepared.catalog, proposal(), ['sentence:1:2'])

    expect(summary.proposedDurationSeconds).toBe(10)
    expect(summary.proposedDurationSeconds).toBeGreaterThan(prepared.context.settings.targetDurationSeconds ?? 0)
  })

  it('leaves duration unchanged for empty proposals and deselected suggestions', () => {
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    expect(summarizeClaritySelection(edl, catalog, { suggestions: [] }, [])).toEqual({
      suggestions: [], selectedCount: 0, currentDurationSeconds: 12, proposedDurationSeconds: 12,
    })
    const deselected = summarizeClaritySelection(edl, catalog, proposal(), [])
    expect(deselected.selectedCount).toBe(0)
    expect(deselected.proposedDurationSeconds).toBe(12)
    expect(deselected.suggestions.every((suggestion) => !suggestion.selected)).toBe(true)
  })

  it('deduplicates selected IDs and duplicate proposal rows deterministically', () => {
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const input = proposal()
    input.suggestions.push({ ...input.suggestions[0], explanation: 'Later duplicate.' })
    const summary = summarizeClaritySelection(edl, catalog, input, [
      'sentence:1:2', 'sentence:1:2',
    ])

    expect(summary.selectedCount).toBe(1)
    expect(summary.proposedDurationSeconds).toBe(10)
    expect(summary.suggestions).toHaveLength(2)
    expect(summary.suggestions[1].explanation).toBe('This repeats an earlier example.')
  })

  it('rejects selected IDs outside the proposal, including otherwise eligible sentences', () => {
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    for (const selected of ['sentence:3:3', 'sentence:99:99']) {
      expect(() => summarizeClaritySelection(edl, catalog, proposal(), [selected])).toThrow(/not part/)
    }
  })

  it('rejects unknown or protected proposal IDs even if those suggestions are deselected', () => {
    const edl = applyRemovedRange(sourceEdl(), 3, 3.4)
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    expect(() => summarizeClaritySelection(edl, catalog, proposal(), [])).toThrow(/invalid/)
    const unknown = { suggestions: [{ ...proposal().suggestions[0], sentenceId: 'sentence:99:99' }] }
    expect(() => summarizeClaritySelection(edl, catalog, unknown, [])).toThrow(/invalid/)
  })

  it('rejects model wording or timing fields instead of using them for review cards', () => {
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const withModelText = { suggestions: [{
      ...proposal().suggestions[0],
      text: 'Invented sentence.',
      sourceRange: { start: 0, end: 12 },
    }] }

    expect(() => summarizeClaritySelection(edl, catalog, withModelText, [])).toThrow(/invalid/)
  })

  it('rejects proposals removing all speech even when only part is selected and silence remains', () => {
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const allSpeech = proposal()
    allSpeech.suggestions.push({
      sentenceId: 'sentence:3:3', reason: 'off-topic-detail', explanation: 'Remove the ending.',
    })
    expect(() => summarizeClaritySelection(edl, catalog, allSpeech, ['sentence:0:0'])).toThrow(/invalid/)
  })

  it('preserves exact transcript text in review cards', () => {
    const sourceTranscript = transcript()
    sourceTranscript.words[0].text = '  Intro!  '
    const edl = sourceEdl()
    const catalog = buildClaritySentenceCatalog(sourceTranscript, edl)
    expect(summarizeClaritySelection(edl, catalog, proposal(), []).suggestions[0].text).toBe('  Intro!  ')
  })

  it('does not mutate EDL segments, caption edits, catalog, proposal, or selected IDs', () => {
    const edl = applyRemovedRange(sourceEdl(), 6, 7)
    edl.captions = [{ id: 'caption', text: 'User caption edit', start: 1, end: 2 }]
    const catalog = buildClaritySentenceCatalog(transcript(), edl)
    const result = proposal()
    const selectedIds = ['sentence:1:2']
    const before = structuredClone({ edl, catalog, result, selectedIds })
    Object.freeze(edl.captions[0])
    Object.freeze(edl.captions)
    edl.segments.forEach(Object.freeze)
    Object.freeze(edl.segments)
    Object.freeze(edl)

    const summary = summarizeClaritySelection(edl, catalog, result, selectedIds)

    expect(summary.proposedDurationSeconds).toBe(9)
    expect({ edl, catalog, result, selectedIds }).toEqual(before)
    expect(summary).not.toHaveProperty('edl')
    expect(summary).not.toHaveProperty('history')
  })
})
