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
import {
  buildAudioCleanupFilterGraph,
  buildAudioSegmentFilterChain,
} from './audioCleanupFilters'
import {
  canAttemptAudioFilter,
  getAudioFilterCapabilities,
  recordAudioFilterSupport,
} from './audioFilterCapabilities'
export {
  AUDIO_FADE_S,
  LEGACY_LOUDNORM as LOUDNORM,
  LEGACY_LOUDNORM_TRUE_PEAK_DB,
  LIGHT_NOISE_REDUCTION,
  LOUDNORM_LRA,
  OUTPUT_SAMPLE_RATE,
  SMOOTH_JOIN_FADE_CURVE,
  SPEECH_COMPRESSOR,
  STRONG_NOISE_REDUCTION,
} from './audioCleanupFilters'

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
  peakLimiter?: boolean
  /** Omit every audio input/filter/map/codec argument for a known video-only source. */
  includeAudio?: boolean
  srtFile?: string
  imageOverlayGraph?: ImageOverlayFilterGraph | null
  /**
   * Phase-10 cleanup intent. Part C establishes the compatibility seam only:
   * disabled/no-op plans leave the legacy argument array exactly unchanged.
   * Later parts translate enabled operations into supported filters.
   */
  audioCleanup?: AudioCleanupPlan
}

// Runtime failure classification and fallback orchestration remain here because
// they depend on the actual FFmpeg log stream. Per-instance capability state is
// isolated in audioFilterCapabilities.ts; pure syntax is in audioCleanupFilters.ts.
const NOISE_REDUCTION_UNAVAILABLE_NOTE =
  'Noise reduction is unavailable in this browser export engine — exported without it.'
const VOICE_LEVELING_UNAVAILABLE_NOTE =
  'Voice leveling is unavailable in this browser export engine — exported without it.'
const LOUDNESS_NORMALIZATION_UNAVAILABLE_NOTE =
  'Loudness normalization is unavailable in this browser export engine — exported without it.'
const PEAK_LIMITER_UNAVAILABLE_NOTE =
  'Peak limiting is unavailable in this browser export engine — exported without it.'
const NO_AUDIO_STREAM_NOTE =
  'The source has no audio track — exported video without audio.'
const SILENT_LOUDNESS_NORMALIZATION_NOTE =
  'Loudness normalization could not analyze silent audio — exported without it.'

const EXPORT_CANCELED_MESSAGE =
  'Export was canceled. No output file was created.'
const EXPORT_ENGINE_STOPPED_MESSAGE =
  'The export engine stopped before the export finished. Try the export again.'
const EXPORT_OUT_OF_MEMORY_MESSAGE =
  'The browser ran out of memory during export. Close other tabs or export a shorter, simpler edit and try again.'
const MALFORMED_SOURCE_MESSAGE =
  'The source media is malformed or uses a codec this exporter cannot decode. Try another file or re-encode the source.'
const UNSUPPORTED_CHANNEL_LAYOUT_MESSAGE =
  'The source audio uses a channel layout this exporter cannot process. Convert it to mono or stereo and try again.'
const AUDIO_MAPPING_FAILURE_MESSAGE =
  'Processed audio could not be connected to the exported MP4. The export was stopped to avoid missing or untreated audio.'
const GENERIC_EXPORT_FAILURE_MESSAGE =
  'The MP4 could not be encoded. Try again with a shorter or simpler edit.'

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
 * Audio processing follows one deliberate, timing-safe order (video is untouched):
 * - per-segment declick fades, appended AFTER asetpts so times are segment-local:
 *   `afade=t=in:st=0:d=F,afade=t=out:st=(dur-F):d=F` with F clamped to half the
 *   segment duration so a tiny sliver never gets a negative fade-out start.
 *   Phase-10 smooth-join intent adds the `qsin` curve to those same short fades;
 *   it never overlaps segments or changes concat timing;
 * - concat kept audio without overlap, preserving the EDL/keep-gap duration;
 * - run the combined stream through optional denoise, optional voice compression,
 *   optional loudnorm, the required 48 kHz resample, then the final peak limiter.
 *   Resampling precedes limiting because loudnorm internally outputs 192 kHz and
 *   the configured ceiling should be the final operation on the encoded rate.
 *   The graph never forces a channel count/layout, so FFmpeg preserves negotiated
 *   mono or stereo input layout. None of these filters changes timestamps;
 *   alimiter compensates its lookahead.
 *   A single-segment export chains the identical stages directly after its fades.
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
 * paths return the exact legacy argument array. Part P's `includeAudio: false`
 * is a narrow retry path for a source proven to have no audio stream: it emits
 * video-only trim/concat, overlay, caption, mapping, and codec arguments, with
 * no `[0:a]`, cleanup filters, `[outa]`, or AAC options.
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

  const includeAudio = options.includeAudio !== false
  const audioFilters = includeAudio
    ? buildAudioCleanupFilterGraph(options.audioCleanup, {
        loudnorm: options.loudnorm,
        peakLimiter: options.peakLimiter,
      })
    : null

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
    clauses.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${vLabel}]`)
    if (audioFilters !== null) {
      const audioChain = buildAudioSegmentFilterChain(
        { start, end },
        audioFilters.segmentFadeCurve,
      )
      clauses.push(
        n === 1
          ? `[0:a]${audioChain},${audioFilters.filterChain}[outa]`
          : `[0:a]${audioChain}[a${i}]`,
      )
    }
  }

  let filter = clauses.join(';')
  if (n > 1) {
    if (audioFilters === null) {
      const concatInputs = segments.map((_, i) => `[v${i}]`).join('')
      filter +=
        `;${concatInputs}concat=n=${n}:v=1:a=0` +
        `[${assembledVideoLabel}]`
    } else {
      const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('')
      filter +=
        `;${concatInputs}concat=n=${n}:v=1:a=1` +
        `[${assembledVideoLabel}][ca];[ca]${audioFilters.filterChain}[outa]`
    }
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
    '-map', `[${mappedVideoLabel}]`,
    ...(includeAudio ? ['-map', '[outa]'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    ...(includeAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
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
 * under generated VFS names and reused if a safe fallback encode is needed.
 * They are composited before the optional caption burn and are deleted in the
 * same best-effort cleanup as every other temporary export file.
 *
 * Precise runtime failures have conservative retry paths: a source whose audio
 * stream specifier matches no streams is re-encoded video-only, and loudnorm is
 * skipped for this export if its own failure contains a non-finite silence
 * measurement. Neither input-specific case poisons the per-core capability
 * cache. Missing optional filters retain their established warned fallbacks;
 * missing required audio primitives produce a clear fatal error. All other
 * failures are classified only after those precise branches and receive stable
 * user-facing messages with raw diagnostics retained as their cause. A missing
 * `subtitles` filter is fatal so requested captions are never silently discarded.
 */
export async function runExport(
  ffmpeg: FFmpeg,
  file: File,
  segments: ExportSegment[],
  captions: PreparedCaption[] = [],
  onNote?: (note: string) => void,
  imageOverlays?: ImageOverlayExportRequest,
  audioCleanup?: AudioCleanupPlan,
): Promise<Blob> {
  const inputName = `input.${inputExtension(file.name)}`
  const outputName = 'output.mp4'
  const burn = captions.length > 0
  let imageOverlayGraph: ImageOverlayFilterGraph | null
  try {
    imageOverlayGraph =
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
  } catch (error) {
    throw classifyStageFailure(
      error,
      'Could not prepare image overlays for export. Remove the affected image and try again.',
    )
  }

  // Accumulate ffmpeg's stderr so a failed exec can be classified. Only precise,
  // filter-specific failures trigger a fallback; unrelated encode errors remain
  // fatal and do not change the cached capability state.
  const logs: string[] = []
  const onLog = (event: { message: string }): void => {
    logs.push(event.message)
  }
  ffmpeg.on('log', onLog)

  const encode = async (
    withAudio: boolean,
    withLoudnorm: boolean,
    withNoiseReduction: boolean,
    withVoiceLeveling: boolean,
    withPeakLimiter: boolean,
  ) => {
    const effectiveAudioCleanup =
      audioCleanup === undefined ||
      (withNoiseReduction && withVoiceLeveling)
        ? audioCleanup
        : {
            ...audioCleanup,
            noiseReduction: {
              ...audioCleanup.noiseReduction,
              enabled: withNoiseReduction,
            },
            voiceLeveling: {
              ...audioCleanup.voiceLeveling,
              enabled: withVoiceLeveling,
            },
          }
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
              audioCleanup: effectiveAudioCleanup,
              peakLimiter: withPeakLimiter,
              includeAudio: withAudio,
            }
          : {
              loudnorm: withLoudnorm,
              imageOverlayGraph,
              audioCleanup: effectiveAudioCleanup,
              peakLimiter: withPeakLimiter,
              includeAudio: withAudio,
            },
      ),
    )
    if (exitCode !== 0) {
      throw new Error(`ffmpeg export exited with code ${exitCode}.`)
    }
  }

  try {
    let sourceData: Uint8Array
    try {
      sourceData = await fetchFile(file)
    } catch (error) {
      throw classifyStageFailure(
        error,
        'Could not read the source file for export. Re-select the file and try again.',
      )
    }
    try {
      await ffmpeg.writeFile(inputName, sourceData)
    } catch (error) {
      throw classifyStageFailure(
        error,
        'The browser could not write temporary export files. Free browser memory and try again.',
      )
    }

    for (const staged of imageOverlayGraph?.stagedAssets ?? []) {
      let imageData: Uint8Array
      try {
        imageData = await fetchFile(staged.src)
      } catch (error) {
        throw classifyStageFailure(
          error,
          `Could not read image "${staged.name}" for export. Re-add the image and try again.`,
        )
      }
      try {
        await ffmpeg.writeFile(staged.inputName, imageData)
      } catch (error) {
        throw classifyStageFailure(
          error,
          'The browser could not write temporary image files for export. Free browser memory and try again.',
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
      let fontData: Uint8Array
      try {
        fontData = await fetchFile(FONT_URL)
      } catch (error) {
        throw classifyStageFailure(
          error,
          'Could not load the caption font for export. Turn off Burn captions into video and try again.',
        )
      }
      try {
        await ffmpeg.writeFile(FONT_VFS_PATH, fontData)
        await ffmpeg.writeFile(
          SRT_NAME,
          new TextEncoder().encode(buildSrt(captions)),
        )
      } catch (error) {
        throw classifyStageFailure(
          error,
          'The browser could not write temporary caption files. Turn off Burn captions into video or free browser memory and try again.',
        )
      }
    }

    const capabilities = getAudioFilterCapabilities(ffmpeg)
    const noiseRequested =
      audioCleanup?.enabled === true &&
      audioCleanup.noiseReduction.enabled
    let withNoiseReduction =
      noiseRequested && canAttemptAudioFilter(capabilities, 'afftdn')
    const voiceLevelingRequested =
      audioCleanup?.enabled === true && audioCleanup.voiceLeveling.enabled
    let withVoiceLeveling =
      voiceLevelingRequested &&
      canAttemptAudioFilter(capabilities, 'acompressor')
    const loudnormRequested =
      audioCleanup?.enabled === true
        ? audioCleanup.loudness.enabled
        : true
    let withLoudnorm =
      loudnormRequested && canAttemptAudioFilter(capabilities, 'loudnorm')
    const peakLimiterRequested = audioCleanup?.enabled === true
    let withPeakLimiter =
      peakLimiterRequested && canAttemptAudioFilter(capabilities, 'alimiter')
    const fallbackNotes: string[] = []
    let withAudio = true

    if (noiseRequested && !withNoiseReduction) {
      fallbackNotes.push(NOISE_REDUCTION_UNAVAILABLE_NOTE)
    }
    if (voiceLevelingRequested && !withVoiceLeveling) {
      fallbackNotes.push(VOICE_LEVELING_UNAVAILABLE_NOTE)
    }
    if (loudnormRequested && !withLoudnorm) {
      fallbackNotes.push(LOUDNESS_NORMALIZATION_UNAVAILABLE_NOTE)
    }
    if (peakLimiterRequested && !withPeakLimiter) {
      fallbackNotes.push(PEAK_LIMITER_UNAVAILABLE_NOTE)
    }

    let encoded = false
    while (!encoded) {
      logs.length = 0
      try {
        await encode(
          withAudio,
          withLoudnorm,
          withNoiseReduction,
          withVoiceLeveling,
          withPeakLimiter,
        )
        if (withAudio && withNoiseReduction) {
          recordAudioFilterSupport(ffmpeg, 'afftdn', true)
        }
        if (withAudio && withVoiceLeveling) {
          recordAudioFilterSupport(ffmpeg, 'acompressor', true)
        }
        if (withAudio && withLoudnorm) {
          recordAudioFilterSupport(ffmpeg, 'loudnorm', true)
        }
        if (withAudio && withPeakLimiter) {
          recordAudioFilterSupport(ffmpeg, 'alimiter', true)
        }
        encoded = true
      } catch (err) {
        const log = logs.join('\n')
        const earlyFailure = classifyEarlyExportFailure(log, err)
        if (earlyFailure !== null) {
          throw earlyFailure
        }
        if (isMissingSubtitles(log)) {
          throw makeUserFacingError(
            'This export engine cannot burn captions. Turn off Burn captions into video and try again.',
            err,
            log,
          )
        }
        if (withAudio && isMissingSourceAudioStream(log)) {
          await safeDelete(ffmpeg, outputName)
          withAudio = false
          withNoiseReduction = false
          withVoiceLeveling = false
          withLoudnorm = false
          withPeakLimiter = false
          fallbackNotes.length = 0
          fallbackNotes.push(NO_AUDIO_STREAM_NOTE)
          continue
        }
        if (isMissingRequiredAudioProcessing(log)) {
          throw makeUserFacingError(
            'This export engine is missing required audio processing, so the export was stopped to preserve audio safely.',
            err,
            log,
          )
        }
        if (withNoiseReduction && isMissingAfftdn(log)) {
          await safeDelete(ffmpeg, outputName)
          recordAudioFilterSupport(ffmpeg, 'afftdn', false)
          withNoiseReduction = false
          fallbackNotes.push(NOISE_REDUCTION_UNAVAILABLE_NOTE)
          continue
        }
        if (withVoiceLeveling && isMissingAcompressor(log)) {
          await safeDelete(ffmpeg, outputName)
          recordAudioFilterSupport(ffmpeg, 'acompressor', false)
          withVoiceLeveling = false
          fallbackNotes.push(VOICE_LEVELING_UNAVAILABLE_NOTE)
          continue
        }
        if (withPeakLimiter && isUnavailableAlimiter(log)) {
          await safeDelete(ffmpeg, outputName)
          recordAudioFilterSupport(ffmpeg, 'alimiter', false)
          withPeakLimiter = false
          fallbackNotes.push(PEAK_LIMITER_UNAVAILABLE_NOTE)
          continue
        }
        if (withLoudnorm && isMissingLoudnorm(log)) {
          await safeDelete(ffmpeg, outputName)
          recordAudioFilterSupport(ffmpeg, 'loudnorm', false)
          withLoudnorm = false
          fallbackNotes.push(LOUDNESS_NORMALIZATION_UNAVAILABLE_NOTE)
          continue
        }
        if (withLoudnorm && isSilenceRelatedLoudnormFailure(log)) {
          // A runtime analysis failure may have left a partial MP4 behind. The
          // retry reuses the fixed VFS output name, so clear it first.
          await safeDelete(ffmpeg, outputName)
          withLoudnorm = false
          fallbackNotes.push(SILENT_LOUDNESS_NORMALIZATION_NOTE)
          continue
        }
        throw classifyFinalExportFailure(
          log,
          err,
          audioCleanup?.enabled === true,
        )
      }
    }

    let blob: Blob
    try {
      const data = await ffmpeg.readFile(outputName)
      // A binary read is always Uint8Array. Narrow it to an ArrayBuffer-backed
      // view so it is a valid BlobPart under strict DOM typings.
      const bytes: BlobPart =
        typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)
      blob = new Blob([bytes], { type: 'video/mp4' })
    } catch (error) {
      throw classifyStageFailure(
        error,
        'The export finished, but the browser could not read the generated MP4. Free browser memory and try again.',
      )
    }

    // Notes describe an actual degraded success, so emit them only after the
    // final output was read successfully and is ready to return.
    if (fallbackNotes.length > 0) {
      onNote?.(fallbackNotes.join(' '))
    }
    return blob
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

function isMissingFilter(log: string, filterName: string): boolean {
  return log.split('\n').some((line) => {
    const match = /no such filter:\s*['"]?([a-z0-9_]+)['"]?(?=\s|$|[.,;:])/i.exec(
      line,
    )
    return match?.[1]?.toLowerCase() === filterName
  })
}

function lineMentionsExactFilter(line: string, filterName: string): boolean {
  const normalizedName = filterName.toLowerCase()
  const parsedPrefix = `parsed_${normalizedName}_`
  const identifiers = line.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  return identifiers.some((identifier) => {
    if (identifier === normalizedName) {
      return true
    }
    if (!identifier.startsWith(parsedPrefix)) {
      return false
    }
    return /^\d+$/.test(identifier.slice(parsedPrefix.length))
  })
}

function isMissingLoudnorm(log: string): boolean {
  return isMissingFilter(log, 'loudnorm')
}

function isMissingSourceAudioStream(log: string): boolean {
  return log.split('\n').some(
    (line) =>
      /stream specifier\s+['"]?(?:0)?:a(?::\d+)?['"]?(?=\s|$)/i.test(
        line,
      ) && /matches no streams/i.test(line),
  )
}

function isMissingRequiredAudioProcessing(log: string): boolean {
  return ['atrim', 'asetpts', 'afade', 'aresample'].some((filterName) =>
    isMissingFilter(log, filterName),
  )
}

function isSilenceRelatedLoudnormFailure(log: string): boolean {
  const lines = log.split('\n')
  const hasLoudnorm = (line: string): boolean =>
    lineMentionsExactFilter(line, 'loudnorm')
  const hasNonFiniteValue = (line: string): boolean =>
    /(?:^|[^a-z])(?:nan|[-+]?inf(?:inity)?)(?:$|[^a-z])/i.test(line)
  const hasFailure = (line: string): boolean =>
    /(?:error|invalid|failed|out of range|numerical)/i.test(line)
  const hasLoudnessMeasurement = (line: string): boolean =>
    /(?:input|measured)_(?:i|tp|lra|thresh)|target_offset/i.test(line)

  return lines.some((line, index) => {
    if (
      hasLoudnorm(line) &&
      hasLoudnessMeasurement(line) &&
      hasNonFiniteValue(line) &&
      hasFailure(line)
    ) {
      return true
    }

    // Some builds split `Value -inf for measured_I` from `Error applying ...
    // to loudnorm`. Require the measurement half and the failure half to each
    // be loudnorm-specific so an adjacent malformed-input error is never hidden.
    const adjacent = [lines[index - 1], lines[index + 1]].filter(
      (candidate): candidate is string => candidate !== undefined,
    )
    return (
      hasLoudnessMeasurement(line) &&
      hasNonFiniteValue(line) &&
      adjacent.some((candidate) =>
        hasLoudnorm(candidate) && hasFailure(candidate),
      )
    )
  })
}

function isMissingAfftdn(log: string): boolean {
  return isMissingFilter(log, 'afftdn')
}

function isMissingAcompressor(log: string): boolean {
  return isMissingFilter(log, 'acompressor')
}

function isUnavailableAlimiter(log: string): boolean {
  return (
    isMissingFilter(log, 'alimiter') ||
    log.split('\n').some(
      (line) =>
        lineMentionsExactFilter(line, 'alimiter') &&
        /\b(?:latency|level)\b/i.test(line) &&
        (/error applying option/i.test(line) ||
          (/\boption\b/i.test(line) &&
            /\b(?:not found|invalid|unsupported|unknown)\b/i.test(line))),
    )
  )
}

function isMissingSubtitles(log: string): boolean {
  return isMissingFilter(log, 'subtitles')
}

function errorDiagnostic(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown; message?: unknown }
    const name = typeof candidate.name === 'string' ? candidate.name : ''
    const message =
      typeof candidate.message === 'string' ? candidate.message : ''
    return `${name}: ${message}`
  }
  return String(error)
}

function makeUserFacingError(
  message: string,
  cause: unknown,
  log = '',
): Error {
  const diagnostic = log.trim().slice(-8_000)
  const preservedCause =
    diagnostic === ''
      ? cause
      : new Error(`FFmpeg diagnostics:\n${diagnostic}`, { cause })
  return new Error(message, { cause: preservedCause })
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  return (error as { name?: unknown }).name === 'AbortError'
}

function isEngineTerminated(error: unknown): boolean {
  return /called FFmpeg\.terminate\(\)/i.test(errorDiagnostic(error))
}

function isOutOfMemoryFailure(log: string, error: unknown): boolean {
  const diagnostic = `${log}\n${errorDiagnostic(error)}`
  return (
    /\b(?:out of memory|cannot allocate memory|could not allocate memory|failed to allocate memory|std::bad_alloc|bad_alloc|oom)\b/i.test(
      diagnostic,
    ) ||
    /cannot enlarge memory arrays|webassembly\.memory\.grow\(\).*maximum memory size exceeded|array buffer allocation failed/i.test(
      diagnostic,
    )
  )
}

function isUnsupportedChannelLayout(log: string): boolean {
  return log.split('\n').some(
    (line) =>
      /\bchannel[_ ]layout\b/i.test(line) &&
      /\b(?:unsupported|invalid|unknown|cannot|could not|not supported)\b/i.test(
        line,
      ),
  )
}

function isMalformedSourceMedia(log: string): boolean {
  return log.split('\n').some((line) =>
    /(?:invalid data found when processing input|error while decoding stream|could not find codec parameters|moov atom not found|corrupt(?:ed)? (?:input|frame|packet))/i.test(
      line,
    ),
  )
}

function isLoudnessProcessingFailure(log: string): boolean {
  return log.split('\n').some(
    (line) =>
      lineMentionsExactFilter(line, 'loudnorm') &&
      /\b(?:error|failed|invalid|out of range|numerical)\b/i.test(line),
  )
}

function isAudioMappingFailure(log: string): boolean {
  return log.split('\n').some((line) =>
    /(?:output with label ['"]?outa['"]? does not exist|failed to set value ['"]?\[outa\]['"]? for option ['"]?map|invalid output link label:\s*['"]?outa['"]?|stream map.*\[outa\].*matches no streams)/i.test(
      line,
    ),
  )
}

function isAudioCleanupProcessingFailure(log: string): boolean {
  return log.split('\n').some(
    (line) =>
      (['afftdn', 'acompressor', 'alimiter'].some((filterName) =>
        lineMentionsExactFilter(line, filterName),
      ) ||
        (lineMentionsExactFilter(line, 'afade') && /\bqsin\b/i.test(line))) &&
      /\b(?:error|failed|invalid|cannot|could not)\b/i.test(line),
  )
}

function classifyEarlyExportFailure(
  log: string,
  error: unknown,
): Error | null {
  if (isAbortError(error)) {
    return makeUserFacingError(EXPORT_CANCELED_MESSAGE, error, log)
  }
  if (isEngineTerminated(error)) {
    return makeUserFacingError(EXPORT_ENGINE_STOPPED_MESSAGE, error, log)
  }
  if (isOutOfMemoryFailure(log, error)) {
    return makeUserFacingError(EXPORT_OUT_OF_MEMORY_MESSAGE, error, log)
  }
  return null
}

function classifyFinalExportFailure(
  log: string,
  error: unknown,
  cleanupEnabled: boolean,
): Error {
  const early = classifyEarlyExportFailure(log, error)
  if (early !== null) {
    return early
  }
  if (isUnsupportedChannelLayout(log)) {
    return makeUserFacingError(
      UNSUPPORTED_CHANNEL_LAYOUT_MESSAGE,
      error,
      log,
    )
  }
  if (isMalformedSourceMedia(log)) {
    return makeUserFacingError(MALFORMED_SOURCE_MESSAGE, error, log)
  }
  if (isLoudnessProcessingFailure(log)) {
    const message = cleanupEnabled
      ? 'Audio cleanup failed during loudness normalization. The export was stopped. Try another source file or re-encode the source audio.'
      : 'Export audio processing failed during loudness normalization. Try another source file or re-encode the source audio.'
    return makeUserFacingError(message, error, log)
  }
  if (isAudioMappingFailure(log)) {
    return makeUserFacingError(AUDIO_MAPPING_FAILURE_MESSAGE, error, log)
  }
  if (cleanupEnabled && isAudioCleanupProcessingFailure(log)) {
    return makeUserFacingError(
      'Audio cleanup failed while processing this source. The export was stopped; turn off Improve voice audio or try another source file.',
      error,
      log,
    )
  }
  return makeUserFacingError(GENERIC_EXPORT_FAILURE_MESSAGE, error, log)
}

function classifyStageFailure(error: unknown, message: string): Error {
  return classifyEarlyExportFailure('', error) ?? makeUserFacingError(message, error)
}

async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // The file may not exist (the exec failed); freeing the VFS is best-effort.
  }
}
