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
    expect(properties.suggestedScript).toMatchObject({
      type: 'string',
      description: expect.any(String),
    })
    const suggestedScriptDescription = properties.suggestedScript
      .description as string
    expect(suggestedScriptDescription).toContain('Optional')
    expect(suggestedScriptDescription).toContain('copy-ready')
    expect(suggestedScriptDescription).toContain(
      'supported by supplied evidence',
    )

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

  it('installs the conservative Part-G editing and speech-fairness policy', async () => {
    const recorder = recordingFetch()

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(200)
    expect(recorder.calls).toHaveLength(1)
    const prompt = requestBody(recorder.calls[0]).system
    expect(prompt).toEqual(expect.any(String))
    const instruction = (prompt as string).replace(/\s+/gu, ' ').trim()

    for (const required of [
      'NOT to criticize the speaker',
      'repaired cleanly through editing',
      're-recording it would materially improve the final video',
      'Prefer editing over re-recording whenever editing can already produce a clean result',
      'editing cannot produce a clean result',
      'heuristic signals as screening evidence, not as automatic proof',
      'If the evidence does not meet the retake threshold, set needsRetake to false',
      'Keep the explanation concise and actionable',
    ]) {
      expect(instruction).toContain(required)
    }

    const ordinaryStart = instruction.indexOf(
      'Do not recommend a retake merely because:',
    )
    const thresholdStart = instruction.indexOf(
      'Recommend a retake only when',
    )
    const fairnessStart = instruction.indexOf('Do not grade or penalize')
    expect(ordinaryStart).toBeGreaterThan(-1)
    expect(thresholdStart).toBeGreaterThan(ordinaryStart)
    expect(fairnessStart).toBeGreaterThan(thresholdStart)

    const ordinaryImperfectionSection = instruction.slice(
      ordinaryStart,
      thresholdStart,
    )
    for (const ordinaryImperfection of [
      'there is one filler word',
      'there is ordinary silence',
      'there is a removable pause',
      'there is a clean stumble with a usable final take',
      'there are minor volume differences or mild constant background noise',
      'there is a caption problem',
      'the wording is informal',
      'the speaker has an accent',
      'the grammar is conversational',
      'the speaker does not sound like a professional presenter',
    ]) {
      expect(ordinaryImperfectionSection).toContain(ordinaryImperfection)
    }
    expect(ordinaryImperfectionSection).toContain(
      'An unusually dense filler cluster in an important sentence or an unusually long in-sentence hesitation supports a retake only when cutting it would still leave the thought awkward, incomplete, or unnatural',
    )

    const retakeThresholdSection = instruction.slice(
      thresholdStart,
      fairnessStart,
    )
    expect(retakeThresholdSection).toContain(
      'supplied evidence shows that editing cannot produce a clean result',
    )
    for (const retakeThreshold of [
      'no clean complete take of the thought exists',
      'the thought is incomplete',
      'repeated attempts remain unusable',
      'severe stumbling prevents a natural edit',
      'the explanation itself is confusing enough that cutting cannot fix it',
      'an unusually dense filler cluster in an important sentence, or an unusually long in-sentence hesitation, cannot be cut into a natural, complete thought',
      'audio quality is severe enough that existing cleanup is unlikely to repair it',
    ]) {
      expect(retakeThresholdSection).toContain(retakeThreshold)
    }

    expect(instruction).toContain(
      'Do not grade or penalize accents, dialects, speech differences, voice characteristics, or appearance',
    )
    expect(instruction).toContain(
      'Never instruct the speaker to sound more native',
    )
    expect(instruction).toContain('never present "more native" speech as better')
    expect(instruction).toContain(
      'Base the decision on editability, not personal speaking style',
    )
    expect(instruction).toContain(
      'Use audio-quality or low-transcription-confidence only when the corresponding reliable signal is actually supplied',
    )
    expect(instruction).toContain(
      'Never infer audio quality or transcription confidence from transcript wording',
    )
    expect(instruction).toContain(
      'Low transcription confidence is transcript uncertainty, not evidence that an accent or speech difference is a flaw',
    )

  })

  it('installs the faithful, copy-ready Part-H suggested-script policy', async () => {
    const recorder = recordingFetch()

    const response = await handleAgent(
      {
        httpMethod: 'POST',
        body: JSON.stringify({ mode: RETAKE_ANALYSIS_MODE, context: CONTEXT }),
      },
      { apiKey: API_KEY, fetch: recorder.fetch },
    )

    expect(response.statusCode).toBe(200)
    expect(recorder.calls).toHaveLength(1)
    const prompt = requestBody(recorder.calls[0]).system
    expect(prompt).toEqual(expect.any(String))
    const instruction = (prompt as string).replace(/\s+/gu, ' ').trim()
    const scriptPolicyStart = instruction.indexOf(
      'When needsRetake is true, suggestedScript remains optional',
    )
    const structuredOutputStart = instruction.indexOf(
      'Return no free-form answer',
    )
    expect(scriptPolicyStart).toBeGreaterThan(-1)
    expect(structuredOutputStart).toBeGreaterThan(scriptPolicyStart)
    const scriptPolicy = instruction.slice(
      scriptPolicyStart,
      structuredOutputStart,
    )
    const structuredOutput = instruction.slice(structuredOutputStart)

    for (const requirement of [
      'supplied candidate and surrounding before, after, or nearbyAlternateTakes evidence',
      'useful, faithful replacement',
      'preserve the speaker\'s intended meaning',
      'introduce no unsupported factual claims, capabilities, steps, or details',
      'stay short, natural, and easy to read aloud',
      'preserve product names and code terms accurately',
      'spelling or casing is supplied',
      'use the surrounding context',
      'change only what is needed to repair the problem',
      'personal or conversational style',
      'more formal, professional, or "more native"',
      'typically be no more than one or two sentences',
      'replacement wording would not be useful',
      'intended meaning or a required term is uncertain',
      'faithful version would require guessing',
      'missing conclusion of an incomplete thought',
      'unsupported product behavior',
      'only the final copy-ready words to speak',
      'no label, wrapping quotation marks, Markdown, explanation, alternatives, placeholders, or stage directions',
      'advisory text the user may choose to copy and record',
      'never claim it was applied',
      'never insert, replace, or alter audio or recorded media automatically',
    ]) {
      expect(scriptPolicy).toContain(requirement)
    }

    expect(structuredOutput).toContain(
      'When needsRetake is false, omit reason, severity, and suggestedScript',
    )
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
