import { describe, expect, it } from 'vitest'
import {
  canAttemptAudioFilter,
  getAudioFilterCapabilities,
  recordAudioFilterSupport,
  type AudioFilterCapabilities,
} from './audioFilterCapabilities'

describe('audio filter capabilities', () => {
  it('starts every candidate unknown without initializing or probing anything', () => {
    const instance = {}

    expect(getAudioFilterCapabilities(instance)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })

  it('attempts unknown/supported filters and skips unsupported filters', () => {
    const instance = {}
    recordAudioFilterSupport(instance, 'afftdn', true)
    recordAudioFilterSupport(instance, 'alimiter', false)
    const capabilities = getAudioFilterCapabilities(instance)

    expect(canAttemptAudioFilter(capabilities, 'acrossfade')).toBe(true)
    expect(canAttemptAudioFilter(capabilities, 'afftdn')).toBe(true)
    expect(canAttemptAudioFilter(capabilities, 'alimiter')).toBe(false)
  })

  it('updates one filter without changing other capability results', () => {
    const instance = {}
    recordAudioFilterSupport(instance, 'afftdn', true)
    recordAudioFilterSupport(instance, 'loudnorm', false)

    expect(getAudioFilterCapabilities(instance)).toEqual({
      afftdn: 'supported',
      acompressor: 'unknown',
      loudnorm: 'unsupported',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })

  it('keeps instances isolated and returns snapshots callers cannot mutate', () => {
    const first = {}
    const second = {}
    recordAudioFilterSupport(first, 'acompressor', false)

    const snapshot = getAudioFilterCapabilities(first)
    const mutableSnapshot = snapshot as AudioFilterCapabilities
    mutableSnapshot.acompressor = 'supported'

    expect(getAudioFilterCapabilities(first).acompressor).toBe('unsupported')
    expect(getAudioFilterCapabilities(second).acompressor).toBe('unknown')
  })
})
