import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribe, TRANSCRIPTION_TIMEOUT_MS } from './api'

const AUDIO = new Blob(['audio bytes'], { type: 'audio/mpeg' })
const WORDS = [{ text: 'Hello', start: 0, end: 0.5 }]

describe('transcribe', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('posts extracted audio to the proxy and clears its deadline on success', async () => {
    fetchMock.mockResolvedValue(Response.json({ words: WORDS }))

    await expect(transcribe(AUDIO)).resolves.toEqual({ words: WORDS })

    expect(fetchMock).toHaveBeenCalledWith('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: AUDIO,
      signal: expect.any(AbortSignal),
    })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['fetch', 'success body', 'error body'] as const)(
    'settles and aborts a stalled %s so the button can recover',
    async (stage) => {
      fetchMock.mockImplementation(async () => {
        if (stage === 'fetch') return new Promise<Response>(() => {})
        const response = new Response(null, {
          status: stage === 'success body' ? 200 : 502,
        })
        vi.spyOn(response, 'json').mockImplementation(
          () => new Promise<unknown>(() => {}),
        )
        return response
      })

      const request = transcribe(AUDIO)
      const rejection = expect(request).rejects.toThrow(
        'Transcription timed out. Check your connection and try again.',
      )
      await vi.advanceTimersByTimeAsync(TRANSCRIPTION_TIMEOUT_MS - 1)
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await rejection
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('keeps a useful timeout error when fetch rejects on abort and permits retry', async () => {
    fetchMock.mockImplementationOnce((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    )
    const rejection = expect(transcribe(AUDIO)).rejects.toThrow('Transcription timed out.')
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_TIMEOUT_MS)
    await rejection

    fetchMock.mockResolvedValueOnce(Response.json({ words: WORDS }))
    await expect(transcribe(AUDIO)).resolves.toEqual({ words: WORDS })
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('surfaces a proxy error and clears the deadline', async () => {
    fetchMock.mockResolvedValue(Response.json(
      { error: 'The transcription service timed out. Please try again.' },
      { status: 504 },
    ))

    await expect(transcribe(AUDIO)).rejects.toThrow(
      'The transcription service timed out. Please try again.',
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the HTTP status for a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('Gateway unavailable', { status: 502 }))

    await expect(transcribe(AUDIO)).rejects.toThrow('Transcription failed (HTTP 502).')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['not JSON', '{"words":null}'])(
    'reports an invalid successful transcript response: %s',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body))

      await expect(transcribe(AUDIO)).rejects.toThrow(
        'Received a malformed transcript from the server.',
      )
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('clears the deadline after a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network unavailable'))

    await expect(transcribe(AUDIO)).rejects.toThrow('Network unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
