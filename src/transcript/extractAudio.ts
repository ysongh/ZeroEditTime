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
import { getFfmpeg, inputExtension, loadFfmpeg } from '../ffmpeg/engine'

// Shared encode settings: strip video (`-vn`), downmix to mono, resample to 16 kHz.
const COMMON_ARGS = ['-vn', '-ac', '1', '-ar', '16000']

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

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file))

    try {
      const mp3 = await encode(ffmpeg, inputName, 'output.mp3', 'libmp3lame', ['-b:a', '64k'])
      return new Blob([mp3], { type: 'audio/mpeg' })
    } catch (mp3Err) {
      if (!isUnknownEncoder(logs.join('\n'), 'libmp3lame')) {
        throw describeFailure(logs.join('\n'), mp3Err)
      }
      // libmp3lame unavailable in this core — retry as PCM WAV from a clean log.
      logs.length = 0
      try {
        const wav = await encode(ffmpeg, inputName, 'output.wav', 'pcm_s16le', [])
        return new Blob([wav], { type: 'audio/wav' })
      } catch (wavErr) {
        throw describeFailure(logs.join('\n'), wavErr)
      }
    }
  } finally {
    ffmpeg.off('log', onLog)
    // Best-effort VFS cleanup: a file may not exist if its encode never ran.
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, 'output.mp3')
    await safeDelete(ffmpeg, 'output.wav')
  }
}

/** Run one extraction exec and read the result back as a Blob part. */
async function encode(
  ffmpeg: FFmpeg,
  inputName: string,
  outputName: string,
  codec: string,
  extra: string[],
): Promise<BlobPart> {
  await ffmpeg.exec(['-i', inputName, ...COMMON_ARGS, '-c:a', codec, ...extra, outputName])
  const data = await ffmpeg.readFile(outputName)
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

async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // The file may not exist (its encode failed); freeing the VFS is best-effort.
  }
}
