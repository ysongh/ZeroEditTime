import { describe, expect, it } from 'vitest'
import {
  CLARITY_ANALYSIS_MODE,
  CLARITY_ANALYSIS_TOOL_NAME,
  CLARITY_REASONS,
  extractClarityAnalysisResult,
  normalizeClarityAnalysisResult,
} from './analysis'
import type { ClarityAnalysisContext } from './context'
import { CLARITY_LIMITS } from './limits'

function context(count = 3): ClarityAnalysisContext {
  return {
    sentences: Array.from({ length: count }, (_, index) => ({
      sentenceId: `sentence:${index}:${index}`,
      removable: true,
      durationSeconds: 1,
      parts: [{ kind: 'speech', text: `Sentence ${index}.` }],
    })),
    currentDurationSeconds: 100,
    settings: {},
  }
}

function suggestion(index = 0) {
  return {
    sentenceId: `sentence:${index}:${index}`,
    reason: 'repeated-explanation',
    explanation: 'This repeats the preceding explanation.',
  }
}

function result(index = 0) {
  return { suggestions: [suggestion(index)] }
}

function analysisTool(input: unknown = result()) {
  return {
    type: 'tool_use',
    id: 'toolu_clarity_1',
    name: CLARITY_ANALYSIS_TOOL_NAME,
    input,
  }
}

function reply(content: unknown, stop_reason: unknown = 'tool_use') {
  return { content, stop_reason }
}

describe('clarity analysis contract', () => {
  it('uses a distinct relay mode, result tool, and bounded reason categories', () => {
    expect(CLARITY_ANALYSIS_MODE).toBe('clarity-analysis')
    expect(CLARITY_ANALYSIS_TOOL_NAME).toBe('submit_clarity_analysis')
    expect(CLARITY_REASONS).toEqual([
      'repeated-explanation',
      'off-topic-detail',
      'redundant-example',
      'excessive-introduction',
    ])
  })
})

describe('normalizeClarityAnalysisResult', () => {
  it('returns an independent result and trims explanations without changing IDs', () => {
    const input = {
      suggestions: [{ ...suggestion(), explanation: '  Repeats\nthis idea.  ' }],
    }
    const analysisContext = context()
    const beforeInput = structuredClone(input)
    const beforeContext = structuredClone(analysisContext)
    const normalized = normalizeClarityAnalysisResult(input, analysisContext)

    expect(normalized).toEqual({
      suggestions: [{ ...suggestion(), explanation: 'Repeats\nthis idea.' }],
    })
    expect(normalized).not.toBe(input)
    expect(normalized?.suggestions).not.toBe(input.suggestions)
    expect(normalized?.suggestions[0]).not.toBe(input.suggestions[0])
    expect(input).toEqual(beforeInput)
    expect(analysisContext).toEqual(beforeContext)
  })

  it.each(CLARITY_REASONS)('accepts the %s reason', (reason) => {
    const input = { suggestions: [{ ...suggestion(), reason }] }
    expect(normalizeClarityAnalysisResult(input, context())).toEqual(input)
  })

  it('accepts an empty proposal as a complete successful result', () => {
    expect(normalizeClarityAnalysisResult({ suggestions: [] }, context())).toEqual({
      suggestions: [],
    })
  })

  it('keeps the first duplicate deterministically and sorts by original context order', () => {
    const input = { suggestions: [
      { ...suggestion(2), reason: 'off-topic-detail', explanation: 'First reason wins.' },
      suggestion(0),
      { ...suggestion(2), explanation: 'Later duplicate loses.' },
    ] }
    const before = structuredClone(input)

    expect(normalizeClarityAnalysisResult(input, context())).toEqual({
      suggestions: [suggestion(0), {
        ...suggestion(2),
        reason: 'off-topic-detail',
        explanation: 'First reason wins.',
      }],
    })
    expect(input).toEqual(before)
  })

  it('uses context order rather than lexical ID order for noncontiguous word spans', () => {
    const analysisContext = context()
    analysisContext.sentences[0].sentenceId = 'sentence:2:4'
    analysisContext.sentences[1].sentenceId = 'sentence:10:12'
    analysisContext.sentences[2].sentenceId = 'sentence:20:21'
    const first = { ...suggestion(), sentenceId: 'sentence:2:4' }
    const second = { ...suggestion(), sentenceId: 'sentence:10:12' }

    expect(normalizeClarityAnalysisResult({
      suggestions: [second, first],
    }, analysisContext)).toEqual({ suggestions: [first, second] })
  })

  it.each([
    ['unknown reason', { reason: 'invented-reason' }],
    ['blank explanation', { explanation: ' \n ' }],
    ['extra field', { start: 1 }],
    ['oversized explanation', { explanation: 'x'.repeat(CLARITY_LIMITS.maxExplanationCharacters + 1) }],
  ])('validates a duplicate with %s instead of discarding it silently', (_name, patch) => {
    const input = { suggestions: [suggestion(), { ...suggestion(), ...patch }] }
    expect(normalizeClarityAnalysisResult(input, context())).toBeNull()
  })

  it('rejects unknown and protected IDs rather than silently dropping them', () => {
    const analysisContext = context()
    analysisContext.sentences[1] = {
      ...analysisContext.sentences[1],
      removable: false,
      parts: [{ kind: 'partial-word' }],
    }

    expect(normalizeClarityAnalysisResult(result(99), analysisContext)).toBeNull()
    expect(normalizeClarityAnalysisResult(result(1), analysisContext)).toBeNull()
    expect(normalizeClarityAnalysisResult({
      suggestions: [suggestion(0), suggestion(99)],
    }, analysisContext)).toBeNull()
  })

  it('rejects removal of all kept speech even when substantial silence would remain', () => {
    const analysisContext = context(2)
    expect(analysisContext.currentDurationSeconds).toBeGreaterThan(2)

    expect(normalizeClarityAnalysisResult({
      suggestions: [suggestion(0), suggestion(1)],
    }, analysisContext)).toBeNull()
    expect(normalizeClarityAnalysisResult(result(0), context(1))).toBeNull()
  })

  it('applies the all-speech guard after duplicate normalization', () => {
    expect(normalizeClarityAnalysisResult({
      suggestions: [suggestion(0), suggestion(0)],
    }, context(2))).toEqual(result(0))
    expect(normalizeClarityAnalysisResult({
      suggestions: [suggestion(0), suggestion(1), suggestion(1)],
    }, context(2))).toBeNull()
  })

  it('allows cuts of every removable row when protected speech remains', () => {
    const analysisContext = context(2)
    analysisContext.sentences[1] = {
      ...analysisContext.sentences[1],
      removable: false,
      parts: [{ kind: 'partial-word' }],
    }

    expect(normalizeClarityAnalysisResult(result(), analysisContext)).toEqual(result())
  })

  it('does not invent more cuts to satisfy an unmet duration target', () => {
    const analysisContext = context()
    analysisContext.settings.targetDurationSeconds = 1

    expect(normalizeClarityAnalysisResult(result(), analysisContext)).toEqual(result())
    expect(normalizeClarityAnalysisResult({ suggestions: [] }, analysisContext)).toEqual({
      suggestions: [],
    })
  })

  it.each([null, undefined, 1, 'result', []])('rejects a non-record result: %j', (value) => {
    expect(normalizeClarityAnalysisResult(value, context())).toBeNull()
  })

  it.each([undefined, null, {}, 'suggestions', 1])('rejects malformed suggestions: %j', (suggestions) => {
    expect(normalizeClarityAnalysisResult({ suggestions }, context())).toBeNull()
  })

  it.each([null, undefined, 'suggestion', 1, []])('rejects a non-record suggestion: %j', (value) => {
    expect(normalizeClarityAnalysisResult({ suggestions: [value] }, context())).toBeNull()
  })

  it.each([
    ['missing sentence ID', { sentenceId: undefined }],
    ['nonstring sentence ID', { sentenceId: 1 }],
    ['blank sentence ID', { sentenceId: '' }],
    ['whitespace around sentence ID', { sentenceId: ' sentence:0:0 ' }],
    ['missing reason', { reason: undefined }],
    ['nonstring reason', { reason: 1 }],
    ['unknown reason', { reason: 'unnecessary' }],
    ['whitespace around reason', { reason: ' repeated-explanation ' }],
    ['missing explanation', { explanation: undefined }],
    ['nonstring explanation', { explanation: 1 }],
    ['blank explanation', { explanation: '\t \n' }],
  ])('rejects a suggestion with %s', (_name, patch) => {
    expect(normalizeClarityAnalysisResult({
      suggestions: [{ ...suggestion(), ...patch }],
    }, context())).toBeNull()
  })

  it.each([
    ['timestamps', { start: 1, end: 2 }],
    ['replacement text', { text: 'Replacement speech.' }],
    ['executable edits', { action: 'remove_range' }],
    ['confidence', { confidence: 0.9 }],
  ])('rejects model-authored %s rather than making them trusted metadata', (_name, extra) => {
    expect(normalizeClarityAnalysisResult({
      suggestions: [{ ...suggestion(), ...extra }],
    }, context())).toBeNull()
  })

  it('rejects extra top-level result fields even for an empty result', () => {
    expect(normalizeClarityAnalysisResult({
      ...result(), narration: 'Cut the ending.',
    }, context())).toBeNull()
    expect(normalizeClarityAnalysisResult({
      suggestions: [], targetReached: true,
    }, context())).toBeNull()
  })

  it('accepts the exact output count cap and rejects oversized raw output before deduplication', () => {
    const exact = {
      suggestions: Array.from({ length: CLARITY_LIMITS.maxSuggestions }, (_, i) => suggestion(i)),
    }
    expect(normalizeClarityAnalysisResult(exact, context(CLARITY_LIMITS.maxSuggestions + 1))).toEqual(exact)

    const duplicateCap = { suggestions: Array.from({
      length: CLARITY_LIMITS.maxSuggestions,
    }, () => suggestion()) }
    expect(normalizeClarityAnalysisResult(duplicateCap, context())).toEqual(result())
    expect(normalizeClarityAnalysisResult({
      suggestions: [...duplicateCap.suggestions, suggestion()],
    }, context())).toBeNull()
  })

  it('enforces raw explanation length before trimming and counts UTF-16 code units', () => {
    const explanation = '😀'.repeat(CLARITY_LIMITS.maxExplanationCharacters / 2)
    const exact = { suggestions: [{ ...suggestion(), explanation }] }
    expect(normalizeClarityAnalysisResult(exact, context())).toEqual(exact)
    expect(normalizeClarityAnalysisResult({
      suggestions: [{ ...suggestion(), explanation: ` ${explanation}` }],
    }, context())).toBeNull()
    expect(normalizeClarityAnalysisResult({
      suggestions: [{ ...suggestion(), explanation: `${explanation}😀` }],
    }, context())).toBeNull()
  })

  it('does not mutate frozen result or context records', () => {
    const input = result()
    const analysisContext = context()
    Object.freeze(input.suggestions[0])
    Object.freeze(input.suggestions)
    Object.freeze(input)
    analysisContext.sentences.forEach((row) => {
      row.parts.forEach(Object.freeze)
      Object.freeze(row.parts)
      Object.freeze(row)
    })
    Object.freeze(analysisContext.sentences)
    Object.freeze(analysisContext.settings)
    Object.freeze(analysisContext)

    expect(normalizeClarityAnalysisResult(input, analysisContext)).toEqual(result())
  })
})

describe('extractClarityAnalysisResult', () => {
  it('extracts the single expected structured tool response', () => {
    expect(extractClarityAnalysisResult(reply([analysisTool()]), context())).toEqual(result())
  })

  it('extracts a valid empty proposal', () => {
    expect(extractClarityAnalysisResult(reply([
      analysisTool({ suggestions: [] }),
    ]), context())).toEqual({ suggestions: [] })
  })

  it.each([null, undefined, [], 'reply', 1])('rejects a non-record reply: %j', (value) => {
    expect(extractClarityAnalysisResult(value, context())).toBeNull()
  })

  it.each(['end_turn', 'max_tokens', 'pause_turn', 'refusal', '', null, undefined])(
    'rejects an unsupported or truncated stop reason: %j',
    (stopReason) => {
      const input = { content: [analysisTool()], stop_reason: stopReason }
      expect(extractClarityAnalysisResult(input, context())).toBeNull()
    },
  )

  it.each([
    ['nonarray content', analysisTool()],
    ['empty content', []],
    ['text only', [{ type: 'text', text: 'No cuts needed.' }]],
    ['extra leading text', [{ type: 'text', text: 'Result:' }, analysisTool()]],
    ['extra trailing text', [analysisTool(), { type: 'text', text: 'Done.' }]],
    ['extra thinking', [{ type: 'thinking', thinking: 'Reasoning.' }, analysisTool()]],
    ['duplicate calls', [analysisTool(), analysisTool()]],
    ['another tool', [analysisTool(), { ...analysisTool(), name: 'remove_range' }]],
    ['null block', [null]],
    ['primitive block', ['tool_use']],
  ])('rejects %s', (_name, content) => {
    expect(extractClarityAnalysisResult(reply(content), context())).toBeNull()
  })

  it.each([
    ['wrong type', { type: 'text' }],
    ['missing ID', { id: undefined }],
    ['blank ID', { id: ' \n ' }],
    ['nonstring ID', { id: 1 }],
    ['wrong tool name', { name: 'submit_retake_analysis' }],
    ['missing input', { input: undefined }],
    ['malformed input', { input: { suggestions: [suggestion(99)] } }],
    ['extra result fields', { input: { ...result(), replacementText: 'Invented.' } }],
  ])('rejects a tool block with %s', (_name, patch) => {
    expect(extractClarityAnalysisResult(reply([
      { ...analysisTool(), ...patch },
    ]), context())).toBeNull()
  })

  it('applies protected-ID and all-speech checks to extracted model output', () => {
    const analysisContext = context(2)
    analysisContext.sentences[1].removable = false
    expect(extractClarityAnalysisResult(reply([
      analysisTool(result(1)),
    ]), analysisContext)).toBeNull()
    expect(extractClarityAnalysisResult(reply([
      analysisTool({ suggestions: [suggestion(0), suggestion(1)] }),
    ]), context(2))).toBeNull()
  })
})
