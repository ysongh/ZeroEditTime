import { describe, expect, it } from 'vitest'
import type { Transcript } from '../transcript/types'
import type { RetakeCandidate } from './candidates'
import {
  buildRetakeAnalysisContext,
  type RetakeAnalysisContext,
} from './context'
import {
  RETAKE_TRANSCRIPT_FINGERPRINT_VERSION,
  buildRetakeTranscriptFingerprint,
  getRetakeRecommendationFreshness,
  removeStaleRetakeRecommendations,
  withRetakeTranscriptFingerprint,
} from './freshness'
import { buildScreenedRetakeCandidates } from './nearbyTakes'
import type { RetakeRecommendation } from './recommendation'

const FAILED_DASHBOARD = [
  'The',
  'dashboard',
  'lets',
  'you',
  'um',
  'manage',
  'uh',
  'all',
  'er',
  'projects...',
] as const

const PRIOR_CONTEXT = [
  ...Array.from({ length: 19 }, (_, index) => `prior-${index}`),
  'context.',
]

function timedWords(
  texts: readonly string[],
  start: number,
  step: number,
): Transcript['words'] {
  return texts.map((text, index) => ({
    text,
    start: start + index * step,
    end: start + index * step + step * 0.75,
  }))
}

const TRANSCRIPT: Transcript = {
  words: [
    ...timedWords(['Distant', 'source.'], 0, 0.4),
    ...timedWords(PRIOR_CONTEXT, 3, 0.15),
    ...timedWords(FAILED_DASHBOARD, 10, 0.4),
    ...timedWords(['Next', 'unrelated', 'topic.'], 18, 0.4),
  ],
}

const RECOMMENDATION: RetakeRecommendation = {
  id: 'retake_10000_13900_excessive-fillers',
  startSourceMs: 10_000,
  endSourceMs: 13_900,
  reason: 'excessive-fillers',
  severity: 'recommended',
  title: 'Filler-heavy section',
  explanation: 'The fillers make this thought difficult to cut naturally.',
  confidence: 0.84,
  status: 'open',
  evidence: { fillerCount: 3 },
}

function candidateAndContext(
  transcript: Transcript = TRANSCRIPT,
): { candidate: RetakeCandidate; context: RetakeAnalysisContext } {
  const candidate = buildScreenedRetakeCandidates(transcript).find(
    (value) => value.startSourceMs === 10_000,
  )
  if (candidate === undefined) {
    throw new Error('Test fixture should produce the retake candidate.')
  }
  const context = buildRetakeAnalysisContext(transcript, candidate)
  if (context === null) {
    throw new Error('Test fixture should produce analysis context.')
  }
  return { candidate, context }
}

function stampedRecommendation(
  transcript: Transcript = TRANSCRIPT,
): RetakeRecommendation {
  const { candidate, context } = candidateAndContext(transcript)
  const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)
  if (fingerprint === null) {
    throw new Error('Test fixture should produce a fingerprint.')
  }
  const recommendation = withRetakeTranscriptFingerprint(
    RECOMMENDATION,
    fingerprint,
  )
  if (recommendation === null) {
    throw new Error('Test fixture should attach its fingerprint.')
  }
  return recommendation
}

function replaceWord(
  transcript: Transcript,
  text: string,
  replacement: Partial<Transcript['words'][number]>,
): Transcript {
  return {
    words: transcript.words.map((word) =>
      word.text === text ? { ...word, ...replacement } : { ...word },
    ),
  }
}

describe('retake transcript fingerprints', () => {
  it('locks a deterministic independent fingerprint over the complete model evidence', () => {
    const { candidate, context } = candidateAndContext()
    const candidateBefore = structuredClone(candidate)
    const contextBefore = structuredClone(context)
    const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)

    expect(RETAKE_TRANSCRIPT_FINGERPRINT_VERSION).toBe(
      'retake-transcript-v1',
    )
    expect(fingerprint).toEqual({
      startSourceMs: 10_000,
      endSourceMs: 13_900,
      fingerprint: 'retake-transcript-v1:411:b38bbf3afa9ec48f',
    })
    expect(
      buildRetakeTranscriptFingerprint(
        structuredClone(candidate),
        structuredClone(context),
      ),
    ).toEqual(fingerprint)
    expect(candidate).toEqual(candidateBefore)
    expect(context).toEqual(contextBefore)
  })

  it.each([
    ['wording', 'dashboard', 'workspace'],
    ['case', 'The', 'the'],
    ['punctuation', 'projects...', 'projects?'],
  ])('marks changed candidate %s as stale', (_name, text, changed) => {
    expect(
      getRetakeRecommendationFreshness(
        replaceWord(TRANSCRIPT, text, { text: changed }),
        stampedRecommendation(),
      ),
    ).toBe('stale')
  })

  it('marks a changed recommendation source range as stale', () => {
    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, {
        ...stampedRecommendation(),
        startSourceMs: 10_001,
      }),
    ).toBe('stale')
  })

  it('tracks the complete immediate sentence context even across long source gaps', () => {
    const recommendation = stampedRecommendation()

    expect(
      getRetakeRecommendationFreshness(
        replaceWord(TRANSCRIPT, 'prior-5', { text: 'changed-prior' }),
        recommendation,
      ),
    ).toBe('stale')
    expect(
      getRetakeRecommendationFreshness(
        replaceWord(TRANSCRIPT, 'Next', { text: 'Following' }),
        recommendation,
      ),
    ).toBe('stale')
  })

  it('tracks the exact model signals as well as transcript text', () => {
    const { candidate, context } = candidateAndContext()
    const first = buildRetakeTranscriptFingerprint(candidate, context)
    const changedSignals = buildRetakeTranscriptFingerprint(candidate, {
      ...context,
      signals: {
        ...context.signals,
        longestPauseMs: context.signals.longestPauseMs + 1,
      },
    })

    expect(changedSignals?.fingerprint).not.toBe(first?.fingerprint)
  })

  it('ignores transcript outside supplied context, EDL metadata, and advisory fields', () => {
    const recommendation = stampedRecommendation()
    const changedDistantWords = replaceWord(
      TRANSCRIPT,
      'Distant',
      { text: 'Different' },
    )
    const transcriptWithEdlMetadata = {
      ...changedDistantWords,
      edl: { segments: [{ start: 10, end: 12 }] },
    }

    expect(
      getRetakeRecommendationFreshness(
        transcriptWithEdlMetadata,
        {
          ...recommendation,
          title: 'A new local title',
          explanation: 'Updated advisory copy.',
          suggestedScript: 'Try this replacement.',
          confidence: 0.2,
          status: 'dismissed',
        },
      ),
    ).toBe('current')
  })

  it('normalizes whitespace while preserving meaningful spelling', () => {
    const recommendation = stampedRecommendation()

    expect(
      getRetakeRecommendationFreshness(
        replaceWord(TRANSCRIPT, 'dashboard', {
          text: '  dashboard\n\t',
        }),
        recommendation,
      ),
    ).toBe('current')
    expect(
      getRetakeRecommendationFreshness(
        replaceWord(TRANSCRIPT, 'dashboard', { text: 'Dashboard' }),
        recommendation,
      ),
    ).toBe('stale')
  })

  it('fingerprints candidate text omitted from the bounded model excerpt', () => {
    const words = Array.from({ length: 160 }, (_, index) =>
      index < 48
        ? 'um'
        : index === 80
          ? 'middle-original'
          : index === 159
            ? 'finished.'
            : `word-${index}`,
    )
    const transcript: Transcript = {
      words: timedWords(words, 10, 0.05),
    }
    const [candidate] = buildScreenedRetakeCandidates(transcript)
    const context = buildRetakeAnalysisContext(transcript, candidate)
    if (context === null) throw new Error('Expected bounded context.')
    const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)
    if (fingerprint === null) throw new Error('Expected fingerprint.')

    const changedTranscript = replaceWord(
      transcript,
      'middle-original',
      { text: 'middle-changed' },
    )
    const [changedCandidate] = buildScreenedRetakeCandidates(changedTranscript)
    const changedContext = buildRetakeAnalysisContext(
      changedTranscript,
      changedCandidate,
    )
    if (changedContext === null) throw new Error('Expected changed context.')
    const changedFingerprint = buildRetakeTranscriptFingerprint(
      changedCandidate,
      changedContext,
    )

    expect(changedContext).toEqual(context)
    expect(changedFingerprint?.fingerprint).not.toBe(
      fingerprint.fingerprint,
    )
  })

  it('marks candidate disappearance, transcript reordering, and malformed timing stale', () => {
    const recommendation = stampedRecommendation()
    const noLongerStrong = replaceWord(TRANSCRIPT, 'er', {
      text: 'the',
    })
    const reordered: Transcript = {
      words: TRANSCRIPT.words.toReversed(),
    }
    const malformed = replaceWord(TRANSCRIPT, 'dashboard', {
      start: Number.NaN,
    })

    expect(
      getRetakeRecommendationFreshness(
        noLongerStrong,
        recommendation,
      ),
    ).toBe('stale')
    expect(
      getRetakeRecommendationFreshness(reordered, recommendation),
    ).toBe('stale')
    expect(
      getRetakeRecommendationFreshness(malformed, recommendation),
    ).toBe('stale')
  })

  it('requires re-analysis when local provenance is missing, malformed, or obsolete', () => {
    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, RECOMMENDATION),
    ).toBe('requires-reanalysis')
    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, {
        ...RECOMMENDATION,
        transcriptFingerprints: [],
      }),
    ).toBe('requires-reanalysis')
    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, {
        ...RECOMMENDATION,
        transcriptFingerprints: [
          {
            startSourceMs: 10_000,
            endSourceMs: 13_900,
            fingerprint: 'retake-transcript-v0:100:0000000000000000',
          },
        ],
      }),
    ).toBe('requires-reanalysis')
  })

  it('rejects invalid or mismatched fingerprint inputs', () => {
    const { candidate, context } = candidateAndContext()

    expect(
      buildRetakeTranscriptFingerprint(
        { ...candidate, startSourceMs: Number.NaN },
        context,
      ),
    ).toBeNull()
    expect(
      buildRetakeTranscriptFingerprint(
        { ...candidate, transcriptText: '   ' },
        context,
      ),
    ).toBeNull()
    expect(
      buildRetakeTranscriptFingerprint(
        { ...candidate, startSourceMs: 10_001 },
        context,
      ),
    ).toBeNull()
  })

  it('attaches captured local provenance without mutation or nested aliasing', () => {
    const { candidate, context } = candidateAndContext()
    const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)
    if (fingerprint === null) throw new Error('Expected fingerprint.')
    const before = structuredClone(RECOMMENDATION)
    const stamped = withRetakeTranscriptFingerprint(
      {
        ...RECOMMENDATION,
        transcriptFingerprints: [
          {
            startSourceMs: 1,
            endSourceMs: 2,
            fingerprint: 'untrusted-old-value',
          },
        ],
      },
      fingerprint,
    )

    expect(stamped).not.toBeNull()
    expect(stamped).not.toBe(RECOMMENDATION)
    expect(stamped?.evidence).not.toBe(RECOMMENDATION.evidence)
    expect(stamped?.transcriptFingerprints).toEqual([fingerprint])
    expect(stamped?.transcriptFingerprints?.[0]).not.toBe(fingerprint)
    expect(RECOMMENDATION).toEqual(before)
  })

  it('requires every retained provenance entry to remain current', () => {
    const recommendation = stampedRecommendation()
    const fingerprint = recommendation.transcriptFingerprints?.[0]
    if (fingerprint === undefined) throw new Error('Expected fingerprint.')

    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, {
        ...recommendation,
        transcriptFingerprints: [fingerprint, { ...fingerprint }],
      }),
    ).toBe('current')
    expect(
      getRetakeRecommendationFreshness(TRANSCRIPT, {
        ...recommendation,
        transcriptFingerprints: [
          fingerprint,
          {
            ...fingerprint,
            fingerprint:
              fingerprint.fingerprint.slice(0, -1) +
              (fingerprint.fingerprint.endsWith('0') ? '1' : '0'),
          },
        ],
      }),
    ).toBe('stale')
  })

  it('removes stale and unverifiable recommendations without reordering or mutation', () => {
    const current = stampedRecommendation()
    const stale = {
      ...current,
      id: 'stale',
      startSourceMs: 10_001,
    }
    const unverifiable = {
      ...RECOMMENDATION,
      id: 'unverifiable',
    }
    const recommendations = [stale, current, unverifiable]
    const before = structuredClone(recommendations)

    const retained = removeStaleRetakeRecommendations(
      TRANSCRIPT,
      recommendations,
    )

    expect(retained).toEqual([current])
    expect(retained).not.toBe(recommendations)
    expect(retained[0]).toBe(current)
    expect(recommendations).toEqual(before)
  })
})
