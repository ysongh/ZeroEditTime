import { describe, expect, it } from 'vitest'
import type { Transcript, Word } from '../transcript/types'
import { buildHeuristicRetakeCandidates } from './heuristics'
import {
  MAX_CLEAN_TAKE_FILLER_COUNT,
  MAX_NEARBY_SENTENCE_DISTANCE,
  MAX_NEARBY_TAKE_GAP_MS,
  MIN_CLEAN_TAKE_WORD_COUNT,
  MIN_REPAIRABLE_RESTART_WORD_COUNT,
  MIN_RELATED_OPENING_WORD_COUNT,
  buildScreenedRetakeCandidates,
  findNearbyCleanTake,
  findNearbyCleanTakes,
  isRepairableByStumbleRemoval,
  suppressCandidatesWithNearbyCleanTakes,
} from './nearbyTakes'

function sequential(...texts: string[]): Transcript {
  return {
    words: texts.map((text, index) => ({
      text,
      start: index * 0.4,
      end: index * 0.4 + 0.3,
    })),
  }
}

function appendWords(
  words: Word[],
  texts: readonly string[],
  start: number,
  step = 0.12,
  duration = 0.08,
): Word[] {
  return [
    ...words,
    ...texts.map((text, index) => ({
      text,
      start: start + index * step,
      end: start + index * step + duration,
    })),
  ]
}

function onlyCandidate(transcript: Transcript) {
  const candidates = buildHeuristicRetakeCandidates(transcript)
  if (candidates.length !== 1) {
    throw new Error(`Expected one candidate, received ${candidates.length}`)
  }
  return candidates[0]
}

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

const CLEAN_DASHBOARD = [
  'The',
  'dashboard',
  'lets',
  'you',
  'manage',
  'all',
  'projects.',
] as const

describe('nearby clean-take suppression', () => {
  it('uses conservative, documented local limits', () => {
    expect(MAX_NEARBY_TAKE_GAP_MS).toBe(3_000)
    expect(MAX_NEARBY_SENTENCE_DISTANCE).toBe(2)
    expect(MIN_RELATED_OPENING_WORD_COUNT).toBe(4)
    expect(MIN_CLEAN_TAKE_WORD_COUNT).toBe(4)
    expect(MIN_REPAIRABLE_RESTART_WORD_COUNT).toBe(4)
    expect(MAX_CLEAN_TAKE_FILLER_COUNT).toBe(1)
  })

  it('suppresses a failed take when the next sentence is the clean version', () => {
    const transcript = sequential(...FAILED_DASHBOARD, ...CLEAN_DASHBOARD)
    const candidate = onlyCandidate(transcript)
    const match = findNearbyCleanTake(transcript, candidate)

    expect(match).toEqual({
      startSourceMs: transcript.words[FAILED_DASHBOARD.length].start * 1_000,
      endSourceMs: transcript.words.at(-1)!.end * 1_000,
      text: 'The dashboard lets you manage all projects.',
    })
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([])
  })

  it('checks before the failed take as well as after it', () => {
    const transcript = sequential(...CLEAN_DASHBOARD, ...FAILED_DASHBOARD)
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toMatchObject({
      startSourceMs: 0,
      text: 'The dashboard lets you manage all projects.',
    })
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([])
  })

  it('can bridge one short interjection without widening the time window', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'Sorry.',
      ...CLEAN_DASHBOARD,
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)?.text).toBe(
      'The dashboard lets you manage all projects.',
    )
  })

  it('does not search beyond two sentence positions', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'Sorry.',
      'Starting',
      'again.',
      ...CLEAN_DASHBOARD,
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('suppresses chained abandoned starts when stumble removal leaves a clean final take', () => {
    const transcript = sequential(
      'we',
      'built',
      'the',
      'arch-',
      'we',
      'built',
      'the',
      'arch-',
      'we',
      'built',
      'the',
      'architecture',
      'now.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(isRepairableByStumbleRemoval(transcript, candidate)).toBe(true)
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([])
  })

  it('keeps repeated failed attempts when the final attempt is still incomplete', () => {
    const transcript = sequential(
      'we',
      'built',
      'the',
      'arch-',
      'we',
      'built',
      'the',
      'arch-',
      'we',
      'built',
      'the',
      'arch-',
    )
    const candidate = onlyCandidate(transcript)

    expect(isRepairableByStumbleRemoval(transcript, candidate)).toBe(false)
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('keeps multiple nearby dirty attempts when none is a clean take', () => {
    const transcript = sequential(...FAILED_DASHBOARD, ...FAILED_DASHBOARD)
    const candidates = buildHeuristicRetakeCandidates(transcript)

    expect(candidates).toHaveLength(2)
    expect(buildScreenedRetakeCandidates(transcript)).toEqual(candidates)
  })

  it('does not infer completeness by cutting scattered repeated words', () => {
    const transcript = sequential(
      'We',
      'we',
      'should',
      'explain',
      'and',
      'and.',
    )
    const candidate = onlyCandidate(transcript)

    expect(isRepairableByStumbleRemoval(transcript, candidate)).toBe(false)
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('counts the repeated phrase, not intervening words, in a restart chain', () => {
    const transcript = sequential(
      'we',
      'start',
      'export',
      'now',
      'we',
      'start',
      'captions',
      'later',
      'we',
      'start',
      'finish',
      'clearly.',
    )
    const candidate = onlyCandidate(transcript)

    expect(candidate.signals.stumbleCount).toBe(2)
    expect(isRepairableByStumbleRemoval(transcript, candidate)).toBe(false)
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('does not confuse an unrelated nearby sentence with another take', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'Captions',
      'appear',
      'below',
      'the',
      'video',
      'preview.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('leaves semantic paraphrase judgment for the later AI analyzer', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'Use',
      'the',
      'project',
      'overview',
      'to',
      'organize',
      'every',
      'workspace.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('rejects generic shared openings that end with different statements', () => {
    const transcript = sequential(
      'In',
      'um',
      'this',
      'video',
      'uh',
      'we',
      'explain',
      'er',
      'exports...',
      'In',
      'this',
      'video',
      'we',
      'explain',
      'captions.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
  })

  it('does not suppress an unknown thought from a generic matching fragment', () => {
    const transcript = sequential(
      'This',
      'um',
      'is',
      'uh',
      'how',
      'er',
      'you...',
      'This',
      'is',
      'how',
      'you',
      'export',
      'clips.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('never treats an ordinary word prefix as the same spoken token', () => {
    const transcript = sequential(
      'We',
      'um',
      'use',
      'uh',
      'the',
      'er',
      'app',
      'settings.',
      'We',
      'use',
      'the',
      'apple',
      'settings.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
    expect(buildScreenedRetakeCandidates(transcript)).toEqual([candidate])
  })

  it('does not treat an incomplete, truncated, or independently stumbled alternate as clean', () => {
    const incomplete = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'lets',
      'you',
      'manage',
      'all',
      'projects...',
    )
    const truncated = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'lets',
      'you',
      'manage.',
    )
    const stumbled = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'lets',
      'you',
      'manage',
      'all',
      'projects',
      'projects.',
    )

    expect(findNearbyCleanTake(incomplete, onlyCandidate(incomplete))).toBeNull()
    expect(findNearbyCleanTake(truncated, onlyCandidate(truncated))).toBeNull()
    expect(findNearbyCleanTake(stumbled, onlyCandidate(stumbled))).toBeNull()
  })

  it('allows one editing-fixable filler in a clean take but rejects two', () => {
    const oneFiller = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'um',
      'lets',
      'you',
      'manage',
      'all',
      'projects.',
    )
    const twoFillers = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'um',
      'lets',
      'you',
      'uh',
      'manage',
      'all',
      'projects.',
    )

    expect(
      findNearbyCleanTake(oneFiller, onlyCandidate(oneFiller))?.text,
    ).toBe('The dashboard um lets you manage all projects.')
    expect(findNearbyCleanTake(twoFillers, onlyCandidate(twoFillers))).toBeNull()
  })

  it('matches case and punctuation without changing returned transcript text', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'THE',
      'DASHBOARD',
      'LETS',
      'YOU',
      'MANAGE',
      'ALL',
      'PROJECTS!',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)?.text).toBe(
      'THE DASHBOARD LETS YOU MANAGE ALL PROJECTS!',
    )
  })

  it('does not let a trailing filler provide the only completion punctuation', () => {
    const transcript = sequential(
      ...FAILED_DASHBOARD,
      'The',
      'dashboard',
      'lets',
      'you',
      'manage',
      'all',
      'projects',
      'um.',
    )
    const candidate = onlyCandidate(transcript)

    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
  })

  it('rejects a matching alternate with a long internal hesitation', () => {
    let words = appendWords([], FAILED_DASHBOARD, 0)
    const cleanStart = words.at(-1)!.end + 0.1
    words = appendWords(words, CLEAN_DASHBOARD.slice(0, 4), cleanStart)
    const delayedStart = words.at(-1)!.end + 2.001
    words = appendWords(words, CLEAN_DASHBOARD.slice(4), delayedStart)
    const transcript = { words }
    const candidate = buildHeuristicRetakeCandidates(transcript)[0]

    expect(candidate).toBeDefined()
    expect(findNearbyCleanTake(transcript, candidate)).toBeNull()
  })

  it('uses the inclusive three-second boundary and rejects anything beyond it', () => {
    const failedWords = appendWords([], FAILED_DASHBOARD, 0)
    const candidateEnd = failedWords.at(-1)!.end
    const atBoundary: Transcript = {
      words: appendWords(
        failedWords,
        CLEAN_DASHBOARD,
        candidateEnd + MAX_NEARBY_TAKE_GAP_MS / 1_000,
      ),
    }
    const outsideBoundary: Transcript = {
      words: appendWords(
        failedWords,
        CLEAN_DASHBOARD,
        candidateEnd + MAX_NEARBY_TAKE_GAP_MS / 1_000 + 0.001,
      ),
    }

    expect(
      findNearbyCleanTake(atBoundary, onlyCandidate(atBoundary)),
    ).not.toBeNull()
    expect(
      findNearbyCleanTake(outsideBoundary, onlyCandidate(outsideBoundary)),
    ).toBeNull()
  })

  it('returns every matching alternate nearest-first with fresh source metadata', () => {
    const transcript = sequential(
      ...CLEAN_DASHBOARD,
      ...FAILED_DASHBOARD,
      ...CLEAN_DASHBOARD,
    )
    const candidate = onlyCandidate(transcript)
    const transcriptBefore = structuredClone(transcript)
    const candidateBefore = structuredClone(candidate)

    const first = findNearbyCleanTakes(transcript, candidate)
    const second = findNearbyCleanTakes(transcript, candidate)

    expect(first).toHaveLength(2)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first.every((take) => take.startSourceMs < take.endSourceMs)).toBe(
      true,
    )
    expect(transcript).toEqual(transcriptBefore)
    expect(candidate).toEqual(candidateBefore)
  })

  it('ignores unsafe alternate timing and leaves unsuppressed candidates untouched', () => {
    const valid = sequential(...FAILED_DASHBOARD)
    const transcript: Transcript = {
      words: [
        ...valid.words,
        { text: 'The', start: Number.NaN, end: 5 },
        ...appendWords([], CLEAN_DASHBOARD.slice(1), 5),
      ],
    }
    const candidate = onlyCandidate(valid)
    const candidateBefore = structuredClone(candidate)

    const candidates = [candidate]
    const result = suppressCandidatesWithNearbyCleanTakes(
      transcript,
      candidates,
    )

    expect(result).toEqual([candidate])
    expect(result).not.toBe(candidates)
    expect(result[0]).toBe(candidate)
    expect(candidate).toEqual(candidateBefore)
  })

  it('handles empty inputs without browser, editor, or AI state', () => {
    expect(buildScreenedRetakeCandidates({ words: [] })).toEqual([])
    expect(suppressCandidatesWithNearbyCleanTakes({ words: [] }, [])).toEqual(
      [],
    )
  })
})
