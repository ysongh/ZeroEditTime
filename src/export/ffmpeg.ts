// Phase 5 export: turn the EDL into a downloadable MP4 entirely in the browser
// with ffmpeg.wasm. This is FULLY client-side — it runs on the source file the
// browser already holds plus the current EDL, makes NO network calls, and needs
// no cross-origin isolation (we load the single-threaded core).
//
// The testable core is `buildExportArgs`: a PURE function (no ffmpeg, no React,
// no DOM) that maps the kept segments to the exact ffmpeg exec arguments. The
// loading/running mechanics live alongside it but are exercised only manually.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

/** A kept source range, in seconds. Structurally a subset of `Segment`. */
export type ExportSegment = { start: number; end: number }

// The @ffmpeg/core CDN version must stay compatible with the installed
// @ffmpeg/ffmpeg. If load() hangs or exec() throws "memory access out of
// bounds", that's a version mismatch — align this to @ffmpeg/ffmpeg (try
// 0.12.10 / 0.12.15). Loaded from CDN so Vite's build never has to bundle the
// ~31 MB core out of /public.
//
// We load the ESM core (`/dist/esm`), NOT umd: Vite bundles @ffmpeg/ffmpeg's
// internal worker as a *module* worker, and only the ESM core has the
// `export default createFFmpegCore` that the worker imports. The umd core
// assigns to module.exports/exports only — no global fallback — so importing it
// in a module worker leaves createFFmpegCore undefined and load() fails with
// "failed to import ffmpeg-core.js".
const CORE_VERSION = '0.12.10'
const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`

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
 * `-filter_complex` is ONE single argument string. Float seconds are passed
 * straight through (e.g. 2.983) to preserve frame accuracy. For a single segment
 * we label the trim outputs `[outv]`/`[outa]` directly and skip the concat.
 */
export function buildExportArgs(
  segments: ExportSegment[],
  inputName = 'input.mp4',
  outputName = 'output.mp4',
): string[] {
  if (segments.length === 0) {
    throw new Error('Cannot export: the EDL has no kept segments.')
  }

  const n = segments.length
  const clauses: string[] = []
  for (let i = 0; i < n; i++) {
    const { start, end } = segments[i]
    // n === 1: label directly as the final outputs so no concat is needed.
    const vLabel = n === 1 ? 'outv' : `v${i}`
    const aLabel = n === 1 ? 'outa' : `a${i}`
    clauses.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${vLabel}]`)
    clauses.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${aLabel}]`)
  }

  let filter = clauses.join(';')
  if (n > 1) {
    const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('')
    filter += `;${concatInputs}concat=n=${n}:v=1:a=1[outv][outa]`
  }

  return [
    '-i', inputName,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    outputName,
  ]
}

/**
 * Load the single-threaded ffmpeg core from the CDN, once. Guarded on
 * `ffmpeg.loaded` so React 19 StrictMode's double-invocation can't load twice.
 * Single-threaded → no `workerURL`, no SharedArrayBuffer / cross-origin isolation.
 */
export async function loadFfmpeg(ffmpeg: FFmpeg): Promise<void> {
  if (ffmpeg.loaded) {
    return
  }
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
  })
}

/** The source extension (lowercased) so the VFS write keeps a decodable name. */
function inputExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) {
    return 'mp4'
  }
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Write the source into the VFS, run the one trim+concat exec, read the result
 * back as an MP4 Blob, then delete both files to free the (~2 GB-capped) VFS.
 * The caller attaches `ffmpeg.on('progress', …)` for the encode progress bar.
 */
export async function runExport(
  ffmpeg: FFmpeg,
  file: File,
  segments: ExportSegment[],
): Promise<Blob> {
  const inputName = `input.${inputExtension(file.name)}`
  const outputName = 'output.mp4'

  await ffmpeg.writeFile(inputName, await fetchFile(file))
  await ffmpeg.exec(buildExportArgs(segments, inputName, outputName))
  const data = await ffmpeg.readFile(outputName)

  await ffmpeg.deleteFile(inputName)
  await ffmpeg.deleteFile(outputName)

  // readFile returns FileData (Uint8Array | string); a binary read is always a
  // Uint8Array. Narrow it to an ArrayBuffer-backed view so it's a valid BlobPart.
  const bytes: BlobPart =
    typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)
  return new Blob([bytes], { type: 'video/mp4' })
}
