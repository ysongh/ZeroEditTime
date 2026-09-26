// Phase-2.5 audio extraction: pull a tiny audio-only file out of the source IN THE
// BROWSER before uploading it to transcription, so a real 1–2 min clip clears the
// proxy's ~4.5 MB body wall. Reuses the ONE shared ffmpeg.wasm engine (so the
// ~31 MB core loads at most once, shared with export) — no WebAudio, no hand-rolled
// WAV encoder.
//
// 16 kHz mono is OPTIMAL, not a compromise: Whisper resamples everything to 16 kHz
// internally, so this matches its native rate while shrinking the file ~20×
// (~0.5 MB/min). mov/mp4/webm/mkv all decode here, which is what moots the old
// ".mov is rejected" problem — the proxy now only ever sees mp3/wav audio.

import { fetchFile } from '@ffmpeg/util'
import type { FFmpeg } from '@ffmpeg/ffmpeg'
import {
  getFfmpeg,
  inputExtension,
  loadFfmpeg,
  withFfmpegJob,
} from '../ffmpeg/engine'

// Shared encode settings: strip video (`-vn`), downmix to mono, resample to 16 kHz.
const COMMON_ARGS = ['-vn', '-ac', '1', '-ar', '16000']
export const AUDIO_PREPARATION_TIMEOUT_MS = 120_000

/**
 * Extract a small mono 16 kHz audio file from the source for transcription.
 *
 * Primary output is mp3 (libmp3lame, ~0.5 MB/min); the default core has that
 * encoder, but if a core ever lacks it we fall back to PCM WAV. The returned
 * Blob's `type` (`audio/mpeg` | `audio/wav`) tells the caller which Content-Type to
 * send. Throws a clear error if the source has no audio track (a silent source
 * can't be transcribed anyway).
 */
export async function extractAudio(file: File | string): Promise<Blob> {
  await loadFfmpeg()
  const ffmpeg = getFfmpeg()
  return withFfmpegJob(ffmpeg, (signal) => extractWithEngine(ffmpeg, file, signal), {
    timeoutMs: AUDIO_PREPARATION_TIMEOUT_MS,
    message: 'Preparing audio timed out. Try again, or choose a shorter clip.',
  })
}

async function extractWithEngine(
  ffmpeg: FFmpeg,
  file: File | string,
  signal: AbortSignal,
): Promise<Blob> {
  const name = typeof file === 'string' ? file : file.name
  const inputName = `input.${inputExtension(name)}`

  // Accumulate ffmpeg's stderr so a failed exec can be explained ("no audio track")
  // or recovered (encoder missing → WAV fallback) instead of surfacing the cryptic
  // VFS "file not found" you get when the output was never produced.
  const logs: string[] = []
  const onLog = (event: { message: string }): void => {
    logs.push(event.message)
  }
  ffmpeg.on('log', onLog)
  const stopLogging = () => ffmpeg.off('log', onLog)
  // Reading a source can stall before a worker message exists to reject. Stop
  // listening immediately on timeout even if that read never settles.
  signal.addEventListener('abort', stopLogging, { once: true })

  try {
    const bytes = await fetchFile(file)
    signal.throwIfAborted()
    await ffmpeg.writeFile(inputName, bytes)
    signal.throwIfAborted()

    try {
      const mp3 = await encode(
        ffmpeg, inputName, 'output.mp3', 'libmp3lame', ['-b:a', '64k'], signal,
      )
      return new Blob([mp3], { type: 'audio/mpeg' })
    } catch (mp3Err) {
      signal.throwIfAborted()
      if (!isUnknownEncoder(logs.join('\n'), 'libmp3lame')) {
        throw describeFailure(logs.join('\n'), mp3Err)
      }
      // libmp3lame unavailable in this core — retry as PCM WAV from a clean log.
      logs.length = 0
      try {
        const wav = await encode(
          ffmpeg, inputName, 'output.wav', 'pcm_s16le', [], signal,
        )
        return new Blob([wav], { type: 'audio/wav' })
      } catch (wavErr) {
        throw describeFailure(logs.join('\n'), wavErr)
      }
    }
  } finally {
    signal.removeEventListener('abort', stopLogging)
    stopLogging()
    // Best-effort VFS cleanup: a file may not exist if its encode never ran.
    await safeDelete(ffmpeg, inputName, signal)
    await safeDelete(ffmpeg, 'output.mp3', signal)
    await safeDelete(ffmpeg, 'output.wav', signal)
  }
}

/** Run one extraction exec and read the result back as a Blob part. */
async function encode(
  ffmpeg: FFmpeg,
  inputName: string,
  outputName: string,
  codec: string,
  extra: string[],
  signal: AbortSignal,
): Promise<BlobPart> {
  signal.throwIfAborted()
  const exitCode = await ffmpeg.exec([
    '-i', inputName, ...COMMON_ARGS, '-c:a', codec, ...extra, outputName,
  ])
  signal.throwIfAborted()
  if (exitCode !== 0) {
    throw new Error(
      `Could not prepare audio (encoder exited with code ${exitCode}). Try another clip.`,
    )
  }
  const data = await ffmpeg.readFile(outputName)
  signal.throwIfAborted()
  // A binary read is always a Uint8Array; narrow it to a valid BlobPart.
  return typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)
}

/** Surface a missing audio track plainly; otherwise pass the original error through. */
function describeFailure(log: string, err: unknown): Error {
  if (hasNoAudioStream(log)) {
    return new Error('The selected file has no audio track to transcribe.')
  }
  return err instanceof Error ? err : new Error(String(err))
}

function hasNoAudioStream(log: string): boolean {
  const l = log.toLowerCase()
  return l.includes('does not contain any stream') || l.includes('matches no streams')
}

function isUnknownEncoder(log: string, encoder: string): boolean {
  return log.toLowerCase().includes(`unknown encoder '${encoder.toLowerCase()}'`)
}

async function safeDelete(
  ffmpeg: FFmpeg,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  // Termination already removed the old VFS. Never delete a retry's files.
  if (signal.aborted) return
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // The file may not exist (its encode failed); freeing the VFS is best-effort.
  }
}
