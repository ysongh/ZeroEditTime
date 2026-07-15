import { describe, it, expect } from 'vitest'
import type { EDL } from '../edl/types'
import type { Word } from '../transcript/types'
import { createEdl, applyRemovedRange } from '../edl/edl'
import {
  buildCaptions,
  prepareCaptionsForExport,
  formatSrtTime,
  buildSrt,
  MAX_CAPTION_WORDS,
  CAPTION_GAP_S,
  MIN_CAPTION_S,
} from './captions'

function word(text: string, start: number, end: number): Word {
  return { text, start, end }
}

/** An EDL over a `duration`-second source with the given ranges removed. */
function makeEdl(duration: number, removals: Array<[number, number]> = []): EDL {
  let edl = createEdl({ id: 'src', url: 'blob:src', duration })
  for (const [start, end] of removals) {
    edl = applyRemovedRange(edl, start, end)
  }
  return edl
}

/** Tightly packed words (no inter-word gap): texts[i] spans [i, i+1). */
function tightWords(...texts: string[]): Word[] {
  return texts.map((text, i) => word(text, i, i + 1))
}

describe('buildCaptions', () => {
  it('returns [] for an empty transcript', () => {
    expect(buildCaptions({ words: [] }, makeEdl(10))).toEqual([])
  })

  it('returns [] when nothing is kept', () => {
    const transcript = { words: tightWords('all', 'gone') }
    expect(buildCaptions(transcript, makeEdl(10, [[0, 10]]))).toEqual([])
  })

  it('breaks a chunk at MAX_CAPTION_WORDS', () => {
    const transcript = {
      words: tightWords('one', 'two', 'three', 'four', 'five', 'six', 'seven'),
    }
    const captions = buildCaptions(transcript, makeEdl(10))
    expect(captions.map((c) => c.text)).toEqual([
      'one two three four five',
      'six seven',
    ])
    expect(captions[0].text.split(' ')).toHaveLength(MAX_CAPTION_WORDS)
    // Source-time bounds come from the first/last word of each chunk.
    expect(captions[0]).toMatchObject({ start: 0, end: 5 })
    expect(captions[1]).toMatchObject({ start: 5, end: 7 })
  })

  it('breaks after terminal punctuation', () => {
    const transcript = { words: tightWords('Hello', 'there.', 'How', 'are', 'you?') }
    const captions = buildCaptions(transcript, makeEdl(10))
    expect(captions.map((c) => c.text)).toEqual(['Hello there.', 'How are you?'])
  })

  it('breaks on a kept output-time gap over CAPTION_GAP_S', () => {
    // 1 s of kept silence between "pause" and "then" — a real, audible break.
    const transcript = {
      words: [word('pause', 0, 1), word('then', 2, 3), word('more', 3, 4)],
    }
    const captions = buildCaptions(transcript, makeEdl(10))
    expect(1).toBeGreaterThan(CAPTION_GAP_S)
    expect(captions.map((c) => c.text)).toEqual(['pause', 'then more'])
  })

  it('does NOT break across a cut whose output gap is ~0', () => {
    // 3 s source gap, but the removed range [1, 4] collapses it in the export:
    // output-time chunking sees no pause, so the words share one caption.
    const transcript = { words: [word('before', 0, 1), word('after', 4, 5)] }
    const captions = buildCaptions(transcript, makeEdl(10, [[1, 4]]))
    expect(captions).toHaveLength(1)
    expect(captions[0]).toMatchObject({ text: 'before after', start: 0, end: 5 })
  })

  it('never captions deleted words', () => {
    // "bad" has its midpoint inside the removed range; its kept neighbors have
    // a ~0 output gap across the cut, so they merge into one caption.
    const transcript = {
      words: [word('keep', 0, 1), word('bad', 1, 2), word('this', 2, 3)],
    }
    const captions = buildCaptions(transcript, makeEdl(10, [[1, 2]]))
    expect(captions).toHaveLength(1)
    expect(captions[0].text).toBe('keep this')
  })

  it('trims word texts and joins with single spaces', () => {
    const transcript = { words: [word('  Hello ', 0, 1), word(' there,  ', 1, 2)] }
    const captions = buildCaptions(transcript, makeEdl(10))
    expect(captions[0].text).toBe('Hello there,')
  })

  it('builds deterministic ids from source bounds', () => {
    const transcript = { words: tightWords('one', 'two') }
    const captions = buildCaptions(transcript, makeEdl(10))
    expect(captions[0].id).toBe('cap_0_2')
  })
})

describe('prepareCaptionsForExport', () => {
  it('drops a caption whose speech is fully cut', () => {
    const captions = buildCaptions({ words: tightWords('a', 'b') }, makeEdl(10))
    const edl = makeEdl(10, [[0, 3]]) // the caption [0, 2] is gone entirely
    expect(prepareCaptionsForExport(captions, edl)).toEqual([])
  })

  it('clips a partially-cut caption to its kept instants', () => {
    // Caption [2, 6]; the head [0, 3] was removed after generating.
    const caption = { id: 'cap_2_6', text: 'clipped', start: 2, end: 6 }
    const edl = makeEdl(10, [[0, 3]]) // kept: [3, 10] -> output starts at 0
    expect(prepareCaptionsForExport([caption], edl)).toEqual([
      { text: 'clipped', start: 0, end: 3 },
    ])
  })

  it('maps a caption across a join, collapsing the removed middle', () => {
    // Caption [0.5, 4.5] spans the cut [1, 4]: it stays on screen across the
    // join, and its output duration shrinks by the 3 removed seconds.
    const caption = { id: 'cap', text: 'across', start: 0.5, end: 4.5 }
    const edl = makeEdl(10, [[1, 4]])
    expect(prepareCaptionsForExport([caption], edl)).toEqual([
      { text: 'across', start: 0.5, end: 1.5 },
    ])
  })

  it('extends a short caption to MIN_CAPTION_S without overlapping the next', () => {
    const captions = [
      { id: 'c1', text: 'blink', start: 0, end: 0.3 },
      { id: 'c2', text: 'next', start: 0.5, end: 2 },
    ]
    const prepared = prepareCaptionsForExport(captions, makeEdl(10))
    expect(0.3).toBeLessThan(MIN_CAPTION_S)
    // 0 + MIN would overlap "next" at 0.5, so the extension clamps there.
    expect(prepared[0]).toEqual({ text: 'blink', start: 0, end: 0.5 })
    expect(prepared[1]).toEqual({ text: 'next', start: 0.5, end: 2 })
  })

  it('extends an unobstructed short caption to exactly MIN_CAPTION_S', () => {
    const captions = [{ id: 'c1', text: 'blink', start: 1, end: 1.25 }]
    const prepared = prepareCaptionsForExport(captions, makeEdl(10))
    expect(prepared[0].end - prepared[0].start).toBeCloseTo(MIN_CAPTION_S, 10)
  })

  it('clamps the extension to the total kept duration', () => {
    const captions = [{ id: 'c1', text: 'tail', start: 4.8, end: 5 }]
    const prepared = prepareCaptionsForExport(captions, makeEdl(5))
    expect(prepared[0]).toEqual({ text: 'tail', start: 4.8, end: 5 })
  })

  it('returns captions sorted by output start', () => {
    const captions = [
      { id: 'c2', text: 'second', start: 5, end: 6 },
      { id: 'c1', text: 'first', start: 1, end: 2 },
    ]
    const prepared = prepareCaptionsForExport(captions, makeEdl(10))
    expect(prepared.map((c) => c.text)).toEqual(['first', 'second'])
  })
})

describe('formatSrtTime', () => {
  it('formats zero', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000')
  })

  it('formats hours, minutes, seconds, and millis with padding', () => {
    expect(formatSrtTime(3661.5)).toBe('01:01:01,500')
  })

  it('zero-pads small millisecond values', () => {
    expect(formatSrtTime(1.007)).toBe('00:00:01,007')
  })

  it('clamps negatives to zero', () => {
    expect(formatSrtTime(-3)).toBe('00:00:00,000')
  })
})

describe('buildSrt', () => {
  it('returns an empty string for no captions', () => {
    expect(buildSrt([])).toBe('')
  })

  it('emits 1-indexed blocks of "N\\nSTART --> END\\nTEXT\\n\\n"', () => {
    const srt = buildSrt([
      { text: 'first line', start: 0, end: 1.5 },
      { text: 'second line', start: 1.5, end: 3 },
    ])
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nfirst line\n\n' +
        '2\n00:00:01,500 --> 00:00:03,000\nsecond line\n\n',
    )
  })

  it('forces caption text onto a single line', () => {
    const srt = buildSrt([{ text: 'two \n lines', start: 0, end: 1 }])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\ntwo lines\n\n')
  })
})
