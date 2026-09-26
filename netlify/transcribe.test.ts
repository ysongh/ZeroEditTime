// Tests for the transcribe proxy and its Content-Type→extension helper. Lives
// one level ABOVE netlify/functions/ on purpose: every file directly inside the
// functions directory is bundled as its own Netlify Function, so a `*.test.ts`
// there would register a bogus "transcribe.test" endpoint. Vitest still discovers
// it here; Netlify ignores it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extensionForContentType,
  handler,
  TRANSCRIPTION_SERVICE_TIMEOUT_MS,
} from './functions/transcribe'

describe('extensionForContentType', () => {
  it('maps the audio types the Phase-2.5 extractor produces', () => {
    expect(extensionForContentType('audio/mpeg')).toBe('mp3')
    expect(extensionForContentType('audio/wav')).toBe('wav')
  })

  it('strips charset and ignores casing', () => {
    expect(extensionForContentType('AUDIO/MPEG; charset=binary')).toBe('mp3')
    expect(extensionForContentType('Audio/Wav')).toBe('wav')
  })

  it('maps common video and m4a types to supported extensions', () => {
    expect(extensionForContentType('video/mp4')).toBe('mp4')
    expect(extensionForContentType('audio/mp4')).toBe('m4a')
    expect(extensionForContentType('audio/webm')).toBe('webm')
  })

  it('defaults to mp3 for unknown, empty, or missing types', () => {
    expect(extensionForContentType(undefined)).toBe('mp3')
    expect(extensionForContentType('')).toBe('mp3')
    expect(extensionForContentType('application/octet-stream')).toBe('mp3')
  })
})

describe('transcribe handler', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const event = {
    httpMethod: 'POST',
    body: 'audio bytes',
    isBase64Encoded: false,
    headers: { 'content-type': 'audio/mpeg' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('TRANSCRIBE_ENDPOINT', 'https://transcription.example.test')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('preserves word timings and upload settings, and clears its deadline', async () => {
    fetchMock.mockResolvedValue(Response.json({
      words: [{ word: 'Hello', start: 0.1, end: 0.5 }],
    }))

    const response = await handler(event)

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      words: [{ text: 'Hello', start: 0.1, end: 0.5 }],
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://transcription.example.test')
    expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' })
    const form = init?.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('timestamp_granularities[]')).toBe('word')
    expect((form.get('file') as File).name).toBe('input.mp3')
    expect(init?.signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['fetch', 'success body', 'error body'] as const)(
    'returns JSON 504 and aborts a stalled %s',
    async (stage) => {
      fetchMock.mockImplementation(async () => {
        if (stage === 'fetch') return new Promise<Response>(() => {})
        const response = new Response(null, {
          status: stage === 'success body' ? 200 : 429,
        })
        if (stage === 'success body') {
          vi.spyOn(response, 'json').mockImplementation(
            () => new Promise<unknown>(() => {}),
          )
        } else {
          vi.spyOn(response, 'text').mockImplementation(
            () => new Promise<string>(() => {}),
          )
        }
        return response
      })

      const request = handler(event)
      await vi.advanceTimersByTimeAsync(TRANSCRIPTION_SERVICE_TIMEOUT_MS)
      const response = await request

      expect(response.statusCode).toBe(504)
      expect(JSON.parse(response.body)).toEqual({
        error: 'The transcription service timed out. Please try again.',
      })
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('preserves a useful timeout when fetch rejects on abort', async () => {
    fetchMock.mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    )
    const request = handler(event)
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_SERVICE_TIMEOUT_MS)

    expect((await request).statusCode).toBe(504)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns an upstream service error and clears its deadline', async () => {
    fetchMock.mockResolvedValue(new Response('Too many requests', { status: 429 }))

    const response = await handler(event)

    expect(response.statusCode).toBe(429)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Transcription failed: Too many requests',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a rejected upstream error body without throwing out of the function', async () => {
    const upstream = new Response(null, { status: 503 })
    vi.spyOn(upstream, 'text').mockRejectedValue(new TypeError('Connection lost'))
    fetchMock.mockResolvedValue(upstream)

    const response = await handler(event)

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Transcription failed: HTTP 503; please try again.',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns JSON 502 for unreadable successful responses', async () => {
    fetchMock.mockResolvedValue(new Response('Not JSON'))

    const response = await handler(event)

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.body)).toEqual({
      error: 'The transcription service returned an unreadable response. Try again.',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns JSON 502 for responses missing word timings', async () => {
    fetchMock.mockResolvedValue(Response.json({ text: 'Hello' }))

    const response = await handler(event)

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Transcription response was missing word-level timestamps.',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns JSON 502 and clears the deadline after a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network unavailable'))

    const response = await handler(event)

    expect(response.statusCode).toBe(502)
    expect(JSON.parse(response.body).error).toContain('Could not reach the transcription service:')
    expect(vi.getTimerCount()).toBe(0)
  })
})
