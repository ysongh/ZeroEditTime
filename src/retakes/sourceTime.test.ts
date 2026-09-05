import { describe, expect, it } from 'vitest'
import {
  formatRetakeSourceRangeForSpeech,
  formatRetakeSourceTime,
} from './sourceTime'

describe('retake source-time formatting', () => {
  it('keeps compact display on the original whole-second clock', () => {
    expect(formatRetakeSourceTime(41_250)).toBe('00:41')
    expect(formatRetakeSourceTime(59_999)).toBe('00:59')
    expect(formatRetakeSourceTime(60_000)).toBe('01:00')
    expect(formatRetakeSourceTime(3_599_999)).toBe('59:59')
    expect(formatRetakeSourceTime(3_600_000)).toBe('1:00:00')
    expect(formatRetakeSourceTime(7_323_004)).toBe('2:02:03')
  })

  it('speaks exact source milliseconds instead of ambiguous clock punctuation', () => {
    expect(formatRetakeSourceRangeForSpeech(41_250, 49_900)).toBe(
      'Original source time: from 41.25 seconds to 49.9 seconds',
    )
    expect(formatRetakeSourceRangeForSpeech(0, 1)).toBe(
      'Original source time: from 0 seconds to 0.001 seconds',
    )
    expect(formatRetakeSourceRangeForSpeech(1_000, 1_001)).toBe(
      'Original source time: from 1 second to 1.001 seconds',
    )
  })

  it('keeps precision and natural units across minute and hour boundaries', () => {
    expect(formatRetakeSourceRangeForSpeech(59_999, 60_001)).toBe(
      'Original source time: from 59.999 seconds to 1 minute 0.001 seconds',
    )
    expect(formatRetakeSourceRangeForSpeech(3_599_999, 3_600_000)).toBe(
      'Original source time: from 59 minutes 59.999 seconds to 1 hour',
    )
    expect(formatRetakeSourceRangeForSpeech(3_661_000, 7_323_004)).toBe(
      'Original source time: from 1 hour 1 minute 1 second to 2 hours 2 minutes 3.004 seconds',
    )
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'handles invalid or negative source position %s without unreadable values',
    (sourceMs) => {
      expect(formatRetakeSourceTime(sourceMs)).toBe('00:00')
      expect(formatRetakeSourceRangeForSpeech(sourceMs, 60_000)).toBe(
        'Original source time: from 0 seconds to 1 minute',
      )
      expect(formatRetakeSourceRangeForSpeech(60_000, sourceMs)).toBe(
        'Original source time: from 1 minute to 0 seconds',
      )
    },
  )
})
