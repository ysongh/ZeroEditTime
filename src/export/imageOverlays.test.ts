import { describe, expect, it } from 'vitest'
import type { EDL } from '../edl/types'
import type { OverlayRenderSegment } from '../overlays/renderPlan'
import type { OverlayAsset } from '../overlays/types'
import {
  buildImageOverlayFilterGraph,
  buildImageOverlayRenderPlanForEdl,
  coalesceContinuousOverlaySegments,
  deriveRemovedSourceRanges,
} from './imageOverlays'

const PNG: OverlayAsset = {
  id: 'asset-png',
  kind: 'image',
  name: 'logo [final]; weird.png',
  mimeType: 'image/png',
  width: 800,
  height: 400,
  src: 'blob:logo',
}

const WEBP: OverlayAsset = {
  id: 'asset-webp',
  kind: 'image',
  name: 'cutaway.webp',
  mimeType: 'image/webp',
  width: 1600,
  height: 900,
  src: 'blob:cutaway',
}

const SEGMENT: OverlayRenderSegment = {
  overlayId: 'overlay-1',
  assetId: PNG.id,
  sourceStartMs: 1_000,
  sourceEndMs: 4_000,
  outputStartMs: 1_000,
  outputEndMs: 4_000,
  x: 0.1,
  y: 0.2,
  width: 0.4,
  height: 0.3,
  fit: 'contain',
  opacity: 0.8,
  zIndex: 2,
  fadeInMs: 500,
  fadeOutMs: 750,
}

function edl(
  duration: number,
  segments: Array<{ id: string; start: number; end: number }>,
): Pick<EDL, 'source' | 'segments'> {
  return {
    source: { id: 'source', url: 'blob:video', duration },
    segments,
  }
}

describe('deriveRemovedSourceRanges', () => {
  it('returns the head, interior, and tail complement of kept EDL segments', () => {
    expect(
      deriveRemovedSourceRanges(
        edl(12, [
          { id: 'late', start: 8, end: 10 },
          { id: 'middle', start: 3, end: 5 },
        ]),
      ),
    ).toEqual([
      { startMs: 0, endMs: 3_000 },
      { startMs: 5_000, endMs: 8_000 },
      { startMs: 10_000, endMs: 12_000 },
    ])
  })

  it('unions overlapping/adjacent kept segments and clamps them to the source', () => {
    expect(
      deriveRemovedSourceRanges(
        edl(10, [
          { id: 'b', start: 4, end: 8 },
          { id: 'a', start: -2, end: 4 },
          { id: 'overlap', start: 7, end: 12 },
          { id: 'invalid', start: Number.NaN, end: 6 },
        ]),
      ),
    ).toEqual([])
  })

  it('does not mutate the EDL', () => {
    const input = edl(10, [
      { id: 'b', start: 7, end: 9 },
      { id: 'a', start: 1, end: 3 },
    ])
    const before = structuredClone(input)
    deriveRemovedSourceRanges(input)
    expect(input).toEqual(before)
  })
})

describe('buildImageOverlayRenderPlanForEdl', () => {
  it('projects source-authored overlays onto the kept output clock', () => {
    const plan = buildImageOverlayRenderPlanForEdl(
      edl(10, [
        { id: 'a', start: 0, end: 4 },
        { id: 'b', start: 6, end: 10 },
      ]),
      [
        {
          id: 'overlay',
          assetId: PNG.id,
          startSourceMs: 2_000,
          endSourceMs: 8_000,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          fit: 'contain',
          opacity: 1,
          zIndex: 0,
          fadeInMs: 250,
          fadeOutMs: 500,
        },
      ],
      [PNG],
    )

    expect(plan).toMatchObject([
      {
        sourceStartMs: 2_000,
        sourceEndMs: 4_000,
        outputStartMs: 2_000,
        outputEndMs: 4_000,
        fadeInMs: 250,
        fadeOutMs: 0,
      },
      {
        sourceStartMs: 6_000,
        sourceEndMs: 8_000,
        outputStartMs: 4_000,
        outputEndMs: 6_000,
        fadeInMs: 0,
        fadeOutMs: 500,
      },
    ])
  })
})

describe('Part K output-time continuity', () => {
  const firstPiece: OverlayRenderSegment = {
    ...SEGMENT,
    overlayId: 'cut-overlay',
    sourceStartMs: 10_000,
    sourceEndMs: 14_000,
    outputStartMs: 10_000,
    outputEndMs: 14_000,
    fadeInMs: 500,
    fadeOutMs: 0,
  }
  const finalPiece: OverlayRenderSegment = {
    ...SEGMENT,
    overlayId: 'cut-overlay',
    sourceStartMs: 16_000,
    sourceEndMs: 20_000,
    outputStartMs: 14_000,
    outputEndMs: 18_000,
    fadeInMs: 0,
    fadeOutMs: 750,
  }

  it('keeps the required source split while mapping both pieces adjacently', () => {
    const plan = buildImageOverlayRenderPlanForEdl(
      edl(25, [
        { id: 'before-cut', start: 0, end: 14 },
        { id: 'after-cut', start: 16, end: 25 },
      ]),
      [
        {
          id: 'cut-overlay',
          assetId: PNG.id,
          startSourceMs: 10_000,
          endSourceMs: 20_000,
          x: 0.1,
          y: 0.2,
          width: 0.4,
          height: 0.3,
          fit: 'contain',
          opacity: 0.8,
          zIndex: 2,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
      [PNG],
    )

    expect(plan).toMatchObject([
      {
        sourceStartMs: 10_000,
        sourceEndMs: 14_000,
        outputStartMs: 10_000,
        outputEndMs: 14_000,
      },
      {
        sourceStartMs: 16_000,
        sourceEndMs: 20_000,
        outputStartMs: 14_000,
        outputEndMs: 18_000,
      },
    ])
  })

  it('coalesces a visually continuous cut join and preserves only outer fades', () => {
    expect(
      coalesceContinuousOverlaySegments([finalPiece, firstPiece]),
    ).toEqual([
      {
        overlayId: 'cut-overlay',
        assetId: PNG.id,
        outputStartMs: 10_000,
        outputEndMs: 18_000,
        x: SEGMENT.x,
        y: SEGMENT.y,
        width: SEGMENT.width,
        height: SEGMENT.height,
        fit: SEGMENT.fit,
        opacity: SEGMENT.opacity,
        zIndex: SEGMENT.zIndex,
        fadeInMs: 500,
        fadeOutMs: 750,
      },
    ])
  })

  it('emits one uninterrupted FFmpeg enable window across the removed join', () => {
    const graph = buildImageOverlayFilterGraph(
      [firstPiece, finalPiece],
      [PNG],
      { frameWidth: 1280, frameHeight: 720 },
    )
    const filter = graph?.filterComplex ?? ''

    expect(filter.match(/overlay=x=/g)).toHaveLength(1)
    expect(filter).not.toContain('split=')
    expect(filter).toContain('fade=t=in:st=10:d=0.5:alpha=1')
    expect(filter).toContain('fade=t=out:st=17.25:d=0.75:alpha=1')
    expect(filter).toContain("enable='gte(t,10)*lt(t,18)'")
  })

  it('collapses multiple internal cut joins into one output interval', () => {
    const middlePiece: OverlayRenderSegment = {
      ...firstPiece,
      sourceStartMs: 16_000,
      sourceEndMs: 17_000,
      outputStartMs: 14_000,
      outputEndMs: 15_000,
      fadeInMs: 0,
    }
    const lastPiece: OverlayRenderSegment = {
      ...finalPiece,
      sourceStartMs: 18_000,
      outputStartMs: 15_000,
      outputEndMs: 17_000,
    }

    expect(
      coalesceContinuousOverlaySegments([
        lastPiece,
        firstPiece,
        middlePiece,
      ]),
    ).toMatchObject([
      {
        outputStartMs: 10_000,
        outputEndMs: 17_000,
        fadeInMs: 500,
        fadeOutMs: 750,
      },
    ])
  })

  it('does not bridge a real gap, a layer change, or an intentional join fade', () => {
    const cases: OverlayRenderSegment[][] = [
      [firstPiece, { ...finalPiece, outputStartMs: 14_001 }],
      [firstPiece, { ...finalPiece, assetId: WEBP.id }],
      [firstPiece, { ...finalPiece, opacity: 0.5 }],
      [firstPiece, { ...finalPiece, x: 0.2 }],
      [firstPiece, { ...finalPiece, fit: 'cover' }],
      [firstPiece, { ...finalPiece, zIndex: 3 }],
      [firstPiece, { ...finalPiece, overlayId: 'another-overlay' }],
      [{ ...firstPiece, fadeOutMs: 100 }, finalPiece],
      [firstPiece, { ...finalPiece, fadeInMs: 100 }],
      [
        firstPiece,
        {
          ...finalPiece,
          outputStartMs: firstPiece.outputEndMs - 0.000_000_5,
          outputEndMs: firstPiece.outputEndMs - 0.000_000_1,
        },
      ],
    ]

    for (const plan of cases) {
      expect(coalesceContinuousOverlaySegments(plan)).toHaveLength(2)
    }
  })

  it('absorbs projection round-off without mutating the split render plan', () => {
    const plan = [
      { ...finalPiece, outputStartMs: 14_000.000_000_5 },
      { ...firstPiece },
    ]
    const before = structuredClone(plan)

    expect(coalesceContinuousOverlaySegments(plan)).toHaveLength(1)
    expect(plan).toEqual(before)
  })
})

describe('buildImageOverlayFilterGraph', () => {
  it('returns the byte-preserving fast path before requiring frame dimensions', () => {
    expect(
      buildImageOverlayFilterGraph([], [], {
        frameWidth: Number.NaN,
        frameHeight: Number.NaN,
      }),
    ).toBeNull()
  })

  it('builds contain geometry, opacity, fades, and a half-open enable window', () => {
    const graph = buildImageOverlayFilterGraph([SEGMENT], [PNG], {
      frameWidth: 1280,
      frameHeight: 720,
    })

    expect(graph).not.toBeNull()
    expect(graph?.inputArgs).toEqual(['-loop', '1', '-i', 'overlay_0.png'])
    expect(graph?.stagedAssets).toMatchObject([
      {
        assetId: PNG.id,
        inputName: 'overlay_0.png',
        inputIndex: 1,
        src: PNG.src,
      },
    ])
    expect(graph?.filterComplex).toBe(
      '[ovbase]scale=1280:720,setsar=1[ovc0];' +
        '[1:v]format=rgba,' +
        'scale=512:216:force_original_aspect_ratio=decrease,' +
        'pad=512:216:(ow-iw)/2:(oh-ih)/2:color=0x00000000,' +
        'colorchannelmixer=aa=0.8,' +
        'fade=t=in:st=1:d=0.5:alpha=1,' +
        'fade=t=out:st=3.25:d=0.75:alpha=1[ovimg0];' +
        "[ovc0][ovimg0]overlay=x=128:y=144:shortest=1:alpha=straight:" +
        "enable='gte(t,1)*lt(t,4)'[ovout]",
    )
  })

  it('floors the output to even dimensions and supports cover/stretch fits', () => {
    const cover = { ...SEGMENT, overlayId: 'cover', assetId: WEBP.id, fit: 'cover' as const }
    const stretch = {
      ...SEGMENT,
      overlayId: 'stretch',
      fit: 'stretch' as const,
      zIndex: 3,
    }
    const graph = buildImageOverlayFilterGraph([stretch, cover], [PNG, WEBP], {
      frameWidth: 1921,
      frameHeight: 1081,
    })

    expect(graph).toMatchObject({ frameWidth: 1920, frameHeight: 1080 })
    expect(graph?.filterComplex).toContain(
      'scale=768:324:force_original_aspect_ratio=increase,' +
        'crop=768:324:(iw-ow)/2:(ih-oh)/2',
    )
    expect(graph?.filterComplex).toContain('[2:v]format=rgba,scale=768:324,')
    expect(graph?.filterComplex).toContain('overlay=x=192:y=216')
  })

  it('stages each asset once, splits reused inputs, and never emits user names', () => {
    const secondUse = {
      ...SEGMENT,
      overlayId: 'overlay-2',
      outputStartMs: 5_000,
      outputEndMs: 6_000,
      sourceStartMs: 5_000,
      sourceEndMs: 6_000,
      fadeInMs: 0,
      fadeOutMs: 0,
    }
    const graph = buildImageOverlayFilterGraph([secondUse, SEGMENT], [PNG], {
      frameWidth: 1280,
      frameHeight: 720,
    })

    expect(graph?.stagedAssets).toHaveLength(1)
    expect(graph?.inputArgs).toEqual(['-loop', '1', '-i', 'overlay_0.png'])
    expect(graph?.filterComplex).toContain(
      '[1:v]split=2[ovsrc0_0][ovsrc0_1]',
    )
    expect(graph?.filterComplex).not.toContain(PNG.name)
    expect(graph?.filterComplex).not.toContain(PNG.id)
  })

  it('matches the preview min-envelope when fade ranges overlap', () => {
    const graph = buildImageOverlayFilterGraph(
      [
        {
          ...SEGMENT,
          outputStartMs: 2_000,
          outputEndMs: 3_000,
          fadeInMs: 800,
          fadeOutMs: 800,
        },
      ],
      [PNG],
      { frameWidth: 1280, frameHeight: 720 },
    )

    expect(graph?.filterComplex).toContain(
      "fade=t=in:st=2:d=0.8:alpha=1:enable='lt(t,2.5)'," +
        "fade=t=out:st=2.2:d=0.8:alpha=1:enable='gte(t,2.5)'",
    )
  })

  it('composites lower z-index layers first with deterministic labels', () => {
    const low = { ...SEGMENT, overlayId: 'low', zIndex: 0 }
    const high = { ...SEGMENT, overlayId: 'high', assetId: WEBP.id, zIndex: 9 }
    const graph = buildImageOverlayFilterGraph([high, low], [PNG, WEBP], {
      frameWidth: 1280,
      frameHeight: 720,
    })

    const filter = graph?.filterComplex ?? ''
    expect(filter.indexOf('[1:v]format=rgba')).toBeLessThan(
      filter.indexOf('[2:v]format=rgba'),
    )
    expect(filter).toContain('[ovc0][ovimg0]overlay=')
    expect(filter).toContain('[ovc1][ovimg1]overlay=')
    expect(graph?.outputVideoLabel).toBe('ovout')
  })

  it('matches preview ID ordering for overlapping layers with equal z-index', () => {
    const earlyZ = {
      ...SEGMENT,
      overlayId: 'z-layer',
      assetId: PNG.id,
      outputStartMs: 0,
      outputEndMs: 4_000,
    }
    const laterA = {
      ...SEGMENT,
      overlayId: 'a-layer',
      assetId: WEBP.id,
      outputStartMs: 1_000,
      outputEndMs: 3_000,
    }
    const graph = buildImageOverlayFilterGraph([earlyZ, laterA], [PNG, WEBP], {
      frameWidth: 1280,
      frameHeight: 720,
    })

    expect(graph?.stagedAssets.map(({ assetId }) => assetId)).toEqual([
      WEBP.id,
      PNG.id,
    ])
    expect(graph?.filterComplex).toContain('[ovc0][ovimg0]overlay=')
    expect(graph?.filterComplex).toContain('[ovc1][ovimg1]overlay=')
  })

  it('rejects missing assets, unsupported MIME types, and unavailable dimensions', () => {
    expect(() =>
      buildImageOverlayFilterGraph([SEGMENT], [], {
        frameWidth: 1280,
        frameHeight: 720,
      }),
    ).toThrow(/missing/i)
    expect(() =>
      buildImageOverlayFilterGraph(
        [SEGMENT],
        [{ ...PNG, mimeType: 'image/gif' }],
        { frameWidth: 1280, frameHeight: 720 },
      ),
    ).toThrow(/unsupported MIME type/i)
    expect(() =>
      buildImageOverlayFilterGraph([SEGMENT], [PNG], {
        frameWidth: Number.NaN,
        frameHeight: 720,
      }),
    ).toThrow(/frame width is unavailable/i)
  })

  it('rejects source-input reuse and generated-label collisions', () => {
    expect(() =>
      buildImageOverlayFilterGraph([SEGMENT], [PNG], {
        frameWidth: 1280,
        frameHeight: 720,
        firstInputIndex: 0,
      }),
    ).toThrow(/positive safe integer/i)
    expect(() =>
      buildImageOverlayFilterGraph([SEGMENT], [PNG], {
        frameWidth: 1280,
        frameHeight: 720,
        firstInputIndex: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/positive safe integer/i)
    for (const inputVideoLabel of ['ovc0', 'ovimg12', 'ovsrc1_2', 'ovout']) {
      expect(() =>
        buildImageOverlayFilterGraph([SEGMENT], [PNG], {
          frameWidth: 1280,
          frameHeight: 720,
          inputVideoLabel,
        }),
      ).toThrow(/collides with generated labels/i)
    }
  })

  it('does not mutate plans, assets, or settings', () => {
    const plan = [{ ...SEGMENT }]
    const assets = [{ ...PNG }]
    const settings = { frameWidth: 1280, frameHeight: 720 }
    const before = structuredClone({ plan, assets, settings })
    buildImageOverlayFilterGraph(plan, assets, settings)
    expect({ plan, assets, settings }).toEqual(before)
  })
})
