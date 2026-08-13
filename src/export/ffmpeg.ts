// Phase 5 export: turn the EDL into a downloadable MP4 entirely in the browser
// with ffmpeg.wasm. This is FULLY client-side — it runs on the source file the
// browser already holds plus the current EDL, makes NO network calls, and needs
// no cross-origin isolation (we load the single-threaded core).
//
// The testable core is `buildExportArgs`: a PURE function (no ffmpeg, no React,
// no DOM) that maps the kept segments to the exact ffmpeg exec arguments. The
// running mechanics (`runExport`) live alongside it and use the shared engine
// instance/loader from `../ffmpeg/engine`; VFS lifecycle and retries are covered
// with a mocked engine while browser encoding remains an end-to-end check.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { inputExtension } from '../ffmpeg/engine'
import { buildSrt, type PreparedCaption } from '../captions/captions'
import type { OverlayRenderSegment } from '../overlays/renderPlan'
import type { OverlayAsset } from '../overlays/types'
import {
  buildImageOverlayFilterGraph,
  type ImageOverlayFilterGraph,
} from './imageOverlays'
import type { AudioCleanupPlan } from './audioCleanupPlan'

/** A kept source range, in seconds. Structurally a subset of `Segment`. */
export type ExportSegment = { start: number; end: number }

/** Browser-side image data needed to add an already-projected overlay plan. */
export interface ImageOverlayExportRequest {
  renderPlan: readonly OverlayRenderSegment[]
  assets: readonly OverlayAsset[]
  frameWidth: number
  frameHeight: number
}

export interface BuildExportOptions {
  loudnorm?: boolean
  srtFile?: string
  imageOverlayGraph?: ImageOverlayFilterGraph | null
  /**
   * Phase-10 cleanup intent. Part C establishes the compatibility seam only:
   * disabled/no-op plans leave the legacy argument array exactly unchanged.
   * Later parts translate enabled operations into supported filters.
   */
  audioCleanup?: AudioCleanupPlan
}

// Phase-5.5 audio polish. A cut lands mid-waveform, so each segment gets a
// ~15 ms fade at both edges — long enough to kill the click, far too short to
// hear as a fade. Audio ONLY: the hard video cut is correct (a video fade at
// every join reads as a slideshow).
export const AUDIO_FADE_S = 0.015
// One-pass loudness normalization (EBU R128) mastering the whole mix, so levels
// are consistent across joins and across exports.
export const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
// loudnorm internally upsamples its output (192 kHz), which bloats the AAC
// encode and chokes some players — pin the rate back in-graph right after it.
export const OUTPUT_SAMPLE_RATE = 48000

// Phase-6 caption burn. libass renders the SRT via the `subtitles` filter,
// styled entirely through force_style (ASS colors are &HAABBGGRR): white bold
// text with a black outline (BorderStyle=1 + Outline, no box, no shadow),
// bottom-center (Alignment=2) with a 36 px bottom margin.
export const SUBTITLE_STYLE =
  'FontName=Roboto,Bold=1,FontSize=22,PrimaryColour=&H00FFFFFF,' +
  'OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=36'
// ffmpeg.wasm's VFS ships NO fonts — the subtitles filter renders blank (or
// errors) without one, so the burn points libass at a VFS dir we populate with
// the committed Roboto-Bold.ttf.
export const FONTS_DIR = '/fonts'

/**
 * Build the full ffmpeg exec argument array for trimming each kept segment off
 * decoded frames and concatenating them into one re-encoded MP4. PURE: given the
 * kept segments it returns the args and touches nothing else.
 *
 * We re-encode (never `-c copy`): stream copy can only cut on keyframes and would
 * destroy the EDL's exact boundaries. For each segment we `trim`/`atrim` to the
 * float second bounds and reset PTS (`setpts`/`asetpts=PTS-STARTPTS`) so audio and
 * video stay in sync across the joins, then `concat` the labelled streams.
 *
 * Audio gets two extra polish steps (video is untouched):
 * - per-segment declick fades, appended AFTER asetpts so times are segment-local:
 *   `afade=t=in:st=0:d=F,afade=t=out:st=(dur-F):d=F` with F clamped to half the
 *   segment duration so a tiny sliver never gets a negative fade-out start;
 * - a mastering tail on the combined stream: concat emits an intermediate `[ca]`
 *   which runs `loudnorm,aresample=48000` into `[outa]` (single-segment exports
 *   chain the same tail directly). `options.loudnorm: false` drops loudnorm but
 *   keeps the fades and resample — the runtime fallback for a core without it.
 *
 * When `options.srtFile` is set (Phase 6), the assembled video runs one extra
 * `subtitles` stage burning that SRT with the committed Roboto Bold: concat
 * emits an intermediate `[cv]` (the single-segment path labels its trim `[cv]`)
 * and `[cv]subtitles=…[outv]` is appended as one more clause. The audio side is
 * untouched, and with no `srtFile` the graph is byte-identical to Phase 5.5.
 *
 * When `options.imageOverlayGraph` is set (Phase 9A Part J), kept video is
 * assembled into the graph's requested input label, image inputs and clauses
 * are appended, and captions consume the composited result. Audio clauses are
 * unchanged. With no graph, the full argument array remains byte-identical to
 * the pre-overlay path.
 *
 * Phase-10 Part C accepts an optional cleanup plan but deliberately adds no
 * filters for a disabled plan (or one with every operation disabled). Those
 * paths return the exact legacy argument array; later parts add enabled filter
 * translation without making the disabled path pay for structural no-ops.
 *
 * `-filter_complex` is ONE single argument string. Float seconds are passed
 * straight through (e.g. 2.983) to preserve frame accuracy. For a single segment
 * we skip concat and label video for its next stage (`[outv]`, captions, or
 * overlays) while audio lands directly at `[outa]`.
 */
export function buildExportArgs(
  segments: ExportSegment[],
  inputName = 'input.mp4',
  outputName = 'output.mp4',
  options: BuildExportOptions = {},
): string[] {
  if (segments.length === 0) {
    throw new Error('Cannot export: the EDL has no kept segments.')
  }

  const master =
    (options.loudnorm ?? true)
      ? `${LOUDNORM},aresample=${OUTPUT_SAMPLE_RATE}`
      : `aresample=${OUTPUT_SAMPLE_RATE}`

  const burn =
    options.srtFile !== undefined
      ? `subtitles=${options.srtFile}:fontsdir=${FONTS_DIR}:force_style='${SUBTITLE_STYLE}'`
      : null
  const overlayGraph = options.imageOverlayGraph ?? null
  // Where assembled kept video lands. Overlays consume [ovbase] (or another
  // generated label); otherwise captions consume [cv], or video finishes at
  // [outv] exactly as it did before Part J.
  const assembledVideoLabel =
    overlayGraph?.inputVideoLabel ?? (burn === null ? 'outv' : 'cv')
  const captionInputLabel =
    overlayGraph?.outputVideoLabel ?? assembledVideoLabel
  const mappedVideoLabel = burn === null ? captionInputLabel : 'outv'

  const n = segments.length
  const clauses: string[] = []
  for (let i = 0; i < n; i++) {
    const { start, end } = segments[i]
    // n === 1: label directly as the assembled output so no concat is needed.
    const vLabel = n === 1 ? assembledVideoLabel : `v${i}`
    const segDur = end - start
    const fade = Math.min(AUDIO_FADE_S, segDur / 2)
    const audioChain =
      `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${fade},afade=t=out:st=${segDur - fade}:d=${fade}`
    clauses.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${vLabel}]`)
    clauses.push(
      n === 1 ? `[0:a]${audioChain},${master}[outa]` : `[0:a]${audioChain}[a${i}]`,
    )
  }

  let filter = clauses.join(';')
  if (n > 1) {
    const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('')
    filter +=
      `;${concatInputs}concat=n=${n}:v=1:a=1` +
      `[${assembledVideoLabel}][ca];[ca]${master}[outa]`
  }
  if (overlayGraph !== null) {
    filter += `;${overlayGraph.filterComplex}`
  }
  if (burn !== null) {
    filter += `;[${captionInputLabel}]${burn}[outv]`
  }

  return [
    '-i', inputName,
    ...(overlayGraph?.inputArgs ?? []),
    '-filter_complex', filter,
    '-map', `[${mappedVideoLabel}]`, '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    outputName,
  ]
}

// The committed font asset (public/fonts/, served same-origin — no CDN or
// network dependency during an export) and its in-VFS destination.
const FONT_URL = '/fonts/Roboto-Bold.ttf'
const FONT_VFS_PATH = `${FONTS_DIR}/Roboto-Bold.ttf`
const SRT_NAME = 'captions.srt'

/**
 * Write the source into the VFS, run the one trim+concat exec, read the result
 * back as an MP4 Blob, then delete the staged files to free the (~2 GB-capped)
 * VFS. The caller attaches `ffmpeg.on('progress', …)` for the encode progress bar.
 *
 * `captions` are PREPARED captions (output time, already clipped against the
 * current EDL — see `prepareCaptionsForExport`). When non-empty, the font and
 * the built SRT are staged into the VFS and the exec burns them; when empty the
 * burn is skipped entirely and the graph is byte-identical to Phase 5.5.
 * `imageOverlays`, when supplied with a non-empty render plan, are staged once
 * under generated VFS names and reused if loudnorm needs a fallback encode.
 * They are composited before the optional caption burn and are deleted in the
 * same best-effort cleanup as every other temporary export file.
 *
 * If the exec fails specifically because the core lacks the loudnorm filter
 * (unlikely — it's native libavfilter), the encode retries WITHOUT loudnorm
 * (fades + aresample stay) and `onNote` receives a UI-visible explanation. Any
 * other failure is rethrown; we never substitute a different normalizer. A
 * missing `subtitles` filter is NOT retried around — the default core includes
 * libass, so that failure is surfaced as a clear error instead of silently
 * exporting without the captions the user asked for.
 */
export async function runExport(
  ffmpeg: FFmpeg,
  file: File,
  segments: ExportSegment[],
  captions: PreparedCaption[] = [],
  onNote?: (note: string) => void,
  imageOverlays?: ImageOverlayExportRequest,
): Promise<Blob> {
  const inputName = `input.${inputExtension(file.name)}`
  const outputName = 'output.mp4'
  const burn = captions.length > 0
  const imageOverlayGraph =
    imageOverlays === undefined
      ? null
      : buildImageOverlayFilterGraph(
          imageOverlays.renderPlan,
          imageOverlays.assets,
          {
            frameWidth: imageOverlays.frameWidth,
            frameHeight: imageOverlays.frameHeight,
          },
        )

  // Accumulate ffmpeg's stderr so a failed exec can be classified: only a
  // missing-loudnorm failure triggers the fallback re-encode.
  const logs: string[] = []
  const onLog = (event: { message: string }): void => {
    logs.push(event.message)
  }
  ffmpeg.on('log', onLog)

  const encode = async (withLoudnorm: boolean) => {
    const exitCode = await ffmpeg.exec(
      buildExportArgs(
        segments,
        inputName,
        outputName,
        burn
          ? {
              loudnorm: withLoudnorm,
              srtFile: SRT_NAME,
              imageOverlayGraph,
            }
          : { loudnorm: withLoudnorm, imageOverlayGraph },
      ),
    )
    if (exitCode !== 0) {
      throw new Error(`ffmpeg export exited with code ${exitCode}.`)
    }
    return ffmpeg.readFile(outputName)
  }

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    for (const staged of imageOverlayGraph?.stagedAssets ?? []) {
      try {
        await ffmpeg.writeFile(staged.inputName, await fetchFile(staged.src))
      } catch (error) {
        throw new Error(
          `Could not stage image "${staged.name}" for export.`,
          { cause: error },
        )
      }
    }

    if (burn) {
      // Stage the burn inputs: the font libass renders with (the VFS has no
      // fonts of its own) and the SRT built from the prepared captions.
      try {
        await ffmpeg.createDir(FONTS_DIR)
      } catch {
        // The dir survives from an earlier export this session — fine.
      }
      await ffmpeg.writeFile(FONT_VFS_PATH, await fetchFile(FONT_URL))
      await ffmpeg.writeFile(SRT_NAME, new TextEncoder().encode(buildSrt(captions)))
    }

    let data: Awaited<ReturnType<FFmpeg['readFile']>>
    try {
      data = await encode(true)
    } catch (err) {
      const log = logs.join('\n')
      if (isMissingSubtitles(log)) {
        throw new Error(
          'This ffmpeg core has no subtitles filter — captions cannot be burned. ' +
            'Undo the captions to export without them.',
          { cause: err },
        )
      }
      if (!isMissingLoudnorm(log)) {
        throw err
      }
      logs.length = 0
      data = await encode(false)
      onNote?.(
        'This ffmpeg core has no loudnorm filter — exported without loudness normalization.',
      )
    }

    // readFile returns FileData (Uint8Array | string); a binary read is always a
    // Uint8Array. Narrow it to an ArrayBuffer-backed view so it's a valid BlobPart.
    const bytes: BlobPart =
      typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)
    return new Blob([bytes], { type: 'video/mp4' })
  } finally {
    ffmpeg.off('log', onLog)
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, outputName)
    if (burn) {
      await safeDelete(ffmpeg, SRT_NAME)
      await safeDelete(ffmpeg, FONT_VFS_PATH)
    }
    for (const staged of imageOverlayGraph?.stagedAssets ?? []) {
      await safeDelete(ffmpeg, staged.inputName)
    }
  }
}

function isMissingLoudnorm(log: string): boolean {
  return /no such filter:\s*'?loudnorm'?/i.test(log)
}

function isMissingSubtitles(log: string): boolean {
  return /no such filter:\s*'?subtitles'?/i.test(log)
}

async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // The file may not exist (the exec failed); freeing the VFS is best-effort.
  }
}
