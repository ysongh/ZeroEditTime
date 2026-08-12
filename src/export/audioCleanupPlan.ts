import {
  normalizeAudioCleanupSettings,
  type AudioCleanupSettings,
  type NoiseReductionLevel,
} from './audioCleanupSettings'

export type NoiseReductionStrength = Exclude<NoiseReductionLevel, 'off'>

export interface AudioCleanupPlan {
  enabled: boolean
  noiseReduction: {
    enabled: boolean
    strength: NoiseReductionStrength
  }
  voiceLeveling: {
    enabled: boolean
  }
  loudness: {
    enabled: boolean
    targetLufs: number
    truePeakDb: number
  }
  smoothJoins: {
    enabled: boolean
  }
}

/**
 * Translate user-facing cleanup intent into validated export-domain data.
 * Filter selection belongs to the FFmpeg layer; this plan deliberately carries
 * no command strings, runtime objects, or browser state.
 */
export function buildAudioCleanupPlan(
  settings: Readonly<AudioCleanupSettings>,
): AudioCleanupPlan {
  const normalized = normalizeAudioCleanupSettings(settings)
  const enabled = normalized.enabled

  return {
    enabled,
    noiseReduction: {
      enabled: enabled && normalized.noiseReduction !== 'off',
      strength:
        normalized.noiseReduction === 'strong' ? 'strong' : 'light',
    },
    voiceLeveling: {
      enabled: enabled && normalized.voiceLeveling,
    },
    loudness: {
      enabled: enabled && normalized.loudnessNormalization,
      targetLufs: normalized.loudnessTargetLufs,
      truePeakDb: normalized.truePeakLimitDb,
    },
    smoothJoins: {
      enabled: enabled && normalized.smoothJoins,
    },
  }
}
