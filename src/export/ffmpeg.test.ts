import { describe, it, expect } from 'vitest'
import {
  AUDIO_FADE_S,
  buildExportArgs,
  LIGHT_NOISE_REDUCTION,
  SPEECH_COMPRESSOR,
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

const MASTER_TAIL = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000'

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

  it('adds no cleanup filters when every individual operation is disabled', () => {
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

    const filter = filterOf(
      buildExportArgs(segments, 'input.mp4', 'output.mp4', {
        audioCleanup: noOpPlan,
      }),
    )

    expect(filter).toContain('[ca]aresample=48000[outa]')
    expect(filter).not.toContain('afftdn=')
    expect(filter).not.toContain('acompressor=')
    expect(filter).not.toContain('loudnorm=')
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
      `[ca]${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${MASTER_TAIL}[outa]`,
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

    expect(filter).toContain(fadesFor(1, 4))
    expect(filter).toContain(
      `,${STRONG_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${MASTER_TAIL}[outa]`,
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
      `${LIGHT_NOISE_REDUCTION},${SPEECH_COMPRESSOR},${MASTER_TAIL}`,
    )
    expect(enabled.match(/acompressor=/g)).toHaveLength(1)
    expect(disabled).toContain(`${LIGHT_NOISE_REDUCTION},${MASTER_TAIL}`)
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
        `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11,aresample=48000[outa]`,
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

    expect(filter).toContain('aresample=48000[outa]')
    expect(filter).not.toContain('loudnorm=')
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
