import { describe, expect, it } from 'vitest'
import {
  RETAKE_ANALYSIS_STATUSES,
  clearRetakeRecommendations,
  createRetakeEditorState,
  dismissRetakeRecommendation,
  resolveRetakeRecommendation,
  retakeEditorReducer,
  setRetakeAnalysisState,
  setRetakeRecommendations,
} from './editorState'
import type { RetakeRecommendation } from './recommendation'

const RECOMMENDATION: RetakeRecommendation = {
  id: 'retake_41000_49000_severe-stumble',
  startSourceMs: 41_000,
  endSourceMs: 49_000,
  reason: 'severe-stumble',
  severity: 'strongly-recommended',
  title: 'Severe stumble',
  explanation: 'The repeated restart leaves no complete usable take.',
  suggestedScript: 'Explain the workflow in one complete sentence.',
  confidence: 0.92,
  status: 'open',
  evidence: { fillerCount: 2, stumbleCount: 3 },
  transcriptFingerprints: [
    {
      startSourceMs: 41_000,
      endSourceMs: 46_000,
      fingerprint: 'retake-transcript-v1:100:aaaaaaaaaaaaaaaa',
    },
  ],
}

const SECOND_RECOMMENDATION: RetakeRecommendation = {
  ...RECOMMENDATION,
  id: 'retake_70000_75000_audio-quality',
  startSourceMs: 70_000,
  endSourceMs: 75_000,
  reason: 'audio-quality',
  severity: 'suggestion',
  title: 'Audio quality',
  explanation: 'Background noise is unusually strong here.',
  suggestedScript: undefined,
  status: 'dismissed',
  evidence: undefined,
  transcriptFingerprints: undefined,
}

describe('retake editor state', () => {
  it('uses backward-compatible defaults', () => {
    expect(RETAKE_ANALYSIS_STATUSES).toEqual([
      'idle',
      'analyzing',
      'complete',
      'error',
    ])
    expect(createRetakeEditorState()).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
    expect(
      createRetakeEditorState({
        retakeAnalysisStatus: 'obsolete' as 'idle',
      }),
    ).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
  })

  it('copies initialized recommendations and lifecycle metadata deeply', () => {
    const recommendations = [RECOMMENDATION]
    const progress = { completed: 2, total: 5 }
    const state = createRetakeEditorState({
      retakeRecommendations: recommendations,
      retakeAnalysisStatus: 'error',
      retakeAnalysisProgress: progress,
      retakeAnalysisError: 'Two sections could not be analyzed.',
    })

    expect(state).toEqual({
      retakeRecommendations: recommendations,
      retakeAnalysisStatus: 'error',
      retakeAnalysisProgress: progress,
      retakeAnalysisError: 'Two sections could not be analyzed.',
    })
    expect(state.retakeRecommendations).not.toBe(recommendations)
    expect(state.retakeRecommendations[0]).not.toBe(RECOMMENDATION)
    expect(state.retakeRecommendations[0].evidence).not.toBe(
      RECOMMENDATION.evidence,
    )
    expect(state.retakeRecommendations[0].transcriptFingerprints).not.toBe(
      RECOMMENDATION.transcriptFingerprints,
    )
    expect(
      state.retakeRecommendations[0].transcriptFingerprints?.[0],
    ).not.toBe(RECOMMENDATION.transcriptFingerprints?.[0])
    expect(state.retakeAnalysisProgress).not.toBe(progress)
  })

  it('replaces recommendations defensively and treats equal content as a no-op', () => {
    const state = createRetakeEditorState()
    const input = [
      {
        ...RECOMMENDATION,
        modelCommentary: 'do not retain this',
        evidence: {
          ...RECOMMENDATION.evidence,
          modelSignal: 'do not retain this',
        },
        transcriptFingerprints: RECOMMENDATION.transcriptFingerprints?.map(
          (fingerprint) => ({
            ...fingerprint,
            modelCommentary: 'do not retain this',
          }),
        ),
      },
      SECOND_RECOMMENDATION,
    ]
    const inputBefore = structuredClone(input)
    const next = setRetakeRecommendations(state, input)

    expect(next.retakeRecommendations).toEqual([
      RECOMMENDATION,
      SECOND_RECOMMENDATION,
    ])
    expect(next.retakeRecommendations[0]).not.toHaveProperty(
      'modelCommentary',
    )
    expect(next.retakeRecommendations[0].evidence).not.toHaveProperty(
      'modelSignal',
    )
    expect(
      next.retakeRecommendations[0].transcriptFingerprints?.[0],
    ).not.toHaveProperty('modelCommentary')
    expect(next.retakeRecommendations[0]).not.toBe(input[0])
    expect(next.retakeRecommendations[0].evidence).not.toBe(
      input[0].evidence,
    )
    expect(input).toEqual(inputBefore)
    expect(
      setRetakeRecommendations(next, [
        structuredClone(RECOMMENDATION),
        structuredClone(SECOND_RECOMMENDATION),
      ]),
    ).toBe(next)
  })

  it('rejects a replacement with duplicate local identities', () => {
    const state = createRetakeEditorState({
      retakeRecommendations: [SECOND_RECOMMENDATION],
    })

    expect(
      setRetakeRecommendations(state, [
        RECOMMENDATION,
        { ...RECOMMENDATION, title: 'Conflicting duplicate' },
      ]),
    ).toBe(state)
  })

  it('dismisses and resolves only the matching recommendation immutably', () => {
    const state = createRetakeEditorState({
      retakeRecommendations: [RECOMMENDATION, SECOND_RECOMMENDATION],
    })
    const before = structuredClone(state)
    const dismissed = dismissRetakeRecommendation(
      state,
      RECOMMENDATION.id,
    )

    expect(dismissed.retakeRecommendations.map(({ status }) => status)).toEqual(
      ['dismissed', 'dismissed'],
    )
    expect(dismissed.retakeRecommendations[0]).not.toBe(
      state.retakeRecommendations[0],
    )
    expect(dismissed.retakeRecommendations[1]).toBe(
      state.retakeRecommendations[1],
    )
    expect(state).toEqual(before)
    expect(dismissRetakeRecommendation(dismissed, 'missing')).toBe(dismissed)
    expect(
      dismissRetakeRecommendation(dismissed, RECOMMENDATION.id),
    ).toBe(dismissed)

    const resolved = resolveRetakeRecommendation(
      dismissed,
      SECOND_RECOMMENDATION.id,
    )
    expect(resolved.retakeRecommendations[1].status).toBe('resolved')
    expect(
      resolveRetakeRecommendation(resolved, SECOND_RECOMMENDATION.id),
    ).toBe(resolved)
    expect(
      dismissRetakeRecommendation(resolved, SECOND_RECOMMENDATION.id),
    ).toBe(resolved)
  })

  it('clears recommendations without changing analysis metadata', () => {
    const state = createRetakeEditorState({
      retakeRecommendations: [RECOMMENDATION],
      retakeAnalysisStatus: 'complete',
      retakeAnalysisProgress: { completed: 1, total: 1 },
    })
    const cleared = clearRetakeRecommendations(state)

    expect(cleared).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'complete',
      retakeAnalysisProgress: { completed: 1, total: 1 },
    })
    expect(clearRetakeRecommendations(cleared)).toBe(cleared)
  })

  it('sets lifecycle metadata independently and clears omitted optional fields', () => {
    const state = createRetakeEditorState({
      retakeRecommendations: [RECOMMENDATION],
    })
    const progress = { completed: 3, total: 7 }
    const error = setRetakeAnalysisState(
      state,
      'error',
      progress,
      'Analysis failed.',
    )

    expect(error).toEqual({
      retakeRecommendations: state.retakeRecommendations,
      retakeAnalysisStatus: 'error',
      retakeAnalysisProgress: progress,
      retakeAnalysisError: 'Analysis failed.',
    })
    expect(error.retakeRecommendations).toBe(
      state.retakeRecommendations,
    )
    expect(error.retakeAnalysisProgress).not.toBe(progress)
    expect(
      setRetakeAnalysisState(
        error,
        'error',
        { completed: 3, total: 7 },
        'Analysis failed.',
      ),
    ).toBe(error)

    expect(setRetakeAnalysisState(error, 'idle')).toEqual({
      retakeRecommendations: state.retakeRecommendations,
      retakeAnalysisStatus: 'idle',
    })
  })

  it('routes every action through the typed reducer', () => {
    let state = createRetakeEditorState()
    state = retakeEditorReducer(state, {
      type: 'set-retake-recommendations',
      recommendations: [RECOMMENDATION],
    })
    state = retakeEditorReducer(state, {
      type: 'dismiss-retake-recommendation',
      id: RECOMMENDATION.id,
    })
    state = retakeEditorReducer(state, {
      type: 'resolve-retake-recommendation',
      id: RECOMMENDATION.id,
    })
    state = retakeEditorReducer(state, {
      type: 'set-retake-analysis-state',
      status: 'complete',
      progress: { completed: 1, total: 1 },
    })

    expect(state).toMatchObject({
      retakeAnalysisStatus: 'complete',
      retakeAnalysisProgress: { completed: 1, total: 1 },
      retakeRecommendations: [{ status: 'resolved' }],
    })
    expect(
      retakeEditorReducer(state, { type: 'clear-retake-recommendations' }),
    ).toMatchObject({ retakeRecommendations: [] })
  })
})
