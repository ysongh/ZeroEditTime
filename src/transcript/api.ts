// Client-side call to the transcription proxy. The browser never talks to OpenAI
// directly; it POSTs the media file to our /api/transcribe function, which hides
// the key. We send the raw File as the request body and pass the original
// filename so the server can give OpenAI a name with a supported extension.

import type { Transcript, Word } from './types'

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

export async function transcribe(file: File): Promise<Transcript> {
  const res = await fetch(
    `/api/transcribe?filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
  )

  if (!res.ok) {
    throw new Error(await errorMessage(res))
  }

  const data: unknown = await res.json()
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
