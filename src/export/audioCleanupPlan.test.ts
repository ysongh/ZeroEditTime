import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  MAX_LOUDNESS_TARGET_LUFS,
  MIN_TRUE_PEAK_LIMIT_DB,
  type AudioCleanupSettings,
} from './audioCleanupSettings'
import { buildAudioCleanupPlan } from './audioCleanupPlan'

describe('buildAudioCleanupPlan', () => {
  it('maps the recommended defaults into enabled cleanup intent', () => {
    expect(buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)).toEqual({
      enabled: true,
      noiseReduction: { enabled: true, strength: 'light' },
      voiceLeveling: { enabled: true },
      loudness: { enabled: true, targetLufs: -16, truePeakDb: -1 },
      smoothJoins: { enabled: true },
    })
  })

  it('gates every operation when cleanup is globally disabled', () => {
    expect(
      buildAudioCleanupPlan({
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        enabled: false,
        noiseReduction: 'strong',
      }),
    ).toEqual({
      enabled: false,
      noiseReduction: { enabled: false, strength: 'strong' },
      voiceLeveling: { enabled: false },
      loudness: { enabled: false, targetLufs: -16, truePeakDb: -1 },
      smoothJoins: { enabled: false },
    })
  })

  it('disables individual operations without adding placeholder intent', () => {
    expect(
      buildAudioCleanupPlan({
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        noiseReduction: 'off',
        voiceLeveling: false,
        loudnessNormalization: false,
        smoothJoins: false,
      }),
    ).toMatchObject({
      enabled: true,
      noiseReduction: { enabled: false },
      voiceLeveling: { enabled: false },
      loudness: { enabled: false },
      smoothJoins: { enabled: false },
    })
  })

  it.each([
    ['off' as const, false, 'light' as const],
    ['light' as const, true, 'light' as const],
    ['strong' as const, true, 'strong' as const],
  ])('maps enabled noise setting %s explicitly', (setting, enabled, strength) => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: setting,
    })

    expect(plan.noiseReduction).toEqual({ enabled, strength })
  })

  it('clamps plan targets through the shared settings boundary', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      loudnessTargetLufs: 5,
      truePeakLimitDb: -20,
    })

    expect(plan.loudness).toEqual({
      enabled: true,
      targetLufs: MAX_LOUDNESS_TARGET_LUFS,
      truePeakDb: MIN_TRUE_PEAK_LIMIT_DB,
    })
  })

  it('is deterministic and does not mutate its input', () => {
    const settings: AudioCleanupSettings = {
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
      loudnessTargetLufs: Number.NaN,
    }
    const snapshot = { ...settings }

    const first = buildAudioCleanupPlan(settings)
    const second = buildAudioCleanupPlan(settings)

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(settings).toEqual(snapshot)
    expect(Number.isNaN(settings.loudnessTargetLufs)).toBe(true)
  })
})
