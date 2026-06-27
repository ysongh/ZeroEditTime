// Thin transcription proxy. The browser POSTs the media bytes to /api/transcribe;
// this function attaches the secret OpenAI key (never exposed to the client),
// forwards the audio to OpenAI Whisper for word-level timestamps, and reshapes the
// response into our { words: Word[] } contract. It holds no editing logic and no
// state — reshaping the response is the only thing it does.

import { Buffer } from 'node:buffer'
import process from 'node:process'

// Our transcript word: text + start/end in seconds into the source.
type Word = { text: string; start: number; end: number }

// Minimal shape of the Netlify (v1) function event we rely on. Declared inline so
// the function stays strictly typed without pulling in @netlify/functions.
type TranscribeEvent = {
  httpMethod: string
  body: string | null
  isBase64Encoded: boolean
  headers: Record<string, string | undefined> | null
}

type TranscribeResponse = {
  statusCode: number
  headers?: Record<string, string>
  body: string
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'

// OpenAI infers the audio format from the upload's filename extension and rejects
// a nameless buffer, so we name the upload from the request's Content-Type. The
// client (Phase 2.5) extracts audio and sends `audio/mpeg` or `audio/wav`; map the
// common media types to an OpenAI-supported extension and default to mp3.
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

// Pure and exported for unit testing: strip any `; charset=…`, lowercase, and look
// up the extension; unknown or missing types fall back to mp3 (the extractor's
// primary output).
export function extensionForContentType(contentType: string | undefined): string {
  const base = contentType?.split(';')[0]?.trim().toLowerCase()
  if (base !== undefined && base in CONTENT_TYPE_EXTENSIONS) {
    return CONTENT_TYPE_EXTENSIONS[base]
  }
  return 'mp3'
}

function json(statusCode: number, payload: unknown): TranscribeResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

// Reshape OpenAI's verbose_json (a top-level `words` array of { word, start, end })
// into our Word[]. Validates the untrusted external response without using `any`.
function toWords(data: unknown): Word[] | null {
  if (typeof data !== 'object' || data === null || !('words' in data)) {
    return null
  }
  const raw = (data as { words: unknown }).words
  if (!Array.isArray(raw)) {
    return null
  }
  const items: unknown[] = raw
  const words: Word[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const { word, start, end } = item as {
      word: unknown
      start: unknown
      end: unknown
    }
    if (
      typeof word === 'string' &&
      typeof start === 'number' &&
      typeof end === 'number'
    ) {
      words.push({ text: word, start, end })
    }
  }
  return words
}

export const handler = async (
  event: TranscribeEvent,
): Promise<TranscribeResponse> => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed; POST the media file.' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey === '') {
    return json(500, { error: 'Server is missing OPENAI_API_KEY.' })
  }

  if (event.body === null || event.body === '') {
    return json(400, { error: 'Empty request body; expected media bytes.' })
  }

  const audio = Buffer.from(
    event.body,
    event.isBase64Encoded ? 'base64' : 'utf8',
  )
  const filename = `input.${extensionForContentType(event.headers?.['content-type'])}`

  const form = new FormData()
  form.append('file', new Blob([audio]), filename)
  form.append('model', 'whisper-1') // required: gpt-4o-* models omit word timestamps
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word') // [] is required for word times

  const endpoint = process.env.TRANSCRIBE_ENDPOINT ?? OPENAI_ENDPOINT

  let upstream: Response
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
  } catch (err) {
    return json(502, {
      error: `Could not reach the transcription service: ${String(err)}`,
    })
  }

  if (!upstream.ok) {
    const detail = await upstream.text()
    return json(upstream.status, { error: `Transcription failed: ${detail}` })
  }

  const payload: unknown = await upstream.json()
  const words = toWords(payload)
  if (words === null) {
    return json(502, {
      error: 'Transcription response was missing word-level timestamps.',
    })
  }

  return json(200, { words })
}
