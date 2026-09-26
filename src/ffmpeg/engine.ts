// The one shared ffmpeg.wasm engine for the whole app. The ~31 MB core is heavy,
// so there is exactly ONE FFmpeg instance (module-level), loaded once while
// healthy and reloaded after a timeout — shared by export and extraction. Never
// construct a second FFmpeg anywhere; import `getFfmpeg` from here instead.
//
// The instance is built LAZILY on first `getFfmpeg()` — never at module load —
// because `new FFmpeg()` throws "ffmpeg.wasm does not support nodejs", which would
// crash the offline unit tests that import the pure `inputExtension` helper from
// here. Lazy construction also means React 19 StrictMode's double render can never
// build two (the singleton is cached after the first call).

import { FFmpeg } from '@ffmpeg/ffmpeg'

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
export const ENGINE_LOAD_TIMEOUT_MS = 60_000

// The single instance, shared by every caller for the app's life. Built on first
// use (see above) and cached here thereafter.
let instance: FFmpeg | null = null
// File selection preloads in the background, while Transcribe/Export also await
// this loader. `ffmpeg.loaded` changes only after the worker replies, so it
// cannot by itself deduplicate callers that overlap during that window.
let inFlightLoad: Promise<void> | null = null
const activeJobs = new WeakSet<FFmpeg>()

/** The one shared FFmpeg instance. Always go through this — never `new FFmpeg()`. */
export function getFfmpeg(): FFmpeg {
  if (instance === null) {
    instance = new FFmpeg()
  }
  return instance
}

/**
 * Load the single-threaded ffmpeg core from the CDN, once. Completed loads are
 * guarded by `ffmpeg.loaded`; overlapping preload/awaited callers share the same
 * in-flight promise, and a rejected attempt is cleared so a later call can retry.
 * Single-threaded → no `workerURL`, no SharedArrayBuffer / cross-origin isolation,
 * so it works under plain `pnpm dev`.
 */
export async function loadFfmpeg(): Promise<void> {
  const ffmpeg = getFfmpeg()
  if (ffmpeg.loaded) {
    return
  }
  if (inFlightLoad !== null) {
    return inFlightLoad
  }

  const pending = loadCore(ffmpeg)
  inFlightLoad = pending

  try {
    await pending
  } finally {
    // A rejected background preload must not poison later awaited uses.
    if (inFlightLoad === pending) {
      inFlightLoad = null
    }
  }
}

async function loadCore(ffmpeg: FFmpeg): Promise<void> {
  const controller = new AbortController()
  const urls: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const download = async (filename: string, type: string): Promise<string> => {
    const response = await fetch(`${CORE_BASE_URL}/${filename}`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(
        `Audio/video engine download failed (HTTP ${response.status}). Check your connection and try again.`,
      )
    }
    const bytes = await response.arrayBuffer()
    // A late response from a timed-out attempt must not start another worker.
    controller.signal.throwIfAborted()
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    urls.push(url)
    return url
  }
  try {
    await Promise.race([
      (async () => {
        const [coreURL, wasmURL] = await Promise.all([
          download('ffmpeg-core.js', 'text/javascript'),
          download('ffmpeg-core.wasm', 'application/wasm'),
        ])
        controller.signal.throwIfAborted()
        await ffmpeg.load({ coreURL, wasmURL })
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            'Loading the audio/video engine timed out. Check your connection and try again.',
          ))
        }, ENGINE_LOAD_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    // No extraction/export can own this unloaded worker yet. Terminating it
    // clears a stalled load so the SAME FFmpeg instance can be loaded on retry.
    controller.abort()
    ffmpeg.terminate()
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Could not load the audio/video engine. Try again.',
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
    for (const url of urls) URL.revokeObjectURL(url)
  }
}

/** Own the shared worker and its VFS until a complete extraction/export settles. */
export async function withFfmpegJob<T>(
  ffmpeg: FFmpeg,
  work: (signal: AbortSignal) => Promise<T>,
  deadline?: { timeoutMs: number; message: string },
): Promise<T> {
  if (activeJobs.has(ffmpeg)) {
    throw new Error(
      'The audio/video engine is busy. Wait for audio preparation or export to finish, then try again.',
    )
  }
  activeJobs.add(ffmpeg)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = work(controller.signal)
    if (deadline === undefined) return await pending
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(deadline.message)
          reject(error)
          controller.abort(error)
          // Exclusive ownership makes it safe to stop a stuck extraction.
          ffmpeg.terminate()
        }, deadline.timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    activeJobs.delete(ffmpeg)
  }
}

/** The source extension (lowercased) so the VFS write keeps a decodable name. */
export function inputExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) {
    return 'mp4'
  }
  return filename.slice(dot + 1).toLowerCase()
}
