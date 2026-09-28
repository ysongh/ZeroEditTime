import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  MAX_LOUDNESS_TARGET_LUFS,
  MAX_TRUE_PEAK_LIMIT_DB,
  MIN_LOUDNESS_TARGET_LUFS,
  MIN_TRUE_PEAK_LIMIT_DB,
  normalizeAudioCleanupSettings,
  stepTruePeakLimit,
  type AudioCleanupSettings,
} from './audioCleanupSettings'

describe('normalizeAudioCleanupSettings', () => {
  it('preserves valid settings and returns an independent value', () => {
    const settings: AudioCleanupSettings = {
      enabled: false,
      noiseReduction: 'strong',
      voiceLeveling: false,
      loudnessNormalization: false,
      loudnessTargetLufs: -18,
      truePeakLimitDb: -2,
      smoothJoins: false,
    }

    const normalized = normalizeAudioCleanupSettings(settings)

    expect(normalized).toEqual(settings)
    expect(normalized).not.toBe(settings)
    expect(settings).toEqual({
      enabled: false,
      noiseReduction: 'strong',
      voiceLeveling: false,
      loudnessNormalization: false,
      loudnessTargetLufs: -18,
      truePeakLimitDb: -2,
      smoothJoins: false,
    })
  })

  it('clamps finite loudness and true-peak targets to supported bounds', () => {
    expect(
      normalizeAudioCleanupSettings({
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        loudnessTargetLufs: -100,
        truePeakLimitDb: -100,
      }),
    ).toMatchObject({
      loudnessTargetLufs: MIN_LOUDNESS_TARGET_LUFS,
      truePeakLimitDb: MIN_TRUE_PEAK_LIMIT_DB,
    })

    expect(
      normalizeAudioCleanupSettings({
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        loudnessTargetLufs: 10,
        truePeakLimitDb: 10,
      }),
    ).toMatchObject({
      loudnessTargetLufs: MAX_LOUDNESS_TARGET_LUFS,
      truePeakLimitDb: MAX_TRUE_PEAK_LIMIT_DB,
    })
  })

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('uses documented defaults for %s targets', (_name, invalid) => {
    const normalized = normalizeAudioCleanupSettings({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      loudnessTargetLufs: invalid,
      truePeakLimitDb: invalid,
    })

    expect(normalized.loudnessTargetLufs).toBe(
      DEFAULT_AUDIO_CLEANUP_SETTINGS.loudnessTargetLufs,
    )
    expect(normalized.truePeakLimitDb).toBe(
      DEFAULT_AUDIO_CLEANUP_SETTINGS.truePeakLimitDb,
    )
  })
})

describe('stepTruePeakLimit', () => {
  it('moves by half a decibel without drift and clamps to the supported range', () => {
    let settings: AudioCleanupSettings = { ...DEFAULT_AUDIO_CLEANUP_SETTINGS }
    for (let press = 0; press < 20; press += 1) {
      settings = stepTruePeakLimit(settings, -1)
    }
    expect(settings.truePeakLimitDb).toBe(MIN_TRUE_PEAK_LIMIT_DB)
    expect(stepTruePeakLimit(settings, 1).truePeakLimitDb).toBe(-5.5)

    const nearMax = { ...DEFAULT_AUDIO_CLEANUP_SETTINGS, truePeakLimitDb: -0.3 }
    expect(stepTruePeakLimit(nearMax, 1).truePeakLimitDb).toBe(MAX_TRUE_PEAK_LIMIT_DB)
    expect(stepTruePeakLimit(nearMax, -1).truePeakLimitDb).toBe(-0.8)
  })

  it('leaves every other setting unchanged', () => {
    const stepped = stepTruePeakLimit(DEFAULT_AUDIO_CLEANUP_SETTINGS, -1)
    expect(stepped).toEqual({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      truePeakLimitDb: -1.5,
    })
  })
})
