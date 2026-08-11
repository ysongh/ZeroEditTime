import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  MAX_LOUDNESS_TARGET_LUFS,
  MAX_TRUE_PEAK_LIMIT_DB,
  MIN_LOUDNESS_TARGET_LUFS,
  MIN_TRUE_PEAK_LIMIT_DB,
  normalizeAudioCleanupSettings,
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

  it('uses documented defaults for non-finite targets', () => {
    const normalized = normalizeAudioCleanupSettings({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      loudnessTargetLufs: Number.NaN,
      truePeakLimitDb: Number.POSITIVE_INFINITY,
    })

    expect(normalized.loudnessTargetLufs).toBe(
      DEFAULT_AUDIO_CLEANUP_SETTINGS.loudnessTargetLufs,
    )
    expect(normalized.truePeakLimitDb).toBe(
      DEFAULT_AUDIO_CLEANUP_SETTINGS.truePeakLimitDb,
    )
  })
})
