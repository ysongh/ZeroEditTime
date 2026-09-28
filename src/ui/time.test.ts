import { describe, expect, it } from 'vitest'
import { formatClock, formatSeconds, formatShortClock } from './time'

describe('time formatting', () => {
  it('formats precise clocks with centiseconds and an hour field when needed', () => {
    expect(formatClock(0)).toBe('0:00.00')
    expect(formatClock(14.2)).toBe('0:14.20')
    expect(formatClock(188.81)).toBe('3:08.81')
    expect(formatClock(59.996)).toBe('1:00.00')
    expect(formatClock(3_725.5)).toBe('1:02:05.50')
  })

  it('formats compact clocks by truncating to whole seconds', () => {
    expect(formatShortClock(0)).toBe('0:00')
    expect(formatShortClock(65.99)).toBe('1:05')
    expect(formatShortClock(3_600)).toBe('1:00:00')
  })

  it('treats negative and non-finite input as zero', () => {
    expect(formatClock(-3)).toBe('0:00.00')
    expect(formatShortClock(Number.NaN)).toBe('0:00')
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe('0.00s')
    expect(formatSeconds(1.254)).toBe('1.25s')
  })
})
