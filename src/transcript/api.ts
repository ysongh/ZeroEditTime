// Client-side call to the transcription proxy. The browser never talks to OpenAI
// directly; it POSTs the already-extracted audio Blob (Phase 2.5: a tiny mono
// 16 kHz mp3/wav, well under the proxy's ~4.5 MB body wall) to our /api/transcribe
// function, which hides the key. The Blob's `type` rides along as the request
// Content-Type so the server can give OpenAI a name with the right extension.

import type { Transcript, Word } from './types'

// Includes uploading and reading the response, with time for the proxy to report
// its own shorter service deadline.
export const TRANSCRIPTION_TIMEOUT_MS = 60_000

function isWord(value: unknown): value is Word {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { text, start, end } = value as {
    text: unknown
    start: unknown
    end: unknown
  }
  return (
    typeof text === 'string' &&
    typeof start === 'number' &&
    typeof end === 'number'
  )
}

// Pull a human-readable message out of the proxy's JSON error response, falling
// back to the status code when the body is not the shape we expect.
async function errorMessage(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json()
    if (
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
    ) {
      return (data as { error: string }).error
    }
  } catch {
    // Body was not JSON; fall through to the generic message.
  }
  return `Transcription failed (HTTP ${res.status}).`
}

async function requestTranscript(
  audio: Blob,
  signal: AbortSignal,
): Promise<Transcript> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': audio.type },
    body: audio,
    signal,
  })

  if (!res.ok) {
    throw new Error(await errorMessage(res))
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (cause) {
    throw new Error('Received a malformed transcript from the server. Try again.', {
      cause,
    })
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    !('words' in data) ||
    !Array.isArray((data as { words: unknown }).words)
  ) {
    throw new Error('Received a malformed transcript from the server.')
  }

  const words = (data as { words: unknown[] }).words.filter(isWord)
  return { words }
}

export async function transcribe(audio: Blob): Promise<Transcript> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      // Settle the caller even if a stalled transport ignores abort, including
      // when headers arrived but the response body never finishes.
      reject(new Error('Transcription timed out. Check your connection and try again.'))
      controller.abort()
    }, TRANSCRIPTION_TIMEOUT_MS)
  })

  try {
    return await Promise.race([
      requestTranscript(audio, controller.signal),
      timeout,
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}
