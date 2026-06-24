import { describe, it, expect } from 'vitest'
import { buildExportArgs } from './ffmpeg'

/** Pull the single `-filter_complex` string out of the arg array. */
function filterOf(args: string[]): string {
  const i = args.indexOf('-filter_complex')
  expect(i).toBeGreaterThanOrEqual(0)
  return args[i + 1]
}

describe('buildExportArgs', () => {
  it('builds trim + concat for two segments with exact float bounds', () => {
    const args = buildExportArgs([
      { start: 2.983, end: 5.5 },
      { start: 8.1, end: 12.04 },
    ])

    const filter = filterOf(args)

    // Per-segment trim/atrim with PTS reset, exact floats preserved.
    expect(filter).toContain('[0:v]trim=start=2.983:end=5.5,setpts=PTS-STARTPTS[v0]')
    expect(filter).toContain('[0:a]atrim=start=2.983:end=5.5,asetpts=PTS-STARTPTS[a0]')
    expect(filter).toContain('[0:v]trim=start=8.1:end=12.04,setpts=PTS-STARTPTS[v1]')
    expect(filter).toContain('[0:a]atrim=start=8.1:end=12.04,asetpts=PTS-STARTPTS[a1]')

    // Concat joins both labelled pairs into the final outputs.
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]')

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

    expect(filter).toBe(
      '[0:v]trim=start=0:end=3.25,setpts=PTS-STARTPTS[outv];' +
        '[0:a]atrim=start=0:end=3.25,asetpts=PTS-STARTPTS[outa]',
    )
    expect(filter).not.toContain('concat')
    expect(args).toEqual(
      expect.arrayContaining(['-map', '[outv]', '-map', '[outa]']),
    )
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
