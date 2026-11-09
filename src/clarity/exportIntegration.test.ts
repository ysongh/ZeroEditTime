// Exercise real pure export preparation with Clarity-derived edits. These
// assertions do not run FFmpeg, encode media, or assess audiovisual quality.
import { describe, expect, it } from 'vitest'
import { buildSrt, prepareCaptionsForExport } from '../captions/captions'
import { applyRemovedRange, createEdl, totalKeptDuration } from '../edl/edl'
import type { EDL } from '../edl/types'
import { buildAudioCleanupPlan } from '../export/audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS, type AudioCleanupSettings } from '../export/audioCleanupSettings'
import { buildExportArgs, STRONG_NOISE_REDUCTION, SPEECH_COMPRESSOR } from '../export/ffmpeg'
import { buildImageOverlayFilterGraph, buildImageOverlayRenderPlanForEdl } from '../export/imageOverlays'
import type { ImageOverlay, OverlayAsset } from '../overlays/types'
import type { Transcript } from '../transcript/types'
import { deriveClarityEdit, type ClarityCutProposal } from './edit'
import { captureClaritySnapshot } from './freshness'
import { createClarityDraft } from './review'

function fixture() {
  const edl = applyRemovedRange(applyRemovedRange(createEdl({
    id: 'source', url: 'blob:source', duration: 12, width: 1280, height: 720,
  }), 0, 1), 7, 8)
  edl.captions = [
    { id: 'setup', text: 'Edited setup.', start: 1, end: 2 },
    { id: 'repeated', text: 'Edited repeated example.', start: 3, end: 5 },
    { id: 'bridge', text: 'Edited text across the earlier cut.', start: 5.5, end: 8.5 },
    { id: 'conclusion', text: 'Edited conclusion.', start: 9, end: 10 },
  ]
  const transcript: Transcript = { words: [
    { text: 'Setup.', start: 1, end: 2 },
    { text: 'Repeated', start: 3, end: 4 },
    { text: 'example.', start: 4, end: 5 },
    { text: 'Aside.', start: 6, end: 7 },
    { text: 'Conclusion.', start: 9, end: 10 },
  ] }
  const draft = { ...createClarityDraft(), mustStay: 'Keep setup and conclusion.' }
  const proposal: ClarityCutProposal = {
    snapshot: captureClaritySnapshot(edl, transcript, draft),
    result: { suggestions: [
      { sentenceId: 'sentence:1:2', reason: 'repeated-explanation', explanation: 'Already explained.' },
      { sentenceId: 'sentence:3:3', reason: 'off-topic-detail', explanation: 'An optional aside.' },
    ] },
    selectedIds: ['sentence:1:2'],
  }
  const assets: OverlayAsset[] = ['persistent', 'removed'].map((id) => ({
    id, kind: 'image', name: `${id}.png`, mimeType: 'image/png',
    width: 200, height: 100, src: `blob:${id}`,
  }))
  const overlays: ImageOverlay[] = [
    {
      id: 'spanning', assetId: 'persistent', startSourceMs: 2000, endSourceMs: 10000,
      x: 0.1, y: 0.2, width: 0.3, height: 0.2, fit: 'contain', opacity: 0.8,
      zIndex: 1, fadeInMs: 200, fadeOutMs: 300,
    },
    {
      id: 'inside-removal', assetId: 'removed', startSourceMs: 3200, endSourceMs: 4800,
      x: 0, y: 0, width: 0.5, height: 0.5, fit: 'cover', opacity: 1,
      zIndex: 2, fadeInMs: 0, fadeOutMs: 0,
    },
  ]
  const audio: AudioCleanupSettings = {
    ...DEFAULT_AUDIO_CLEANUP_SETTINGS, noiseReduction: 'strong',
    loudnessTargetLufs: -18, truePeakLimitDb: -2,
  }
  return { edl, transcript, draft, proposal, assets, overlays, audio }
}

/** Same pure preparation boundaries used by ExportButton/runExport. */
function prepareExport(edl: EDL, data: ReturnType<typeof fixture>, burnCaptions = true) {
  const captions = prepareCaptionsForExport(edl.captions, edl)
  const renderPlan = buildImageOverlayRenderPlanForEdl(edl, data.overlays, data.assets)
  const imageOverlayGraph = buildImageOverlayFilterGraph(renderPlan, data.assets, {
    frameWidth: 1280, frameHeight: 720,
  })
  const audioCleanup = buildAudioCleanupPlan(data.audio)
  const args = buildExportArgs(edl.segments, 'source.mp4', 'export.mp4', {
    imageOverlayGraph, audioCleanup,
    ...(burnCaptions ? { srtFile: 'captions.srt' } : {}),
  })
  return {
    captions, srt: buildSrt(captions), renderPlan, imageOverlayGraph, audioCleanup,
    args, filter: args[args.indexOf('-filter_complex') + 1],
  }
}

describe('Clarity edits through export preparation', () => {
  it('keeps committed export preparation unchanged while deriving a temporary preview', () => {
    const data = fixture()
    const before = structuredClone(data)
    const committedExport = prepareExport(data.edl, data)
    const preview = deriveClarityEdit(data.edl, data.transcript, data.draft, data.proposal)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    expect(totalKeptDuration(preview.edl)).toBe(8)
    expect(totalKeptDuration(data.edl)).toBe(10)
    expect(prepareExport(data.edl, data)).toEqual(committedExport)
    expect(data).toEqual(before)
    // The committed export still includes the caption/image inside the proposed cut.
    expect(committedExport.captions).toContainEqual({ text: 'Edited repeated example.', start: 2, end: 4 })
    expect(committedExport.imageOverlayGraph?.stagedAssets.map((asset) => asset.assetId))
      .toEqual(['persistent', 'removed'])
    expect(committedExport.filter).toContain('[0:v]trim=start=1:end=7,')
    expect(committedExport.filter).not.toContain('[0:v]trim=start=1:end=3,')
  })

  it('projects applied cuts, current captions, overlays, and audio onto the same shortened clock', () => {
    const data = fixture()
    // Simulate hand-edited text after analysis; Apply must carry this text forward.
    const latest: EDL = { ...data.edl, captions: data.edl.captions.map((caption) =>
      caption.id === 'conclusion' ? { ...caption, text: 'Latest conclusion: keep this caveat.' } : caption,
    ) }
    const before = structuredClone({ latest, assets: data.assets, overlays: data.overlays, audio: data.audio })
    const applied = deriveClarityEdit(latest, data.transcript, data.draft, data.proposal)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const output = prepareExport(applied.edl, data)

    expect(applied.edl.captions).toBe(latest.captions)
    expect(output.captions).toEqual([
      { text: 'Edited setup.', start: 0, end: 1 },
      { text: 'Edited text across the earlier cut.', start: 2.5, end: 4.5 },
      { text: 'Latest conclusion: keep this caveat.', start: 5, end: 6 },
    ])
    expect(output.srt).toContain('00:00:02,500 --> 00:00:04,500\nEdited text across the earlier cut.')
    expect(output.srt).toContain('00:00:05,000 --> 00:00:06,000\nLatest conclusion: keep this caveat.')
    expect(output.srt).not.toContain('Edited repeated example.')
    expect(output.renderPlan).toMatchObject([
      { sourceStartMs: 2000, sourceEndMs: 3000, outputStartMs: 1000, outputEndMs: 2000, fadeInMs: 200, fadeOutMs: 0 },
      { sourceStartMs: 5000, sourceEndMs: 7000, outputStartMs: 2000, outputEndMs: 4000, fadeInMs: 0, fadeOutMs: 0 },
      { sourceStartMs: 8000, sourceEndMs: 10000, outputStartMs: 4000, outputEndMs: 6000, fadeInMs: 0, fadeOutMs: 300 },
    ])
    expect(output.imageOverlayGraph?.stagedAssets.map((asset) => asset.assetId)).toEqual(['persistent'])
    expect(output.filter).toContain("enable='gte(t,1)*lt(t,6)'")
    for (const [start, end] of [[1, 3], [5, 7], [8, 12]]) {
      expect(output.filter).toContain(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS`)
      expect(output.filter).toContain(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`)
    }
    expect(output.filter).toContain('concat=n=3:v=1:a=1[ovbase][ca]')
    expect(output.filter).toContain(STRONG_NOISE_REDUCTION)
    expect(output.filter).toContain(SPEECH_COMPRESSOR)
    expect(output.filter).toContain('loudnorm=I=-18:TP=-2')
    expect(output.filter).toContain('curve=qsin')
    expect(output.filter.indexOf('[ovbase]')).toBeLessThan(output.filter.indexOf('[ovout]subtitles='))
    expect(output.args.flatMap((arg, index) => arg === '-map' ? [output.args[index + 1]] : []))
      .toEqual(['[outv]', '[outa]'])
    expect({ latest, assets: data.assets, overlays: data.overlays, audio: data.audio }).toEqual(before)
  })

  it('reprojects a newly selected second cut once and respects captions being disabled for export', () => {
    const data = fixture()
    const applied = deriveClarityEdit(data.edl, data.transcript, data.draft, {
      ...data.proposal, selectedIds: ['sentence:1:2', 'sentence:3:3'],
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    const output = prepareExport(applied.edl, data, false)

    expect(totalKeptDuration(applied.edl)).toBe(7)
    expect(output.captions).toEqual([
      { text: 'Edited setup.', start: 0, end: 1 },
      { text: 'Edited text across the earlier cut.', start: 2.5, end: 3.5 },
      { text: 'Edited conclusion.', start: 4, end: 5 },
    ])
    // SRT download still uses the accepted output clock when burning is off.
    expect(output.srt).toContain('00:00:04,000 --> 00:00:05,000\nEdited conclusion.')
    expect(output.filter).toContain('[0:v]trim=start=5:end=6,')
    expect(output.filter).toContain('[0:a]atrim=start=5:end=6,')
    expect(output.filter).toContain("enable='gte(t,1)*lt(t,5)'")
    expect(output.filter).not.toContain('subtitles=')
    expect(output.audioCleanup).toEqual(buildAudioCleanupPlan(data.audio))
    expect(output.args.flatMap((arg, index) => arg === '-map' ? [output.args[index + 1]] : []))
      .toEqual(['[ovout]', '[outa]'])
  })
})
