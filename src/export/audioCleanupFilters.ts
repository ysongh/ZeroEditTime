import type { AudioCleanupPlan } from './audioCleanupPlan'

export const AUDIO_FADE_S = 0.015
export const SMOOTH_JOIN_FADE_CURVE = 'qsin'
export type AudioFadeCurve = typeof SMOOTH_JOIN_FADE_CURVE

export const LOUDNORM_LRA = 11
export const LEGACY_LOUDNORM_TRUE_PEAK_DB = -1.5
export const LEGACY_LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
export const OUTPUT_SAMPLE_RATE = 48000

export const LIGHT_NOISE_REDUCTION = 'afftdn=nr=6:nf=-45'
export const STRONG_NOISE_REDUCTION = 'afftdn=nr=12:nf=-40'
export const SPEECH_COMPRESSOR =
  'acompressor=threshold=0.125:ratio=3:attack=20:release=250:' +
  'makeup=1:knee=2.82843:link=maximum:detection=rms'

export interface AudioFilterOverrides {
  /** Runtime fallback switch after a missing loudnorm failure. */
  loudnorm?: boolean
  /** Runtime fallback switch after a missing/incompatible alimiter failure. */
  peakLimiter?: boolean
}

/**
 * The export pipeline owns stable labels because it must compose audio with the
 * existing video concat, captions, and overlays. This pure result contains only
 * the label-free chain inserted between `[ca]` (or a single segment) and
 * `[outa]`, plus the internal segment-fade curve selected by cleanup intent.
 */
export interface BuiltAudioFilterGraph {
  filters: readonly string[]
  filterChain: string
  segmentFadeCurve?: AudioFadeCurve
}

function normalizeNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Locale-independent FFmpeg number formatting with no exponent notation. */
function formatFilterNumber(value: number): string {
  const formatted = value.toFixed(9).replace(/\.?0+$/, '')
  return formatted === '-0' ? '0' : formatted
}

function loudnormForTarget(targetLufs: number, truePeakDb: number): string {
  const target = normalizeNumber(targetLufs, -24, -10, -16)
  const truePeak = normalizeNumber(truePeakDb, -6, 0, -1)
  return (
    `loudnorm=I=${formatFilterNumber(target)}:` +
    `TP=${formatFilterNumber(truePeak)}:LRA=${LOUDNORM_LRA}`
  )
}

function limiterForTarget(truePeakDb: number): string {
  const clamped = normalizeNumber(truePeakDb, -6, 0, -1)
  const amplitude = Math.pow(10, clamped / 20)
  return (
    `alimiter=limit=${formatFilterNumber(amplitude)}:` +
    'attack=5:release=50:level=0:latency=1'
  )
}

/**
 * Build the deterministic post-concat cleanup chain. No labels or user strings
 * are interpolated; every configurable number is bounded and normalized first.
 */
export function buildAudioCleanupFilterGraph(
  plan: Readonly<AudioCleanupPlan> | undefined,
  overrides: Readonly<AudioFilterOverrides> = {},
): BuiltAudioFilterGraph {
  const enabled = plan?.enabled === true
  const filters: string[] = []

  if (enabled && plan.noiseReduction.enabled) {
    filters.push(
      plan.noiseReduction.strength === 'strong'
        ? STRONG_NOISE_REDUCTION
        : LIGHT_NOISE_REDUCTION,
    )
  }
  if (enabled && plan.voiceLeveling.enabled) {
    filters.push(SPEECH_COMPRESSOR)
  }

  const loudnessEnabled = enabled ? plan.loudness.enabled : true
  if ((overrides.loudnorm ?? true) && loudnessEnabled) {
    filters.push(
      enabled
        ? loudnormForTarget(plan.loudness.targetLufs, plan.loudness.truePeakDb)
        : LEGACY_LOUDNORM,
    )
  }

  // loudnorm internally outputs 192 kHz. Pinning the final encode rate before
  // limiting makes the ceiling the last operation on the actual output signal.
  filters.push(`aresample=${OUTPUT_SAMPLE_RATE}`)

  if (enabled && (overrides.peakLimiter ?? true)) {
    filters.push(limiterForTarget(plan.loudness.truePeakDb))
  }

  return {
    filters,
    filterChain: filters.join(','),
    ...(enabled && plan.smoothJoins.enabled
      ? { segmentFadeCurve: SMOOTH_JOIN_FADE_CURVE }
      : {}),
  }
}

export interface AudioSegmentRange {
  start: number
  end: number
}

/** Build the segment-local EDL trim, PTS reset, and clamped declick fades. */
export function buildAudioSegmentFilterChain(
  segment: Readonly<AudioSegmentRange>,
  fadeCurve?: AudioFadeCurve,
): string {
  const duration = segment.end - segment.start
  const fade = Math.min(AUDIO_FADE_S, duration / 2)
  const curve = fadeCurve === undefined ? '' : `:curve=${fadeCurve}`
  return (
    `atrim=start=${segment.start}:end=${segment.end},` +
    'asetpts=PTS-STARTPTS,' +
    `afade=t=in:st=0:d=${fade}${curve},` +
    `afade=t=out:st=${duration - fade}:d=${fade}${curve}`
  )
}
