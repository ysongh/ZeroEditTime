import { describe, expect, it } from 'vitest'
import { removeSilences } from '../agent/tools'
import {
  applyRemovedRange,
  createEdl,
  totalKeptDuration,
} from '../edl/edl'
import type { EDL } from '../edl/types'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS } from './audioCleanupSettings'
import { buildExportArgs, type ExportSegment } from './ffmpeg'

const SOURCE = { id: 'phase-10', url: 'blob:source', duration: 12 }
const CLEANUP_PLAN = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
const DISABLED_PLAN = buildAudioCleanupPlan({
  ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
  enabled: false,
})

function filterOf(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  expect(index).toBeGreaterThanOrEqual(0)
  return args[index + 1]
}

function mappedStreams(args: string[]): string[] {
  return args.flatMap((arg, index) =>
    arg === '-map' && args[index + 1] !== undefined ? [args[index + 1]] : [],
  )
}

function exportSegments(edl: EDL): ExportSegment[] {
  return edl.segments.map(({ start, end }) => ({ start, end }))
}

function removeRanges(
  edl: EDL,
  ranges: ReadonlyArray<readonly [number, number]>,
): EDL {
  return ranges.reduce(
    (current, [start, end]) => applyRemovedRange(current, start, end),
    edl,
  )
}

function plainRanges(edl: EDL): Array<[number, number]> {
  return edl.segments.map(({ start, end }) => [start, end])
}

function videoTrimClauses(filter: string): string[] {
  return filter
    .split(';')
    .filter((clause) => clause.startsWith('[0:v]trim='))
}

function expectAlignedSegmentBounds(
  filter: string,
  segments: readonly ExportSegment[],
): void {
  for (const { start, end } of segments) {
    expect(filter).toContain(
      `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS`,
    )
    expect(filter).toContain(
      `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`,
    )
  }
}

describe('Phase 10 EDL and join integration', () => {
  it('keeps a no-cut source on identical video and audio bounds', () => {
    const edl = createEdl(SOURCE)
    const segments = exportSegments(edl)
    const args = buildExportArgs(segments, 'input.mp4', 'output.mp4', {
      audioCleanup: CLEANUP_PLAN,
    })
    const filter = filterOf(args)

    expect(segments).toEqual([{ start: 0, end: 12 }])
    expectAlignedSegmentBounds(filter, segments)
    expect(filter).not.toContain('concat=')
    expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
  })

  it.each([
    {
      name: 'one cut through speech',
      removals: [[0.4, 0.6]] as const,
    },
    {
      name: 'several cuts',
      removals: [
        [1, 2],
        [4, 5],
        [7, 9],
      ] as const,
    },
    {
      name: 'closely spaced cuts',
      removals: [
        [2, 2.25],
        [2.265625, 2.5],
      ] as const,
      tinyFade: 'd=0.0078125:curve=qsin',
    },
  ])(
    'keeps stable labels, duration, and A/V bounds across $name',
    ({ removals, tinyFade }) => {
      const edl = removeRanges(createEdl(SOURCE), removals)
      const segments = exportSegments(edl)
      const options = { audioCleanup: CLEANUP_PLAN }
      const args = buildExportArgs(
        segments,
        'input.mp4',
        'output.mp4',
        options,
      )
      const repeated = buildExportArgs(
        segments,
        'input.mp4',
        'output.mp4',
        options,
      )
      const filter = filterOf(args)

      expect(repeated).toEqual(args)
      expectAlignedSegmentBounds(filter, segments)
      expect(filter).toContain(`concat=n=${segments.length}:v=1:a=1[outv][ca]`)
      expect(filter.match(/\[a\d+\]/g)).toHaveLength(segments.length * 2)
      expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
      expect(totalKeptDuration(edl)).toBeCloseTo(
        segments.reduce((total, segment) => total + segment.end - segment.start, 0),
      )

      const disabledFilter = filterOf(
        buildExportArgs(segments, 'input.mp4', 'output.mp4', {
          audioCleanup: DISABLED_PLAN,
        }),
      )
      expect(videoTrimClauses(filter)).toEqual(videoTrimClauses(disabledFilter))

      const postConcatAudio = filter.slice(filter.indexOf(';[ca]'))
      expect(postConcatAudio).not.toMatch(
        /\b(?:acrossfade|adelay|apad|atempo)\b/,
      )
      if (tinyFade !== undefined) {
        expect(filter).toContain(tinyFade)
      }
    },
  )

  it('carries natural pacing removals into a three-segment cleanup export', () => {
    const source = { ...SOURCE, duration: 8 }
    const edl = createEdl(source)
    const transcript = {
      words: [
        { text: 'one', start: 0, end: 1 },
        { text: 'two', start: 3, end: 4 },
        { text: 'three', start: 6, end: 7 },
      ],
    }
    const paced = removeSilences(edl, transcript, {
      threshold_ms: 500,
      keep_gap_ms: 250,
    }).edl
    const maximallyTight = removeSilences(edl, transcript, {
      threshold_ms: 500,
      keep_gap_ms: 0,
    }).edl
    const segments = exportSegments(paced)
    const args = buildExportArgs(segments, 'input.mp4', 'output.mp4', {
      audioCleanup: CLEANUP_PLAN,
    })
    const filter = filterOf(args)

    expect(plainRanges(paced)).toEqual([
      [0, 1.125],
      [2.875, 4.125],
      [5.875, 8],
    ])
    expect(totalKeptDuration(paced) - totalKeptDuration(maximallyTight)).toBeCloseTo(
      0.5,
    )
    expectAlignedSegmentBounds(filter, segments)
    expect(filter).toContain('concat=n=3:v=1:a=1[outv][ca]')
    expect(filter.match(/afftdn=/g)).toHaveLength(1)
    expect(filter.match(/acompressor=/g)).toHaveLength(1)
    expect(filter.match(/loudnorm=/g)).toHaveLength(1)
    expect(filter.match(/alimiter=/g)).toHaveLength(1)
    expect(mappedStreams(args)).toEqual(['[outv]', '[outa]'])
    expect(filter.slice(filter.indexOf(';[ca]'))).not.toMatch(
      /\b(?:acrossfade|adelay|apad|atempo)\b/,
    )
  })
})
