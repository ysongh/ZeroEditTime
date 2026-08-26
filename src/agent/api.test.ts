import { describe, expect, it } from 'vitest'
import { postAgentRequest, type FetchLike } from './api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('postAgentRequest', () => {
  it('posts an arbitrary JSON contract to the same-origin relay with no secret headers', async () => {
    const requestBody = {
      mode: 'retake-analysis',
      context: { candidate: { text: 'Try that again' } },
    }
    let requestedInput: RequestInfo | URL | undefined
    let requestedInit: RequestInit | undefined
    const fetchImpl: FetchLike = async (input, init) => {
      requestedInput = input
      requestedInit = init
      return jsonResponse({ content: [], stop_reason: 'end_turn' })
    }

    await postAgentRequest(requestBody, fetchImpl)

    expect(requestedInput).toBe('/api/agent')
    expect(requestedInit).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    expect(requestedInit?.headers).not.toHaveProperty('Authorization')
    expect(requestedInit?.headers).not.toHaveProperty('x-api-key')
  })

  it('returns the proxy content and stop reason unchanged', async () => {
    const content = [
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 'tool_1', name: 'cut_segment', input: {} },
    ]
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ content, stop_reason: 'tool_use', ignored: true })

    await expect(postAgentRequest({ messages: [] }, fetchImpl)).resolves.toEqual({
      content,
      stop_reason: 'tool_use',
    })
  })

  it('surfaces the relay JSON error when one is available', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ error: 'Claude is unavailable.' }, 502)

    await expect(postAgentRequest({}, fetchImpl)).rejects.toThrow(
      'Claude is unavailable.',
    )
  })

  it('falls back to the HTTP status for a non-JSON error response', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('upstream failed', { status: 503 })

    await expect(postAgentRequest({}, fetchImpl)).rejects.toThrow(
      'The agent request failed (HTTP 503).',
    )
  })

  it('falls back to the HTTP status when JSON has no string error', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 42 }, 400)

    await expect(postAgentRequest({}, fetchImpl)).rejects.toThrow(
      'The agent request failed (HTTP 400).',
    )
  })

  it('rejects a non-object success response as malformed', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse('not a reply')

    await expect(postAgentRequest({}, fetchImpl)).rejects.toThrow(
      'Received a malformed response from the agent.',
    )
  })

  it.each([
    ['an array envelope', new Response('[]', { status: 200 })],
    ['invalid JSON', new Response('not json', { status: 200 })],
  ])('rejects %s as a malformed success response', async (_name, response) => {
    const fetchImpl: FetchLike = async () => response

    await expect(postAgentRequest({}, fetchImpl)).rejects.toThrow(
      'Received a malformed response from the agent.',
    )
  })
})
