// The one shared ffmpeg.wasm engine for the whole app. The ~31 MB core is heavy,
// so there is exactly ONE FFmpeg instance (module-level) and it loads at most once
// per session — shared by Phase-5 export AND Phase-2.5 audio extraction. Never
// construct a second FFmpeg anywhere; import `getFfmpeg` from here instead.
//
// The instance is built LAZILY on first `getFfmpeg()` — never at module load —
// because `new FFmpeg()` throws "ffmpeg.wasm does not support nodejs", which would
// crash the offline unit tests that import the pure `inputExtension` helper from
// here. Lazy construction also means React 19 StrictMode's double render can never
// build two (the singleton is cached after the first call).

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

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

// The single instance, shared by every caller for the app's life. Built on first
// use (see above) and cached here thereafter.
let instance: FFmpeg | null = null

/** The one shared FFmpeg instance. Always go through this — never `new FFmpeg()`. */
export function getFfmpeg(): FFmpeg {
  if (instance === null) {
    instance = new FFmpeg()
  }
  return instance
}

/**
 * Load the single-threaded ffmpeg core from the CDN, once. Guarded on
 * `ffmpeg.loaded` so repeated calls (StrictMode, preload + an awaited use) can't
 * load twice. Single-threaded → no `workerURL`, no SharedArrayBuffer / cross-origin
 * isolation, so it works under plain `pnpm dev`.
 */
export async function loadFfmpeg(): Promise<void> {
  const ffmpeg = getFfmpeg()
  if (ffmpeg.loaded) {
    return
  }
  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
  })
}

/** The source extension (lowercased) so the VFS write keeps a decodable name. */
export function inputExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) {
    return 'mp4'
  }
  return filename.slice(dot + 1).toLowerCase()
}
