export type NoiseReductionLevel = 'off' | 'light' | 'strong'

export interface AudioCleanupSettings {
  enabled: boolean
  noiseReduction: NoiseReductionLevel
  voiceLeveling: boolean
  loudnessNormalization: boolean
  loudnessTargetLufs: number
  truePeakLimitDb: number
  smoothJoins: boolean
}

export const MIN_LOUDNESS_TARGET_LUFS = -24
export const MAX_LOUDNESS_TARGET_LUFS = -10
export const MIN_TRUE_PEAK_LIMIT_DB = -6
export const MAX_TRUE_PEAK_LIMIT_DB = 0
export const TRUE_PEAK_LIMIT_STEP_DB = 0.5

export const DEFAULT_AUDIO_CLEANUP_SETTINGS: Readonly<AudioCleanupSettings> = {
  enabled: true,
  noiseReduction: 'light',
  voiceLeveling: true,
  loudnessNormalization: true,
  loudnessTargetLufs: -16,
  truePeakLimitDb: -1,
  smoothJoins: true,
}

function clampFinite(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Return a valid, independent settings value at the editor/export boundary.
 * Finite out-of-range targets are clamped to the supported range; non-finite
 * targets recover to the documented defaults.
 */
export function normalizeAudioCleanupSettings(
  settings: Readonly<AudioCleanupSettings>,
): AudioCleanupSettings {
  return {
    ...settings,
    loudnessTargetLufs: clampFinite(
      settings.loudnessTargetLufs,
      MIN_LOUDNESS_TARGET_LUFS,
      MAX_LOUDNESS_TARGET_LUFS,
      DEFAULT_AUDIO_CLEANUP_SETTINGS.loudnessTargetLufs,
    ),
    truePeakLimitDb: clampFinite(
      settings.truePeakLimitDb,
      MIN_TRUE_PEAK_LIMIT_DB,
      MAX_TRUE_PEAK_LIMIT_DB,
      DEFAULT_AUDIO_CLEANUP_SETTINGS.truePeakLimitDb,
    ),
  }
}

/**
 * One stepper press on the peak limit: move by TRUE_PEAK_LIMIT_STEP_DB, rounded
 * to a tenth so repeated steps never drift, then normalized into range.
 */
export function stepTruePeakLimit(
  settings: Readonly<AudioCleanupSettings>,
  direction: 1 | -1,
): AudioCleanupSettings {
  const next =
    Math.round(
      (settings.truePeakLimitDb + direction * TRUE_PEAK_LIMIT_STEP_DB) * 10,
    ) / 10
  return normalizeAudioCleanupSettings({ ...settings, truePeakLimitDb: next })
}
