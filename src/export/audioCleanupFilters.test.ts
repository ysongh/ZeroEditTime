import { describe, expect, it } from 'vitest'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS } from './audioCleanupSettings'
import {
  buildAudioCleanupFilterGraph,
  buildAudioSegmentFilterChain,
  LEGACY_LOUDNORM,
  LIGHT_NOISE_REDUCTION,
  SPEECH_COMPRESSOR,
  STRONG_NOISE_REDUCTION,
} from './audioCleanupFilters'

const DEFAULT_LIMITER =
  'alimiter=limit=0.891250938:attack=5:release=50:level=0:latency=1'

describe('buildAudioCleanupFilterGraph', () => {
  it('preserves the exact legacy chain when cleanup is absent or disabled', () => {
    const disabled = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      enabled: false,
    })

    expect(buildAudioCleanupFilterGraph(undefined)).toEqual({
      filters: [LEGACY_LOUDNORM, 'aresample=48000'],
      filterChain: `${LEGACY_LOUDNORM},aresample=48000`,
    })
    expect(buildAudioCleanupFilterGraph(disabled)).toEqual(
      buildAudioCleanupFilterGraph(undefined),
    )
  })

  it('builds the complete default chain in stable order', () => {
    const built = buildAudioCleanupFilterGraph(
      buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
    )

    expect(built).toEqual({
      filters: [
        LIGHT_NOISE_REDUCTION,
        SPEECH_COMPRESSOR,
        'loudnorm=I=-16:TP=-1:LRA=11',
        'aresample=48000',
        DEFAULT_LIMITER,
      ],
      filterChain:
        `${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},` +
        `loudnorm=I=-16:TP=-1:LRA=11,aresample=48000,${DEFAULT_LIMITER}`,
      segmentFadeCurve: 'qsin',
    })
  })

  it('omits disabled filters and honors runtime fallbacks without no-ops', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
      smoothJoins: false,
    })

    expect(
      buildAudioCleanupFilterGraph(plan, {
        loudnorm: false,
        peakLimiter: false,
      }),
    ).toEqual({
      filters: ['aresample=48000'],
      filterChain: 'aresample=48000',
    })
  })

  it.each([
    {
      name: 'noise reduction',
      settings: {
        noiseReduction: 'light' as const,
        voiceLeveling: false,
        loudnessNormalization: false,
      },
      overrides: { loudnorm: false, peakLimiter: false },
      expected: `${LIGHT_NOISE_REDUCTION},aresample=48000`,
    },
    {
      name: 'voice leveling',
      settings: {
        noiseReduction: 'off' as const,
        voiceLeveling: true,
        loudnessNormalization: false,
      },
      overrides: { loudnorm: false, peakLimiter: false },
      expected: `${SPEECH_COMPRESSOR},aresample=48000`,
    },
    {
      name: 'loudness normalization',
      settings: {
        noiseReduction: 'off' as const,
        voiceLeveling: false,
        loudnessNormalization: true,
      },
      overrides: { peakLimiter: false },
      expected: 'loudnorm=I=-16:TP=-1:LRA=11,aresample=48000',
    },
    {
      name: 'peak limiting',
      settings: {
        noiseReduction: 'off' as const,
        voiceLeveling: false,
        loudnessNormalization: false,
      },
      overrides: { loudnorm: false },
      expected: `aresample=48000,${DEFAULT_LIMITER}`,
    },
  ])('builds the $name stage independently', ({ settings, overrides, expected }) => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      ...settings,
      smoothJoins: false,
    })

    expect(buildAudioCleanupFilterGraph(plan, overrides).filterChain).toBe(
      expected,
    )
  })

  it('normalizes defensive numbers without locale or exponent notation', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
      loudnessTargetLufs: 1e100,
      truePeakLimitDb: -1e100,
    })
    const built = buildAudioCleanupFilterGraph(plan)

    expect(built.filters[0]).toBe(STRONG_NOISE_REDUCTION)
    expect(built.filterChain).toContain('loudnorm=I=-10:TP=-6:LRA=11')
    expect(built.filterChain).toContain('alimiter=limit=0.501187234:')
    expect(built.filterChain).not.toMatch(/\d[eE][+-]?\d/)
    expect(built.filterChain).not.toContain(',5')
  })

  it('canonicalizes a near-zero ceiling instead of emitting negative zero', () => {
    const base = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    const built = buildAudioCleanupFilterGraph({
      ...base,
      loudness: { ...base.loudness, truePeakDb: -1e-12 },
    })

    expect(built.filterChain).toContain('loudnorm=I=-16:TP=0:LRA=11')
    expect(built.filterChain).toContain('alimiter=limit=1:')
    expect(built.filterChain).not.toContain('-0')
  })

  it('does not interpolate malformed runtime settings into FFmpeg syntax', () => {
    const base = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    const injected = '0;[outa]anull[owned]'
    const built = buildAudioCleanupFilterGraph({
      ...base,
      loudness: {
        ...base.loudness,
        targetLufs: injected as unknown as number,
        truePeakDb: injected as unknown as number,
      },
    })

    expect(built.filterChain).toContain('loudnorm=I=-16:TP=-1:LRA=11')
    expect(built.filterChain).toContain(DEFAULT_LIMITER)
    expect(built.filterChain).not.toContain(injected)
    expect(built.filterChain).not.toContain('[owned]')
  })

  it('is deterministic and does not mutate the plan', () => {
    const plan = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    const snapshot = structuredClone(plan)

    expect(buildAudioCleanupFilterGraph(plan)).toEqual(
      buildAudioCleanupFilterGraph(plan),
    )
    expect(plan).toEqual(snapshot)
  })
})

describe('buildAudioSegmentFilterChain', () => {
  it('preserves the legacy linear filter string', () => {
    expect(buildAudioSegmentFilterChain({ start: 2.983, end: 5.5 })).toBe(
      'atrim=start=2.983:end=5.5,asetpts=PTS-STARTPTS,' +
        'afade=t=in:st=0:d=0.015,afade=t=out:st=2.502:d=0.015',
    )
  })

  it('adds only the internal qsin curve and clamps tiny fades', () => {
    expect(buildAudioSegmentFilterChain({ start: 0, end: 0.02 }, 'qsin')).toBe(
      'atrim=start=0:end=0.02,asetpts=PTS-STARTPTS,' +
        'afade=t=in:st=0:d=0.01:curve=qsin,' +
        'afade=t=out:st=0.01:d=0.01:curve=qsin',
    )
  })
})
