import { describe, it, expect } from 'vitest'
import {
  AUDIO_FADE_S,
  buildExportArgs,
  LIGHT_NOISE_REDUCTION,
  SPEECH_COMPRESSOR,
  SMOOTH_JOIN_FADE_CURVE,
  STRONG_NOISE_REDUCTION,
  type BuildExportOptions,
} from './ffmpeg'
import type { ImageOverlayFilterGraph } from './imageOverlays'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS } from './audioCleanupSettings'

/** Pull the single `-filter_complex` string out of the arg array. */
function filterOf(args: string[]): string {
  const i = args.indexOf('-filter_complex')
  expect(i).toBeGreaterThanOrEqual(0)
  return args[i + 1]
}

/** Return every explicitly mapped output in command order. */
function mappedStreams(args: string[]): string[] {
  return args.flatMap((arg, index) =>
    arg === '-map' && args[index + 1] !== undefined ? [args[index + 1]] : [],
  )
}

/**
 * The expected per-segment declick fades, computed with the SAME float
 * arithmetic as the implementation (dur = end - start; out starts at dur - fade)
 * so the stringified values match verbatim.
 */
function fadesFor(start: number, end: number): string {
  const dur = end - start
  const fade = Math.min(AUDIO_FADE_S, dur / 2)
  return `afade=t=in:st=0:d=${fade},afade=t=out:st=${dur - fade}:d=${fade}`
}

function smoothFadesFor(start: number, end: number): string {
  const dur = end - start
  const fade = Math.min(AUDIO_FADE_S, dur / 2)
  return (
    `afade=t=in:st=0:d=${fade}:curve=${SMOOTH_JOIN_FADE_CURVE},` +
    `afade=t=out:st=${dur - fade}:d=${fade}:curve=${SMOOTH_JOIN_FADE_CURVE}`
  )
}

const MASTER_TAIL = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000'
const DEFAULT_LIMITER =
  'alimiter=limit=0.891250938:attack=5:release=50:level=0:latency=1'
const DEFAULT_CLEANUP_TAIL =
  `loudnorm=I=-16:TP=-1:LRA=11,aresample=48000,${DEFAULT_LIMITER}`

const IMAGE_OVERLAY_GRAPH: ImageOverlayFilterGraph = {
  inputArgs: ['-loop', '1', '-i', 'overlay_0.png'],
  filterComplex: '[ovbase]null[ovout]',
  inputVideoLabel: 'ovbase',
  outputVideoLabel: 'ovout',
  stagedAssets: [],
  frameWidth: 1280,
  frameHeight: 720,
}

describe('buildExportArgs', () => {
  it('builds trim + concat for two segments with exact float bounds', () => {
    const args = buildExportArgs([
      { start: 2.983, end: 5.5 },
      { start: 8.1, end: 12.04 },
    ])

    const filter = filterOf(args)

    // Video chain byte-identical to Phase 5: trim + PTS reset only, no fades.
    expect(filter).toContain('[0:v]trim=start=2.983:end=5.5,setpts=PTS-STARTPTS[v0]')
    expect(filter).toContain('[0:v]trim=start=8.1:end=12.04,setpts=PTS-STARTPTS[v1]')

    // Each audio segment carries the segment-local declick fades after asetpts.
    expect(filter).toContain(
      `[0:a]atrim=start=2.983:end=5.5,asetpts=PTS-STARTPTS,${fadesFor(2.983, 5.5)}[a0]`,
    )
    expect(filter).toContain(
      `[0:a]atrim=start=8.1:end=12.04,asetpts=PTS-STARTPTS,${fadesFor(8.1, 12.04)}[a1]`,
    )

    // Concat emits an intermediate audio label; the mastering tail (loudness
    // normalization + pinned 48 kHz resample) produces the final [outa].
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][ca]')
    expect(filter).toContain(`[ca]${MASTER_TAIL}[outa]`)

    // Filter is one single argument; mapping + codecs follow.
    expect(args.filter((a) => a === '-filter_complex')).toHaveLength(1)
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[outv]', '-map', '[outa]']),
    )
    expect(args).toEqual(
      expect.arrayContaining([
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt',
        'yuv420p', '-c:a', 'aac', '-b:a', '128k',
      ]),
    )
    expect(args[args.length - 1]).toBe('output.mp4')
  })

  it('keeps the literal legacy multi-segment argument array byte-identical', () => {
    const first = { start: 2.983, end: 5.5 }
    const second = { start: 8.1, end: 12.04 }

    expect(buildExportArgs([first, second])).toEqual([
      '-i',
      'input.mp4',
      '-filter_complex',
      '[0:v]trim=start=2.983:end=5.5,setpts=PTS-STARTPTS[v0];' +
        `[0:a]atrim=start=2.983:end=5.5,asetpts=PTS-STARTPTS,${fadesFor(first.start, first.end)}[a0];` +
        '[0:v]trim=start=8.1:end=12.04,setpts=PTS-STARTPTS[v1];' +
        `[0:a]atrim=start=8.1:end=12.04,asetpts=PTS-STARTPTS,${fadesFor(second.start, second.end)}[a1];` +
        '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][ca];' +
        `[ca]${MASTER_TAIL}[outa]`,
      '-map',
      '[outv]',
      '-map',
      '[outa]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      'output.mp4',
    ])
  })

  it('skips concat for a single segment and labels the trim outputs directly', () => {
    const args = buildExportArgs([{ start: 0, end: 3.25 }])
    const filter = filterOf(args)

    // Same audio composition as the concat path: atrim, asetpts, fades, then
    // the identical loudnorm+aresample tail straight into [outa].
    expect(filter).toBe(
      '[0:v]trim=start=0:end=3.25,setpts=PTS-STARTPTS[outv];' +
        `[0:a]atrim=start=0:end=3.25,asetpts=PTS-STARTPTS,${fadesFor(0, 3.25)},${MASTER_TAIL}[outa]`,
    )
    expect(filter).not.toContain('concat')
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[outv]', '-map', '[outa]']),
    )
  })

  it('clamps the fades to half the duration of a tiny segment', () => {
    // 20 ms segment: full 15 ms fades would overlap and push the fade-out start
    // negative; the clamp gives 10 ms each, with the fade-out starting mid-segment.
    const args = buildExportArgs([{ start: 0, end: 0.02 }])
    expect(filterOf(args)).toContain(
      'afade=t=in:st=0:d=0.01,afade=t=out:st=0.01:d=0.01',
    )
  })

  it('drops only loudnorm when the fallback option is set', () => {
    const args = buildExportArgs(
      [
        { start: 2.983, end: 5.5 },
        { start: 8.1, end: 12.04 },
      ],
      'input.mp4',
      'output.mp4',
      { loudnorm: false },
    )
    const filter = filterOf(args)

    // Fades and the pinned resample survive; only the normalizer is gone.
    expect(filter).toContain('[ca]aresample=48000[outa]')
    expect(filter).not.toContain('loudnorm')
    expect(filter).toContain(fadesFor(2.983, 5.5))
  })

  it('honors custom input/output names', () => {
    const args = buildExportArgs([{ start: 1, end: 2 }], 'input.webm', 'out.mp4')
    expect(args[0]).toBe('-i')
    expect(args[1]).toBe('input.webm')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('throws when there are no segments to keep', () => {
    expect(() => buildExportArgs([])).toThrow()
  })

  it('keeps the entire pre-overlay argument array byte-identical with no graph', () => {
    const segments = [{ start: 0, end: 3.25 }]
    const before = buildExportArgs(segments)

    expect(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', {
        imageOverlayGraph: null,
      }),
    ).toEqual(before)
    expect(before).toEqual([
      '-i',
      'input.mp4',
      '-filter_complex',
      '[0:v]trim=start=0:end=3.25,setpts=PTS-STARTPTS[outv];' +
        `[0:a]atrim=start=0:end=3.25,asetpts=PTS-STARTPTS,${fadesFor(0, 3.25)},${MASTER_TAIL}[outa]`,
      '-map',
      '[outv]',
      '-map',
      '[outa]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      'output.mp4',
    ])

    const existingOptions: BuildExportOptions[] = [
      { loudnorm: false },
      { srtFile: 'captions.srt' },
      { loudnorm: false, srtFile: 'captions.srt' },
    ]
    for (const existing of existingOptions) {
      expect(
        buildExportArgs(segments, 'input.mp4', 'output.mp4', {
          ...existing,
          imageOverlayGraph: null,
        }),
      ).toEqual(buildExportArgs(segments, 'input.mp4', 'output.mp4', existing))
    }
  })

  it('keeps the legacy arguments byte-identical when audio cleanup is disabled', () => {
    const disabledPlan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      enabled: false,
    })
    const segmentSets = [
      [{ start: 0, end: 3.25 }],
      [
        { start: 2.983, end: 5.5 },
        { start: 8.1, end: 12.04 },
      ],
    ]
    const existingOptions: BuildExportOptions[] = [
      {},
      { loudnorm: false },
      { srtFile: 'captions.srt' },
      { imageOverlayGraph: IMAGE_OVERLAY_GRAPH },
      {
        loudnorm: false,
        srtFile: 'captions.srt',
        imageOverlayGraph: IMAGE_OVERLAY_GRAPH,
      },
    ]

    for (const segments of segmentSets) {
      for (const existing of existingOptions) {
        expect(
          buildExportArgs(segments, 'source.webm', 'result.mp4', {
            ...existing,
            audioCleanup: disabledPlan,
          }),
        ).toEqual(
          buildExportArgs(segments, 'source.webm', 'result.mp4', existing),
        )
      }
    }
  })

  it('keeps one audio output when individually toggleable operations are disabled', () => {
    const noOpPlan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      enabled: true,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
      smoothJoins: false,
    })
    const segments = [
      { start: 1.25, end: 4.75 },
      { start: 6, end: 9.5 },
    ]

    const args = buildExportArgs(segments, 'input.mp4', 'output.mp4', {
      audioCleanup: noOpPlan,
    })
    const filter = filterOf(args)

    expect(filter).toContain(`[ca]aresample=48000,${DEFAULT_LIMITER}[outa]`)
    expect(filter).not.toContain('afftdn=')
    expect(filter).not.toContain('acompressor=')
    expect(filter).not.toContain('loudnorm=')
    expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
  })

  it('adds conservative light noise reduction before the legacy mastering tail', () => {
    const plan = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    const filter = filterOf(
      buildExportArgs(
        [
          { start: 0, end: 2 },
          { start: 3, end: 5 },
        ],
        'input.mp4',
        'output.mp4',
        { audioCleanup: plan },
      ),
    )

    expect(filter).toContain(
      `[ca]${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${DEFAULT_CLEANUP_TAIL}[outa]`,
    )
    expect(filter.match(/afftdn=/g)).toHaveLength(1)
  })

  it('maps strong noise intent without changing segment-local cut handling', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
    })
    const filter = filterOf(
      buildExportArgs([{ start: 1, end: 4 }], 'input.mp4', 'output.mp4', {
        audioCleanup: plan,
      }),
    )

    expect(filter).toContain(smoothFadesFor(1, 4))
    expect(filter).toContain(
      `,${STRONG_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${DEFAULT_CLEANUP_TAIL}[outa]`,
    )
  })

  it('adds voice leveling after denoising and omits it when disabled', () => {
    const segments = [{ start: 0, end: 4 }]
    const enabled = filterOf(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', {
        audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
      }),
    )
    const disabled = filterOf(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', {
        audioCleanup: buildAudioCleanupPlan({
          ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
          voiceLeveling: false,
        }),
      }),
    )

    expect(enabled).toContain(
      `${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${DEFAULT_CLEANUP_TAIL}`,
    )
    expect(enabled.match(/acompressor=/g)).toHaveLength(1)
    expect(disabled).toContain(
      `${LIGHT_NOISE_REDUCTION},${DEFAULT_CLEANUP_TAIL}`,
    )
    expect(disabled).not.toContain('acompressor=')
  })

  it('uses the plan LUFS target in single-pass loudnorm', () => {
    for (const targetLufs of [-14, -18]) {
      const plan = buildAudioCleanupPlan({
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        noiseReduction: 'off',
        voiceLeveling: false,
        loudnessTargetLufs: targetLufs,
      })
      const filter = filterOf(
        buildExportArgs([{ start: 0, end: 4 }], 'input.mp4', 'output.mp4', {
          audioCleanup: plan,
        }),
      )

      expect(filter).toContain(
        `loudnorm=I=${targetLufs}:TP=-1:LRA=11,aresample=48000,${DEFAULT_LIMITER}[outa]`,
      )
    }
  })

  it('omits loudnorm when Phase-10 loudness normalization is disabled', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
    })
    const filter = filterOf(
      buildExportArgs([{ start: 0, end: 4 }], 'input.mp4', 'output.mp4', {
        audioCleanup: plan,
      }),
    )

    expect(filter).toContain(`aresample=48000,${DEFAULT_LIMITER}[outa]`)
    expect(filter).not.toContain('loudnorm=')
  })

  it('applies the configured peak ceiling after resampling with latency compensation', () => {
    const plan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      truePeakLimitDb: -3,
    })
    const filter = filterOf(
      buildExportArgs([{ start: 0, end: 4 }], 'input.mp4', 'output.mp4', {
        audioCleanup: plan,
      }),
    )

    expect(filter).toContain(
      'loudnorm=I=-16:TP=-3:LRA=11,aresample=48000,' +
        'alimiter=limit=0.707945784:attack=5:release=50:level=0:latency=1[outa]',
    )
    expect(filter.indexOf('aresample=48000')).toBeLessThan(
      filter.indexOf('alimiter='),
    )
  })

  it('uses short qsin fades for smoother joins without changing timing', () => {
    const segments = [
      { start: 2, end: 5 },
      { start: 8, end: 11.5 },
    ]
    const filter = filterOf(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', {
        audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
      }),
    )

    expect(filter).toContain(smoothFadesFor(2, 5))
    expect(filter).toContain(smoothFadesFor(8, 11.5))
    expect(filter).toContain('concat=n=2:v=1:a=1')
    expect(filter).not.toContain('acrossfade')
    expect(filter).not.toContain('adelay')
    expect(filter).not.toContain('atempo')
  })

  it('keeps legacy linear declick fades when smooth joins are disabled', () => {
    const filter = filterOf(
      buildExportArgs([{ start: 1, end: 4 }], 'input.mp4', 'output.mp4', {
        audioCleanup: buildAudioCleanupPlan({
          ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
          smoothJoins: false,
        }),
      }),
    )

    expect(filter).toContain(fadesFor(1, 4))
    expect(filter).not.toContain('curve=')
  })

  it('clamps smooth fades to half of a tiny kept segment', () => {
    const filter = filterOf(
      buildExportArgs([{ start: 0, end: 0.02 }], 'input.mp4', 'output.mp4', {
        audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
      }),
    )

    expect(filter).toContain(
      'afade=t=in:st=0:d=0.01:curve=qsin,' +
        'afade=t=out:st=0.01:d=0.01:curve=qsin',
    )
  })

  it('keeps the complete cleanup pipeline in deliberate post-concat order', () => {
    const filter = filterOf(
      buildExportArgs(
        [
          { start: 1.25, end: 4.5 },
          { start: 7, end: 10.25 },
        ],
        'input.mp4',
        'output.mp4',
        { audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS) },
      ),
    )
    const orderedTail =
      `[ca]${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},` +
      `${DEFAULT_CLEANUP_TAIL}[outa]`

    expect(filter).toContain(smoothFadesFor(1.25, 4.5))
    expect(filter).toContain(smoothFadesFor(7, 10.25))
    expect(filter).toContain(
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][ca]',
    )
    expect(filter).toContain(orderedTail)
    expect(filter.indexOf('concat=n=2:v=1:a=1')).toBeLessThan(
      filter.indexOf(LIGHT_NOISE_REDUCTION),
    )
    expect(filter.indexOf(LIGHT_NOISE_REDUCTION)).toBeLessThan(
      filter.indexOf(SPEECH_COMPRESSOR),
    )
    expect(filter.indexOf(SPEECH_COMPRESSOR)).toBeLessThan(
      filter.indexOf('loudnorm='),
    )
    expect(filter.indexOf('loudnorm=')).toBeLessThan(
      filter.indexOf('aresample=48000'),
    )
    expect(filter.indexOf('aresample=48000')).toBeLessThan(
      filter.indexOf('alimiter='),
    )
    expect(filter.match(/afftdn=/g)).toHaveLength(1)
    expect(filter.match(/acompressor=/g)).toHaveLength(1)
    expect(filter.match(/loudnorm=/g)).toHaveLength(1)
    expect(filter.match(/alimiter=/g)).toHaveLength(1)
  })

  it('keeps audio timing tied to the EDL with captions and overlays present', () => {
    const segments = [
      { start: 2.983, end: 5.5 },
      { start: 8.1, end: 12.04 },
    ]
    const args = buildExportArgs(segments, 'input.mp4', 'output.mp4', {
      audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
      imageOverlayGraph: IMAGE_OVERLAY_GRAPH,
      srtFile: 'captions.srt',
    })
    const filter = filterOf(args)

    for (const { start, end } of segments) {
      expect(filter).toContain(`trim=start=${start}:end=${end}`)
      expect(filter).toContain(`atrim=start=${start}:end=${end}`)
    }
    expect(filter.match(/,setpts=PTS-STARTPTS/g)).toHaveLength(2)
    expect(filter.match(/,asetpts=PTS-STARTPTS/g)).toHaveLength(2)
    expect(filter).toContain('concat=n=2:v=1:a=1[ovbase][ca]')
    const postConcatAudio = filter.slice(filter.indexOf(';[ca]'))
    expect(postConcatAudio).not.toMatch(/\b(?:atempo|adelay|apad|atrim)\b/)
    expect(postConcatAudio).toContain(
      `[ca]${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${DEFAULT_CLEANUP_TAIL}[outa]`,
    )
    expect(postConcatAudio.match(/afftdn=/g)).toHaveLength(1)
    expect(postConcatAudio.match(/acompressor=/g)).toHaveLength(1)
    expect(postConcatAudio.match(/loudnorm=/g)).toHaveLength(1)
    expect(postConcatAudio.match(/aresample=/g)).toHaveLength(1)
    expect(postConcatAudio.match(/alimiter=/g)).toHaveLength(1)
    expect(filter.indexOf('[ovbase]null[ovout]')).toBeLessThan(
      filter.indexOf('[ovout]subtitles='),
    )
    expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
  })

  it('builds a complete video-only graph for a source proven to have no audio', () => {
    const args = buildExportArgs(
      [
        { start: 1.25, end: 4.75 },
        { start: 6, end: 9.5 },
      ],
      'input.mp4',
      'output.mp4',
      {
        includeAudio: false,
        audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
        imageOverlayGraph: IMAGE_OVERLAY_GRAPH,
        srtFile: 'captions.srt',
      },
    )
    const filter = filterOf(args)

    expect(filter).toBe(
      '[0:v]trim=start=1.25:end=4.75,setpts=PTS-STARTPTS[v0];' +
        '[0:v]trim=start=6:end=9.5,setpts=PTS-STARTPTS[v1];' +
        '[v0][v1]concat=n=2:v=1:a=0[ovbase];' +
        '[ovbase]null[ovout];' +
        `[ovout]${SUBTITLES_CLAUSE}[outv]`,
    )
    expect(filter).not.toMatch(
      /\[0:a\]|\[outa\]|\[ca\]|atrim|afade|afftdn|acompressor|loudnorm|aresample|alimiter/,
    )
    expect(mappedStreams(args)).toEqual(['[outv]'])
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('-b:a')
  })

  it('keeps the no-audio single-segment path free of concat and audio syntax', () => {
    const args = buildExportArgs(
      [{ start: 0, end: 0.5 }],
      'input.mp4',
      'output.mp4',
      { includeAudio: false },
    )

    expect(filterOf(args)).toBe(
      '[0:v]trim=start=0:end=0.5,setpts=PTS-STARTPTS[outv]',
    )
    expect(mappedStreams(args)).toEqual(['[outv]'])
  })

  it('keeps cleanup valid for a one-millisecond audio clip', () => {
    const args = buildExportArgs(
      [{ start: 0, end: 0.001 }],
      'input.mp4',
      'output.mp4',
      { audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS) },
    )
    const filter = filterOf(args)

    expect(filter).toContain(
      'afade=t=in:st=0:d=0.0005:curve=qsin,' +
        'afade=t=out:st=0.0005:d=0.0005:curve=qsin',
    )
    expect(filter).toContain(
      `${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${DEFAULT_CLEANUP_TAIL}[outa]`,
    )
    expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
  })

  it('does not invent padding or shortest-stream truncation for shorter audio', () => {
    const args = buildExportArgs(
      [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
      'input.mp4',
      'output.mp4',
      { audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS) },
    )

    // The concat filter retains FFmpeg's established stream-duration handling.
    // Cleanup adds no timing policy such as synthetic padding or `-shortest`.
    expect(filterOf(args)).toContain('concat=n=2:v=1:a=1[outv][ca]')
    expect(filterOf(args)).not.toMatch(/\bapad(?:=|\b)/)
    expect(args).not.toContain('-shortest')
  })

  it('pins only sample rate across legacy and cleanup assembly paths', () => {
    const disabledPlan = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      enabled: false,
    })
    const cases: Array<{
      segments: Array<{ start: number; end: number }>
      options: BuildExportOptions
    }> = [
      { segments: [{ start: 0, end: 4 }], options: {} },
      {
        segments: [
          { start: 0, end: 2 },
          { start: 3, end: 5 },
        ],
        options: { audioCleanup: disabledPlan },
      },
      {
        segments: [
          { start: 0, end: 2 },
          { start: 3, end: 5 },
        ],
        options: {
          audioCleanup: buildAudioCleanupPlan(
            DEFAULT_AUDIO_CLEANUP_SETTINGS,
          ),
        },
      },
    ]

    for (const { segments, options } of cases) {
      // Source metadata is intentionally absent: FFmpeg discovers it while
      // decoding. These invariants prevent the command from forcing a mono or
      // stereo conversion while retaining the established 48 kHz output.
      const args = buildExportArgs(
        segments,
        'input.mp4',
        'output.mp4',
        options,
      )
      const filter = filterOf(args)

      expect(filter.match(/\baresample=/g)).toHaveLength(1)
      expect(filter.match(/aresample=48000/g)).toHaveLength(1)
      expect(filter).not.toMatch(
        /\b(?:aformat|amerge|channelmap|channelsplit|join|pan)=/,
      )
      expect(args.some((arg) => /^-ac(?::.*)?$/.test(arg))).toBe(false)
      expect(
        args.some((arg) => /^-(?:ch_layout|channel_layout)(?::.*)?$/.test(arg)),
      ).toBe(false)
      expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
    }
  })
})

describe('buildExportArgs with image overlays', () => {
  const options: BuildExportOptions = {
    imageOverlayGraph: IMAGE_OVERLAY_GRAPH,
  }

  it('assembles one kept segment into the overlay base and maps its result', () => {
    const args = buildExportArgs(
      [{ start: 0, end: 3.25 }],
      'input.mp4',
      'output.mp4',
      options,
    )
    const filter = filterOf(args)

    expect(args.slice(0, 6)).toEqual([
      '-i',
      'input.mp4',
      '-loop',
      '1',
      '-i',
      'overlay_0.png',
    ])
    expect(filter).toBe(
      '[0:v]trim=start=0:end=3.25,setpts=PTS-STARTPTS[ovbase];' +
        `[0:a]atrim=start=0:end=3.25,asetpts=PTS-STARTPTS,${fadesFor(0, 3.25)},${MASTER_TAIL}[outa];` +
        '[ovbase]null[ovout]',
    )
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[ovout]', '-map', '[outa]']),
    )
  })

  it('composites after multi-segment EDL assembly without changing audio', () => {
    const segments = [
      { start: 2.983, end: 5.5 },
      { start: 8.1, end: 12.04 },
    ]
    const filter = filterOf(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', options),
    )

    expect(filter).toContain(
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[ovbase][ca]',
    )
    expect(filter).toContain(`[ca]${MASTER_TAIL}[outa]`)
    expect(filter.endsWith(';[ovbase]null[ovout]')).toBe(true)
  })

  it('burns captions after image compositing and keeps loudnorm fallback intact', () => {
    const args = buildExportArgs(
      [{ start: 0, end: 3.25 }],
      'input.mp4',
      'output.mp4',
      {
        imageOverlayGraph: IMAGE_OVERLAY_GRAPH,
        srtFile: 'captions.srt',
        loudnorm: false,
      },
    )
    const filter = filterOf(args)

    expect(filter).toContain('aresample=48000[outa]')
    expect(filter).not.toContain('loudnorm')
    expect(filter.indexOf('[ovbase]null[ovout]')).toBeLessThan(
      filter.indexOf(`[ovout]${SUBTITLES_CLAUSE}[outv]`),
    )
    expect(filter.endsWith(`[ovout]${SUBTITLES_CLAUSE}[outv]`)).toBe(true)
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[outv]', '-map', '[outa]']),
    )
  })
})

// The exact Phase-6 burn clause, spelled out verbatim (NOT imported from the
// implementation) so a style regression fails the test.
const SUBTITLES_CLAUSE =
  "subtitles=captions.srt:fontsdir=/fonts:force_style='FontName=Roboto,Bold=1," +
  'FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,' +
  "Outline=2,Shadow=0,Alignment=2,MarginV=36'"

describe('buildExportArgs with srtFile (caption burn)', () => {
  const twoSegments = [
    { start: 2.983, end: 5.5 },
    { start: 8.1, end: 12.04 },
  ]

  it('routes concat video through [cv] into the subtitles stage', () => {
    const args = buildExportArgs(twoSegments, 'input.mp4', 'output.mp4', {
      srtFile: 'captions.srt',
    })
    const filter = filterOf(args)

    // Concat emits the intermediate [cv]; the burn is the final video stage.
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[cv][ca]')
    expect(filter.endsWith(`;[cv]${SUBTITLES_CLAUSE}[outv]`)).toBe(true)

    // The audio side is untouched by the burn.
    expect(filter).toContain(`[ca]${MASTER_TAIL}[outa]`)
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[outv]', '-map', '[outa]']),
    )
    // Still ONE -filter_complex argument (the style quotes live inside it).
    expect(args.filter((a) => a === '-filter_complex')).toHaveLength(1)
  })

  it('burns after trim/setpts on the single-segment path', () => {
    const args = buildExportArgs([{ start: 0, end: 3.25 }], 'input.mp4', 'output.mp4', {
      srtFile: 'captions.srt',
    })

    expect(filterOf(args)).toBe(
      '[0:v]trim=start=0:end=3.25,setpts=PTS-STARTPTS[cv];' +
        `[0:a]atrim=start=0:end=3.25,asetpts=PTS-STARTPTS,${fadesFor(0, 3.25)},${MASTER_TAIL}[outa];` +
        `[cv]${SUBTITLES_CLAUSE}[outv]`,
    )
  })

  it('composes with the loudnorm-off fallback', () => {
    const args = buildExportArgs(twoSegments, 'input.mp4', 'output.mp4', {
      loudnorm: false,
      srtFile: 'captions.srt',
    })
    const filter = filterOf(args)

    expect(filter).toContain('[ca]aresample=48000[outa]')
    expect(filter).not.toContain('loudnorm')
    expect(filter.endsWith(`;[cv]${SUBTITLES_CLAUSE}[outv]`)).toBe(true)
  })

  it('emits a graph byte-identical to Phase 5.5 when srtFile is absent', () => {
    for (const segments of [twoSegments, [{ start: 0, end: 3.25 }]]) {
      const filter = filterOf(buildExportArgs(segments))
      expect(filter).not.toContain('subtitles')
      expect(filter).not.toContain('[cv]')
      // Explicit options without srtFile change nothing either.
      expect(buildExportArgs(segments)).toEqual(
        buildExportArgs(segments, 'input.mp4', 'output.mp4', {}),
      )
    }
  })
})
