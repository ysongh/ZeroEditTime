import { describe, it, expect } from 'vitest'
import { AUDIO_FADE_S, buildExportArgs } from './ffmpeg'

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
})
