// Tests live above netlify/functions so Netlify does not register this file as
// a serverless endpoint.

import { describe, expect, it } from 'vitest'
import {
  handleAgent,
  type AgentFetch,
  type AgentResponse,
} from './functions/agent'
import {
  RETAKE_ANALYSIS_MODE,
  RETAKE_ANALYSIS_TOOL_NAME,
} from '../src/retakes/analysis'
import {
  RETAKE_REASONS,
  RETAKE_SEVERITIES,
} from '../src/retakes/recommendation'

const API_KEY = 'server-only-test-key'

const CONTEXT = {
  candidate: {
    startSourceMs: 1_250,
    endSourceMs: 3_750,
    text: 'So this um explanation stops before the thought is complete...',
  },
  before: { text: 'Here is the preceding sentence.' },
  after: { text: 'Here is the following sentence.' },
  nearbyAlternateTakes: [
    {
      startSourceMs: 4_000,
      endSourceMs: 5_500,
      text: 'A possible nearby version of the thought.',
    },
  ],
  signals: {
    fillerCount: 3,
    fillerDensity: 0.3,
    longPauseCount: 1,
    longestPauseMs: 2_300,
    stumbleCount: 2,
  },
} as const

const MODEL_REPLY = {
  content: [
    {
      type: 'tool_use',
      id: 'toolu_result',
      name: RETAKE_ANALYSIS_TOOL_NAME,
      input: { needsRetake: false, confidence: 0.91 },
    },
  ],
  stop_reason: 'tool_use',
}

type FetchCall = { input: string; init: RequestInit | undefined }

function recordingFetch(
  response: Response = Response.json(MODEL_REPLY),
): { fetch: AgentFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return response
    },
  }
}

function bodyOf(response: AgentResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

function requestBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

describe('Claude agent proxy', () => {
  it('preserves the existing editing-agent request and relay shape', async () => {
    const upstream = {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      ignored: 'not relayed',
    }
    const recorder = recordingFetch(Response.json(upstream))
    const messages = [{ role: 'user', content: 'remove the silences' }]

    const response = await handleAgent(
      { httpMethod: 'POST', body: JSON.stringify({ messages }) },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toEqual({
      content: upstream.content,
      stop_reason: 'end_turn',
    })
    expect(recorder.calls).toHaveLength(1)

    const upstreamBody = requestBody(recorder.calls[0])
    expect(upstreamBody).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages,
    })
    expect(upstreamBody.system).toContain('video-editing assistant')
    expect(upstreamBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'remove_silences' }),
      ]),
    )
    expect(upstreamBody).not.toHaveProperty('tool_choice')
  })

  it('uses one forced, server-owned retake tool and a whitelisted context', async () => {
    const recorder = recordingFetch()
    const request = {
      mode: RETAKE_ANALYSIS_MODE,
      context: {
        ...CONTEXT,
        fullTranscript: 'FULL_TRANSCRIPT_SENTINEL',
        candidate: {
          ...CONTEXT.candidate,
          privateNote: 'PRIVATE_NOTE_SENTINEL',
        },
        signals: { ...CONTEXT.signals, hiddenMetric: 999 },
      },
      model: 'client-model',
      system: 'CLIENT_SYSTEM_SENTINEL',
      tools: [{ name: 'client_tool' }],
      messages: [{ role: 'user', content: 'CLIENT_MESSAGE_SENTINEL' }],
      apiKey: 'client-key',
    }

    const response = await handleAgent(
      { httpMethod: 'POST', body: JSON.stringify(request) },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toEqual(MODEL_REPLY)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].input).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    expect(recorder.calls[0].init?.method).toBe('POST')
    expect(recorder.calls[0].init?.headers).toEqual({
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })

    const upstreamBody = requestBody(recorder.calls[0])
    expect(upstreamBody.model).toBe('claude-sonnet-4-6')
    expect(upstreamBody.max_tokens).toBe(1024)
    expect(upstreamBody.system).toEqual(expect.any(String))
    expect(upstreamBody.system).toContain('untrusted evidence')
    expect(upstreamBody.system).toContain(
      'complete clean version of the candidate\'s thought',
    )
    expect(upstreamBody.system).toContain('including inside candidate')
    expect(upstreamBody.system).toContain('set needsRetake to false')
    expect(upstreamBody.system).not.toContain('CLIENT_SYSTEM_SENTINEL')
    expect(upstreamBody.tool_choice).toEqual({
      type: 'tool',
      name: RETAKE_ANALYSIS_TOOL_NAME,
      disable_parallel_tool_use: true,
    })

    const tools = upstreamBody.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe(RETAKE_ANALYSIS_TOOL_NAME)
    const schema = tools[0].input_schema as Record<string, unknown>
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >
    expect(schema.required).toEqual(['needsRetake', 'confidence'])
    expect(schema.additionalProperties).toBe(false)
    expect(properties.reason.enum).toEqual(RETAKE_REASONS)
    expect(properties.severity.enum).toEqual(RETAKE_SEVERITIES)
    expect(properties.confidence).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 1,
    })

    const messages = upstreamBody.messages as Array<{
      role: string
      content: string
    }>
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    const serializedRequest = JSON.stringify(upstreamBody)
    expect(serializedRequest).not.toContain('FULL_TRANSCRIPT_SENTINEL')
    expect(serializedRequest).not.toContain('PRIVATE_NOTE_SENTINEL')
    expect(serializedRequest).not.toContain('hiddenMetric')
    expect(serializedRequest).not.toContain('CLIENT_MESSAGE_SENTINEL')
    expect(serializedRequest).not.toContain('client-model')
    expect(serializedRequest).not.toContain('client-key')
    expect(serializedRequest).not.toContain(API_KEY)
    expect(messages[0].content).toContain(JSON.stringify(CONTEXT))
    expect(response.body).not.toContain(API_KEY)
  })

  it('canonicalizes a valid model result before relaying it to the browser', async () => {
    const rawReply = {
      content: [
        {
          ...MODEL_REPLY.content[0],
          input: {
            needsRetake: false,
            explanation: '  A complete clean take already exists.  ',
            confidence: 1.7,
            reason: 'severe-stumble',
            severity: 'strongly-recommended',
            suggestedScript: 'Must be removed on the negative branch.',
            modelOwnedId: 'discard-me',
          },
        },
      ],
      stop_reason: 'tool_use',
    }
    const recorder = recordingFetch(Response.json(rawReply))

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(200)
    expect(bodyOf(response)).toEqual({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_result',
          name: RETAKE_ANALYSIS_TOOL_NAME,
          input: {
            needsRetake: false,
            explanation: 'A complete clean take already exists.',
            confidence: 1,
          },
        },
      ],
      stop_reason: 'tool_use',
    })
  })

  it.each([
    ['missing context', { mode: RETAKE_ANALYSIS_MODE }],
    ['null context', { mode: RETAKE_ANALYSIS_MODE, context: null }],
    ['array context', { mode: RETAKE_ANALYSIS_MODE, context: [] }],
    [
      'unsafe source range',
      {
        mode: RETAKE_ANALYSIS_MODE,
        context: {
          ...CONTEXT,
          candidate: { ...CONTEXT.candidate, startSourceMs: -1 },
        },
      },
    ],
    [
      'oversized candidate excerpt',
      {
        mode: RETAKE_ANALYSIS_MODE,
        context: {
          ...CONTEXT,
          candidate: { ...CONTEXT.candidate, text: 'x'.repeat(1_201) },
        },
      },
    ],
    [
      'too many alternates',
      {
        mode: RETAKE_ANALYSIS_MODE,
        context: {
          ...CONTEXT,
          nearbyAlternateTakes: [
            CONTEXT.nearbyAlternateTakes[0],
            CONTEXT.nearbyAlternateTakes[0],
            CONTEXT.nearbyAlternateTakes[0],
          ],
        },
      },
    ],
    ['unknown mode', { mode: 'other', context: CONTEXT }],
  ])('rejects %s before calling Claude', async (_name, request) => {
    const recorder = recordingFetch()

    const response = await handleAgent(
      { httpMethod: 'POST', body: JSON.stringify(request) },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(400)
    expect(bodyOf(response).error).toEqual(expect.any(String))
    expect(recorder.calls).toHaveLength(0)
  })

  it.each([
    ['a non-POST request', { httpMethod: 'GET', body: null }, API_KEY, 405],
    ['a missing key', { httpMethod: 'POST', body: '{}' }, undefined, 500],
    ['a blank key', { httpMethod: 'POST', body: '{}' }, '  ', 500],
    ['an empty body', { httpMethod: 'POST', body: '' }, API_KEY, 400],
    ['invalid JSON', { httpMethod: 'POST', body: '{' }, API_KEY, 400],
    ['a primitive body', { httpMethod: 'POST', body: 'null' }, API_KEY, 400],
  ])('handles %s without an upstream call', async (_name, event, apiKey, status) => {
    const recorder = recordingFetch()
    const response = await handleAgent(event, {
      apiKey,
      fetch: recorder.fetch,
    })

    expect(response.statusCode).toBe(status)
    expect(recorder.calls).toHaveLength(0)
  })

  it('returns a controlled error for network and malformed upstream responses', async () => {
    const throwingFetch: AgentFetch = async () => {
      throw new Error(`network failed with ${API_KEY}`)
    }
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
    }

    const networkResponse = await handleAgent(event, {
      apiKey: API_KEY,
      fetch: throwingFetch,
    })
    expect(networkResponse.statusCode).toBe(502)
    expect(networkResponse.body).not.toContain(API_KEY)

    const malformed = recordingFetch(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const malformedResponse = await handleAgent(event, {
      apiKey: API_KEY,
      fetch: malformed.fetch,
    })
    expect(malformedResponse.statusCode).toBe(502)
    expect(bodyOf(malformedResponse)).toEqual({
      error: 'Malformed response from the model.',
    })
  })

  it.each([
    [
      'a text-only answer',
      { content: [{ type: 'text', text: 'No retake.' }], stop_reason: 'end_turn' },
    ],
    [
      'a wrong tool',
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_wrong',
            name: 'other_tool',
            input: { needsRetake: false, confidence: 1 },
          },
        ],
        stop_reason: 'tool_use',
      },
    ],
    [
      'ambiguous tools',
      {
        content: [MODEL_REPLY.content[0], MODEL_REPLY.content[0]],
        stop_reason: 'tool_use',
      },
    ],
    [
      'invalid positive input',
      {
        content: [
          {
            ...MODEL_REPLY.content[0],
            input: { needsRetake: true, confidence: 0.7 },
          },
        ],
        stop_reason: 'tool_use',
      },
    ],
  ])('rejects malformed structured model output: %s', async (_name, reply) => {
    const recorder = recordingFetch(Response.json(reply))

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(502)
    expect(bodyOf(response)).toEqual({
      error: 'Malformed retake-analysis result from the model.',
    })
    expect(response.body).not.toContain(JSON.stringify(reply))
  })

  it('preserves an upstream HTTP status while redacting the server key', async () => {
    const recorder = recordingFetch(
      new Response(`rate limited: ${API_KEY}`, { status: 429 }),
    )

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(429)
    expect(response.body).not.toContain(API_KEY)
    expect(bodyOf(response).error).toContain('[redacted]')
  })

  it('handles an unreadable upstream error body without rejecting the handler', async () => {
    const unreadableResponse = {
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('stream failed')
      },
    } as unknown as Response
    const recorder = recordingFetch(unreadableResponse)

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(503)
    expect(bodyOf(response)).toEqual({
      error: 'Agent request failed (HTTP 503).',
    })
  })
})
