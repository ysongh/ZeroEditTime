import { describe, expect, it } from 'vitest'
import { applyRemovedRange, createEdl, splitSegmentAt } from '../edl/edl'
import type { EDL } from '../edl/types'
import type { Transcript, Word } from '../transcript/types'
import {
  buildClaritySentenceCatalog,
  buildClaritySentenceContext,
} from './sentences'

const SOURCE = { id: 'source-1', url: 'blob:source-1', duration: 12 }

function transcript(...specs: Array<[string, number, number]>): Transcript {
  return {
    words: specs.map(([text, start, end]) => ({ text, start, end })),
  }
}

function fullEdl(): EDL {
  return createEdl(SOURCE)
}

const THREE_WORD_SENTENCE = transcript(
  ['First', 1, 2],
  ['middle', 2.2, 3],
  ['last.', 3.3, 4],
)

describe('buildClaritySentenceCatalog', () => {
  it('uses original sentence indices, exact local text, and source seconds', () => {
    const sourceTranscript = transcript(
      ['Intro.', 1, 2],
      ['Repeated', 3, 3.5],
      ['detail.', 3.8, 4.4],
      ['Conclusion.', 7, 8],
    )

    const catalog = buildClaritySentenceCatalog(sourceTranscript, fullEdl())

    expect(catalog).toEqual([
      {
        id: 'sentence:0:0',
        startIndex: 0,
        endIndex: 0,
        text: 'Intro.',
        sourceRange: { start: 1, end: 2 },
        removalRange: { start: 1, end: 2 },
        protectionReasons: [],
        keptDurationSeconds: 1,
        contextParts: [{ kind: 'speech', text: 'Intro.' }],
      },
      {
        id: 'sentence:1:2',
        startIndex: 1,
        endIndex: 2,
        text: 'Repeated detail.',
        sourceRange: { start: 3, end: 4.4 },
        removalRange: { start: 3, end: 4.4 },
        protectionReasons: [],
        keptDurationSeconds: 4.4 - 3,
        contextParts: [{ kind: 'speech', text: 'Repeated detail.' }],
      },
      {
        id: 'sentence:3:3',
        startIndex: 3,
        endIndex: 3,
        text: 'Conclusion.',
        sourceRange: { start: 7, end: 8 },
        removalRange: { start: 7, end: 8 },
        protectionReasons: [],
        keptDurationSeconds: 1,
        contextParts: [{ kind: 'speech', text: 'Conclusion.' }],
      },
    ])
  })

  it('keeps repeated text distinct and does not renumber sentences after cuts', () => {
    const sourceTranscript = transcript(
      ['Same.', 1, 2],
      ['Same.', 3, 4],
      ['End.', 5, 6],
    )
    const original = buildClaritySentenceCatalog(sourceTranscript, fullEdl())
    const edited = buildClaritySentenceCatalog(
      sourceTranscript,
      applyRemovedRange(fullEdl(), 1, 2),
    )

    expect(original.map((sentence) => sentence.id)).toEqual([
      'sentence:0:0',
      'sentence:1:1',
      'sentence:2:2',
    ])
    expect(edited.map((sentence) => sentence.id)).toEqual([
      'sentence:1:1',
      'sentence:2:2',
    ])
    expect(edited[0].sourceRange).toEqual({ start: 3, end: 4 })
    expect(buildClaritySentenceCatalog(sourceTranscript, fullEdl())).toEqual(
      original,
    )
  })

  it('reuses punctuation grouping, including closing quotes and an unpunctuated tail', () => {
    const sourceTranscript = transcript(
      ['He', 1, 1.3],
      ['said', 1.4, 1.7],
      ['"go."', 1.8, 2],
      ['Trailing', 3, 3.4],
      ['thought', 3.5, 4],
    )

    expect(
      buildClaritySentenceCatalog(sourceTranscript, fullEdl()).map(
        ({ id, text }) => ({ id, text }),
      ),
    ).toEqual([
      { id: 'sentence:0:2', text: 'He said "go."' },
      { id: 'sentence:3:4', text: 'Trailing thought' },
    ])
    expect(
      buildClaritySentenceCatalog(
        transcript(['No', 1, 2], ['punctuation', 3, 4]),
        fullEdl(),
      ),
    ).toHaveLength(1)
  })

  it('preserves per-word text without rewriting or whitespace normalization', () => {
    const sourceTranscript = transcript(['  Keep', 1, 2], ['THIS!  ', 2, 3])
    const [sentence] = buildClaritySentenceCatalog(sourceTranscript, fullEdl())

    expect(sentence.text).toBe('  Keep THIS!  ')
    expect(sentence.contextParts).toEqual([
      { kind: 'speech', text: '  Keep THIS!  ' },
    ])
  })

  it('does not extend a removal into neighboring words or surrounding silence', () => {
    const sourceTranscript = transcript(
      ['Before.', 0.1, 0.9],
      ['Target.', 1, 2],
      ['After.', 2.1, 3],
    )
    const edl = applyRemovedRange(fullEdl(), 6, 8)

    expect(buildClaritySentenceCatalog(sourceTranscript, edl)[1]).toMatchObject({
      sourceRange: { start: 1, end: 2 },
      removalRange: { start: 1, end: 2 },
      protectionReasons: [],
    })
  })

  it('treats adjacent structural EDL splits as continuous kept speech', () => {
    const split = splitSegmentAt(splitSegmentAt(fullEdl(), 1.5), 2.5)
    const [sentence] = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, split)

    expect(sentence.removalRange).toEqual({ start: 1, end: 4 })
    expect(sentence.protectionReasons).toEqual([])
    expect(sentence.keptDurationSeconds).toBe(3)
    expect(sentence.contextParts).toEqual([
      { kind: 'speech', text: 'First middle last.' },
    ])
  })

  it('protects a sentence with a deleted word and never reconstructs that word in context', () => {
    const edl = applyRemovedRange(fullEdl(), 2.2, 3)
    const [sentence] = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)

    expect(sentence.text).toBe('First middle last.')
    expect(sentence.removalRange).toBeNull()
    expect(sentence.protectionReasons).toEqual(['existing-cut'])
    expect(sentence.keptDurationSeconds).toBeCloseTo(2.2)
    expect(sentence.contextParts).toEqual([
      { kind: 'speech', text: 'First' },
      { kind: 'cut' },
      { kind: 'speech', text: 'last.' },
    ])
  })

  it.each([
    { cut: [1, 2], parts: [{ kind: 'cut' }, { kind: 'speech', text: 'middle last.' }] },
    { cut: [3.3, 4], parts: [{ kind: 'speech', text: 'First middle' }, { kind: 'cut' }] },
  ])('marks a fully deleted leading or trailing word: $cut', ({ cut, parts }) => {
    const [sentence] = buildClaritySentenceCatalog(
      THREE_WORD_SENTENCE,
      applyRemovedRange(fullEdl(), cut[0], cut[1]),
    )

    expect(sentence.removalRange).toBeNull()
    expect(sentence.contextParts).toEqual(parts)
  })

  it('protects a cut through an internal pause even when every word remains whole', () => {
    const edl = applyRemovedRange(fullEdl(), 2.05, 2.15)
    const [sentence] = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)

    expect(sentence.removalRange).toBeNull()
    expect(sentence.protectionReasons).toEqual(['existing-cut'])
    expect(sentence.keptDurationSeconds).toBeCloseTo(2.9)
    expect(sentence.contextParts).toEqual([
      { kind: 'speech', text: 'First' },
      { kind: 'cut' },
      { kind: 'speech', text: 'middle last.' },
    ])
  })

  it('does not merge even a tiny positive cut gap into a whole sentence', () => {
    const edl = applyRemovedRange(fullEdl(), 2.05, 2.050000001)
    const [sentence] = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)

    expect(sentence.removalRange).toBeNull()
    expect(sentence.protectionReasons).toEqual(['existing-cut'])
    expect(sentence.contextParts).toContainEqual({ kind: 'cut' })
  })

  it('protects a clipped word even when its midpoint is kept', () => {
    const edl = applyRemovedRange(fullEdl(), 1, 1.2)
    const [sentence] = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)

    expect(sentence.removalRange).toBeNull()
    expect(sentence.protectionReasons).toEqual(['existing-cut'])
    expect(sentence.keptDurationSeconds).toBeCloseTo(2.8)
    expect(sentence.contextParts).toContainEqual({ kind: 'partial-word' })
    expect(sentence.contextParts.filter((part) => part.kind === 'speech')).toEqual([
      { kind: 'speech', text: 'middle last.' },
    ])
    expect(JSON.stringify(buildClaritySentenceContext([sentence]))).not.toContain('First')
  })

  it('retains protected context when only part of a word remains audible', () => {
    const edl: EDL = {
      ...fullEdl(),
      segments: [{ id: 'partial', start: 1.1, end: 1.2 }],
    }
    const catalog = buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)

    expect(catalog).toHaveLength(1)
    expect(catalog[0].removalRange).toBeNull()
    expect(catalog[0].keptDurationSeconds).toBeCloseTo(0.1)
    expect(catalog[0].contextParts).toContainEqual({ kind: 'partial-word' })
    expect(catalog[0].contextParts.some((part) => part.kind === 'speech')).toBe(false)
    expect(JSON.stringify(buildClaritySentenceContext(catalog))).not.toContain('First')
  })

  it('does not reconstruct a word whose two edges survive an internal cut', () => {
    const catalog = buildClaritySentenceCatalog(
      transcript(['Splitword.', 1, 3]),
      applyRemovedRange(fullEdl(), 1.8, 2.2),
    )

    expect(catalog[0].removalRange).toBeNull()
    expect(catalog[0].keptDurationSeconds).toBeCloseTo(1.6)
    expect(buildClaritySentenceContext(catalog)[0].parts).toEqual([
      { kind: 'partial-word' },
      { kind: 'cut' },
      { kind: 'partial-word' },
    ])
  })

  it('omits fully removed speech even if silence inside its sentence remains kept', () => {
    let edl = fullEdl()
    for (const word of THREE_WORD_SENTENCE.words) {
      edl = applyRemovedRange(edl, word.start, word.end)
    }

    expect(edl.segments.length).toBeGreaterThan(0)
    expect(buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)).toEqual([])
  })

  it('allows touching sentence boundaries without treating them as overlap', () => {
    const catalog = buildClaritySentenceCatalog(
      transcript(['One.', 1, 2], ['Two.', 2, 3]),
      fullEdl(),
    )

    expect(catalog.every((sentence) => sentence.removalRange !== null)).toBe(true)
    expect(catalog.every((sentence) => sentence.protectionReasons.length === 0)).toBe(true)
  })

  it('protects all sentences sharing speech, including a non-adjacent overlapping word', () => {
    const catalog = buildClaritySentenceCatalog(
      transcript(['Long.', 1, 5], ['Middle.', 2, 3], ['Later.', 4, 4.5]),
      fullEdl(),
    )

    expect(catalog).toHaveLength(3)
    for (const sentence of catalog) {
      expect(sentence.removalRange).toBeNull()
      expect(sentence.protectionReasons).toEqual(['overlapping-speech'])
    }
  })

  it('uses the complete envelope when words overlap within one sentence', () => {
    const [sentence] = buildClaritySentenceCatalog(
      transcript(['Long', 1, 3.5], ['thought.', 2, 3]),
      fullEdl(),
    )

    expect(sentence.sourceRange).toEqual({ start: 1, end: 3.5 })
    expect(sentence.removalRange).toEqual({ start: 1, end: 3.5 })
    expect(sentence.protectionReasons).toEqual([])
    expect(sentence.keptDurationSeconds).toBe(2.5)
  })

  it('reports both existing cuts and overlapping retained speech', () => {
    const [sentence] = buildClaritySentenceCatalog(
      transcript(['First.', 1, 3], ['Second.', 2, 4]),
      applyRemovedRange(fullEdl(), 1, 1.2),
    )

    expect(sentence.removalRange).toBeNull()
    expect(sentence.protectionReasons).toEqual(['existing-cut', 'overlapping-speech'])
  })

  it('returns an empty catalog for an empty transcript or empty valid EDL', () => {
    expect(buildClaritySentenceCatalog({ words: [] }, fullEdl())).toEqual([])
    expect(
      buildClaritySentenceCatalog(THREE_WORD_SENTENCE, { ...fullEdl(), segments: [] }),
    ).toEqual([])
    expect(buildClaritySentenceContext([])).toEqual([])
  })

  it.each([
    ['blank text', { text: ' \t ' }],
    ['nonstring text', { text: 7 }],
    ['nonfinite start', { start: Number.NaN }],
    ['infinite end', { end: Number.POSITIVE_INFINITY }],
    ['negative start', { start: -1 }],
    ['zero duration', { end: 1 }],
    ['reversed range', { end: 0.5 }],
    ['out of source', { end: 13 }],
  ])('rejects a transcript word with %s', (_label, invalidFields) => {
    const invalidWord = { text: 'Word.', start: 1, end: 2, ...invalidFields } as Word

    expect(() => buildClaritySentenceCatalog({ words: [invalidWord] }, fullEdl())).toThrow()
  })

  it('rejects non-monotonic word starts instead of reordering the transcript', () => {
    expect(() =>
      buildClaritySentenceCatalog(
        transcript(['Later', 3, 4], ['earlier.', 1, 2]),
        fullEdl(),
      ),
    ).toThrow()
  })

  it.each([
    ['negative start', [{ id: 'a', start: -1, end: 2 }]],
    ['nonfinite start', [{ id: 'a', start: Number.NaN, end: 2 }]],
    ['infinite end', [{ id: 'a', start: 1, end: Number.POSITIVE_INFINITY }]],
    ['zero duration', [{ id: 'a', start: 1, end: 1 }]],
    ['reversed range', [{ id: 'a', start: 2, end: 1 }]],
    ['out of source', [{ id: 'a', start: 1, end: 13 }]],
    ['unordered segments', [{ id: 'a', start: 3, end: 4 }, { id: 'b', start: 1, end: 2 }]],
    ['overlapping segments', [{ id: 'a', start: 1, end: 3 }, { id: 'b', start: 2, end: 4 }]],
  ])('rejects EDL %s', (_label, segments) => {
    expect(() =>
      buildClaritySentenceCatalog(THREE_WORD_SENTENCE, { ...fullEdl(), segments }),
    ).toThrow()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects an invalid source duration: %s',
    (duration) => {
      const edl = { ...fullEdl(), source: { ...SOURCE, duration } }
      expect(() => buildClaritySentenceCatalog(THREE_WORD_SENTENCE, edl)).toThrow()
    },
  )

  it('does not mutate the transcript, EDL, captions, or existing kept segments', () => {
    const sourceTranscript = structuredClone(THREE_WORD_SENTENCE)
    const edl = applyRemovedRange(fullEdl(), 2.2, 3)
    edl.captions = [{ id: 'caption', text: 'User-edited caption', start: 1, end: 4 }]
    const beforeTranscript = structuredClone(sourceTranscript)
    const beforeEdl = structuredClone(edl)

    const catalog = buildClaritySentenceCatalog(sourceTranscript, edl)
    buildClaritySentenceContext(catalog)

    expect(sourceTranscript).toEqual(beforeTranscript)
    expect(edl).toEqual(beforeEdl)
  })
})

describe('buildClaritySentenceContext', () => {
  it('exposes only safe current speech, local durations, IDs, and removability', () => {
    const sourceTranscript = transcript(
      ['Keep.', 0, 0.5],
      ['First', 1, 2],
      ['deleted', 2.2, 3],
      ['last.', 3.3, 4],
    )
    const catalog = buildClaritySentenceCatalog(
      sourceTranscript,
      applyRemovedRange(fullEdl(), 2.2, 3),
    )
    const context = buildClaritySentenceContext(catalog)

    expect(context).toEqual([
      {
        sentenceId: 'sentence:0:0',
        removable: true,
        durationSeconds: 0.5,
        parts: [{ kind: 'speech', text: 'Keep.' }],
      },
      {
        sentenceId: 'sentence:1:3',
        removable: false,
        durationSeconds: catalog[1].keptDurationSeconds,
        parts: [
          { kind: 'speech', text: 'First' },
          { kind: 'cut' },
          { kind: 'speech', text: 'last.' },
        ],
      },
    ])
    expect(context[1].durationSeconds).toBeCloseTo(2.2)
    expect(JSON.stringify(context)).not.toContain('deleted')
  })

  it('returns independent part arrays and objects', () => {
    const catalog = buildClaritySentenceCatalog(
      THREE_WORD_SENTENCE,
      applyRemovedRange(fullEdl(), 2.2, 3),
    )
    const before = structuredClone(catalog)
    const context = buildClaritySentenceContext(catalog)

    expect(context[0].parts).not.toBe(catalog[0].contextParts)
    context[0].parts.forEach((part, index) => {
      expect(part).not.toBe(catalog[0].contextParts[index])
    })
    expect(catalog).toEqual(before)
  })
})
