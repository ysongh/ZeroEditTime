import { describe, expect, it } from 'vitest'
import { applyRemovedRange, createEdl } from '../edl/edl'
import {
  buildClarityAnalysisContext,
  validateClarityAnalysisContext,
  type ClarityAnalysisContext,
} from './context'
import { CLARITY_LIMITS } from './limits'
import {
  buildClaritySentenceCatalog,
  type ClaritySentenceContext,
} from './sentences'

function sentence(index = 0): ClaritySentenceContext {
  return {
    sentenceId: `sentence:${index}:${index}`,
    removable: true,
    durationSeconds: 1,
    parts: [{ kind: 'speech', text: `Sentence ${index}.` }],
  }
}

function context(): ClarityAnalysisContext {
  return {
    sentences: [sentence(0), sentence(1)],
    currentDurationSeconds: 10,
    settings: {},
  }
}

function expectFailure(value: unknown, kind: 'invalid' | 'oversized' = 'invalid') {
  expect(validateClarityAnalysisContext(value)).toEqual({
    ok: false,
    kind,
    message: expect.any(String),
  })
  const result = validateClarityAnalysisContext(value)
  if (!result.ok) expect(result.message.trim().length).toBeGreaterThan(0)
}

describe('validateClarityAnalysisContext', () => {
  it('preserves transcript wording while trimming optional analysis instructions', () => {
    const input = {
      sentences: [{ ...sentence(), parts: [{ kind: 'speech', text: '  Exact\n wording.  ' }] }],
      currentDurationSeconds: 10,
      settings: {
        targetDurationSeconds: 6.5,
        audience: '  Developers\nusing the API.  ',
        mustStay: '\tKeep the caveats.\n',
      },
    }

    expect(validateClarityAnalysisContext(input)).toEqual({
      ok: true,
      context: {
        sentences: input.sentences,
        currentDurationSeconds: 10,
        settings: {
          targetDurationSeconds: 6.5,
          audience: 'Developers\nusing the API.',
          mustStay: 'Keep the caveats.',
        },
      },
    })
  })

  it('omits blank optional instructions and permits a target longer than the current edit', () => {
    const input = {
      ...context(),
      settings: { targetDurationSeconds: 60, audience: ' \n ', mustStay: '\t' },
    }

    expect(validateClarityAnalysisContext(input)).toEqual({
      ok: true,
      context: { ...context(), settings: { targetDurationSeconds: 60 } },
    })
  })

  it('strips unknown fields at every request level without leaking removed text or timing', () => {
    const input = {
      ...context(),
      sourceUrl: 'blob:private',
      prompt: 'untrusted prompt',
      settings: { audience: ' Devs ', model: 'untrusted model' },
      sentences: [{
        ...sentence(),
        removable: false,
        text: 'Deleted original text.',
        sourceRange: { start: 1, end: 2 },
        parts: [
          { kind: 'speech', text: 'Kept.', timestamp: 1 },
          { kind: 'cut', text: 'Deleted secret.' },
          { kind: 'partial-word', text: 'Reconstructed secret.' },
        ],
      }],
    }
    const before = structuredClone(input)

    expect(validateClarityAnalysisContext(input)).toEqual({
      ok: true,
      context: {
        currentDurationSeconds: 10,
        settings: { audience: 'Devs' },
        sentences: [{
          sentenceId: 'sentence:0:0',
          removable: false,
          durationSeconds: 1,
          parts: [
            { kind: 'speech', text: 'Kept.' },
            { kind: 'cut' },
            { kind: 'partial-word' },
          ],
        }],
      },
    })
    expect(input).toEqual(before)
  })

  it('accepts protected context with only partial-word evidence', () => {
    const input = {
      ...context(),
      sentences: [{
        ...sentence(),
        removable: false,
        parts: [{ kind: 'cut' }, { kind: 'partial-word' }, { kind: 'cut' }],
      }],
    }

    expect(validateClarityAnalysisContext(input)).toEqual({ ok: true, context: input })
  })

  it('accepts protected intact speech and noncontiguous original word spans', () => {
    const input = {
      ...context(),
      sentences: [
        { ...sentence(), sentenceId: 'sentence:0:3', removable: false },
        { ...sentence(), sentenceId: 'sentence:8:12' },
      ],
    }

    expect(validateClarityAnalysisContext(input)).toEqual({ ok: true, context: input })
  })

  it('allows only tiny floating error above the current duration', () => {
    const input = {
      ...context(),
      sentences: [{ ...sentence(), durationSeconds: 10 + 5e-10 }],
    }
    expect(validateClarityAnalysisContext(input).ok).toBe(true)
    expectFailure({
      ...input,
      sentences: [{ ...sentence(), durationSeconds: 10 + 2e-9 }],
    })
  })

  it.each([null, undefined, 5, 'context', []])('rejects a non-record context: %j', (value) => {
    expectFailure(value)
  })

  it.each(['sentences', 'currentDurationSeconds', 'settings'])(
    'requires %s',
    (field) => {
      const input: Record<string, unknown> = { ...context() }
      delete input[field]
      expectFailure(input)
    },
  )

  it.each([undefined, null, {}, 'sentences', []])('rejects missing or empty speech: %j', (sentences) => {
    expectFailure({ ...context(), sentences })
  })

  it.each([null, [], 'settings', 1])('rejects non-record settings: %j', (settings) => {
    expectFailure({ ...context(), settings })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', null])(
    'rejects an invalid current duration: %j',
    (currentDurationSeconds) => {
      expectFailure({ ...context(), currentDurationSeconds })
    },
  )

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null])(
    'rejects an invalid target duration: %j',
    (targetDurationSeconds) => {
      expectFailure({ ...context(), settings: { targetDurationSeconds } })
    },
  )

  it.each(['audience', 'mustStay'])('rejects wrong types for %s', (field) => {
    for (const value of [null, 1, false, [], {}]) {
      expectFailure({ ...context(), settings: { [field]: value } })
    }
  })

  it.each([
    ['missing ID', { sentenceId: undefined }],
    ['nonstring ID', { sentenceId: 1 }],
    ['missing removable', { removable: undefined }],
    ['nonboolean removable', { removable: 'true' }],
    ['missing duration', { durationSeconds: undefined }],
    ['zero duration', { durationSeconds: 0 }],
    ['negative duration', { durationSeconds: -1 }],
    ['NaN duration', { durationSeconds: Number.NaN }],
    ['infinite duration', { durationSeconds: Number.POSITIVE_INFINITY }],
    ['duration above current', { durationSeconds: 11 }],
    ['nonnumber duration', { durationSeconds: '1' }],
    ['missing parts', { parts: undefined }],
    ['empty parts', { parts: [] }],
    ['nonarray parts', { parts: {} }],
  ])('rejects a sentence with %s', (_name, patch) => {
    expectFailure({ ...context(), sentences: [{ ...sentence(), ...patch }] })
  })

  it.each([
    '', 'sentence:01:2', 'sentence:0:02', 'sentence:-1:1', 'sentence:2:1',
    'sentence:0.5:1', 'sentence:0:1e2', 'sentence:0:9007199254740992',
    'sentence:0:1:2', ' sentence:0:1', 'sentence:0:1 ', 'other:0:1',
  ])('rejects a noncanonical sentence ID: %s', (sentenceId) => {
    expectFailure({ ...context(), sentences: [{ ...sentence(), sentenceId }] })
  })

  it.each([
    ['duplicate', ['sentence:0:1', 'sentence:0:1']],
    ['reversed order', ['sentence:3:4', 'sentence:0:1']],
    ['overlap', ['sentence:0:3', 'sentence:3:5']],
  ])('rejects %s word spans', (_name, ids) => {
    expectFailure({
      ...context(),
      sentences: ids.map((sentenceId) => ({ ...sentence(), sentenceId })),
    })
  })

  it.each([
    [null],
    ['speech'],
    [{}],
    [{ kind: 'invented' }],
    [{ kind: 'speech' }],
    [{ kind: 'speech', text: 1 }],
    [{ kind: 'speech', text: ' \n ' }],
  ])('rejects malformed context parts: %j', (part) => {
    expectFailure({
      ...context(),
      sentences: [{ ...sentence(), removable: false, parts: [part] }],
    })
  })

  it.each([
    [{ kind: 'partial-word' }],
    [{ kind: 'cut' }],
    [{ kind: 'speech', text: 'One.' }, { kind: 'speech', text: 'Two.' }],
    [{ kind: 'speech', text: 'One.' }, { kind: 'cut' }],
  ])('requires exactly one whole speech part for a removable row: %j', (...parts) => {
    expectFailure({ ...context(), sentences: [{ ...sentence(), parts }] })
  })

  it('rejects protected context containing only cuts', () => {
    expectFailure({
      ...context(),
      sentences: [{ ...sentence(), removable: false, parts: [{ kind: 'cut' }] }],
    })
  })

  it('accepts exactly the sentence cap and rejects another row without truncation', () => {
    const input = {
      ...context(),
      sentences: Array.from({ length: CLARITY_LIMITS.maxSentences }, (_, i) => sentence(i)),
    }
    expect(validateClarityAnalysisContext(input)).toEqual({ ok: true, context: input })
    expectFailure({
      ...input,
      sentences: [...input.sentences, sentence(CLARITY_LIMITS.maxSentences)],
    }, 'oversized')
  })

  it('counts transcript characters across all rows and uses raw UTF-16 length', () => {
    const half = CLARITY_LIMITS.maxTranscriptCharacters / 2
    const input = {
      ...context(),
      sentences: [
        { ...sentence(0), parts: [{ kind: 'speech', text: '😀'.repeat(half / 2) }] },
        { ...sentence(1), parts: [{ kind: 'speech', text: 'x'.repeat(half) }] },
      ],
    }
    expect(validateClarityAnalysisContext(input)).toEqual({ ok: true, context: input })
    input.sentences[1].parts[0].text += ' '
    expectFailure(input, 'oversized')
  })

  it('counts all protected context parts across rows', () => {
    const half = CLARITY_LIMITS.maxContextParts / 2
    const parts = () => [
      { kind: 'partial-word' },
      ...Array.from({ length: half - 1 }, () => ({ kind: 'cut' })),
    ]
    const input = {
      ...context(),
      sentences: [
        { ...sentence(0), removable: false, parts: parts() },
        { ...sentence(1), removable: false, parts: parts() },
      ],
    }
    expect(validateClarityAnalysisContext(input)).toEqual({ ok: true, context: input })
    input.sentences[1].parts.push({ kind: 'cut' })
    expectFailure(input, 'oversized')
  })

  it.each([
    ['audience', CLARITY_LIMITS.maxAudienceCharacters],
    ['mustStay', CLARITY_LIMITS.maxMustStayCharacters],
  ])('enforces the raw %s limit before trimming', (field, limit) => {
    const exact = { ...context(), settings: { [field]: 'x'.repeat(limit) } }
    expect(validateClarityAnalysisContext(exact)).toEqual({ ok: true, context: exact })
    expectFailure({ ...context(), settings: { [field]: ` ${'x'.repeat(limit)}` } }, 'oversized')
    expectFailure({ ...context(), settings: { [field]: ' '.repeat(limit + 1) } }, 'oversized')
  })

  it('rejects overlong IDs as oversized', () => {
    expectFailure({
      ...context(),
      sentences: [{
        ...sentence(),
        sentenceId: 'x'.repeat(CLARITY_LIMITS.maxSentenceIdCharacters + 1),
      }],
    }, 'oversized')
  })

  it('returns independent normalized records without mutating frozen input', () => {
    const input = context()
    const before = structuredClone(input)
    input.sentences.forEach((row) => {
      row.parts.forEach(Object.freeze)
      Object.freeze(row.parts)
      Object.freeze(row)
    })
    Object.freeze(input.sentences)
    Object.freeze(input.settings)
    Object.freeze(input)

    const result = validateClarityAnalysisContext(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context).not.toBe(input)
    expect(result.context.settings).not.toBe(input.settings)
    expect(result.context.sentences).not.toBe(input.sentences)
    expect(result.context.sentences[0]).not.toBe(input.sentences[0])
    expect(result.context.sentences[0].parts).not.toBe(input.sentences[0].parts)
    expect(result.context.sentences[0].parts[0]).not.toBe(input.sentences[0].parts[0])
    expect(input).toEqual(before)
  })
})

describe('buildClarityAnalysisContext', () => {
  it('projects the catalog safely and normalizes optional settings', () => {
    const edl = applyRemovedRange(createEdl({
      id: 'source', url: 'blob:source', duration: 10,
    }), 2, 3)
    const catalog = buildClaritySentenceCatalog({ words: [
      { text: 'Keep', start: 1, end: 2 },
      { text: 'deleted', start: 2, end: 3 },
      { text: 'ending.', start: 3, end: 4 },
    ] }, edl)
    const before = structuredClone(catalog)

    expect(buildClarityAnalysisContext(catalog, 9, { audience: ' Devs ' })).toEqual({
      sentences: [{
        sentenceId: 'sentence:0:2',
        removable: false,
        durationSeconds: 2,
        parts: [
          { kind: 'speech', text: 'Keep' },
          { kind: 'cut' },
          { kind: 'speech', text: 'ending.' },
        ],
      }],
      currentDurationSeconds: 9,
      settings: { audience: 'Devs' },
    })
    expect(catalog).toEqual(before)
  })

  it('defaults to empty settings and throws a useful error for invalid input', () => {
    const catalog = buildClaritySentenceCatalog({
      words: [{ text: 'Sentence.', start: 1, end: 2 }],
    }, createEdl({ id: 'source', url: 'blob:source', duration: 10 }))

    expect(buildClarityAnalysisContext(catalog, 10).settings).toEqual({})
    expect(() => buildClarityAnalysisContext([], 10)).toThrow(/\S/)
    expect(() => buildClarityAnalysisContext(catalog, 0)).toThrow(/\S/)
    expect(() => buildClarityAnalysisContext(catalog, 10, {
      audience: 'x'.repeat(CLARITY_LIMITS.maxAudienceCharacters + 1),
    })).toThrow(/\S/)
  })
})
