// Phase-4 agent proxy — a STATELESS RELAY. The browser runs the agent loop and
// owns the EDL; this function only injects the system prompt + tool schemas and
// forwards the conversation to Claude, returning Claude's reply unchanged. It
// executes no tools, holds no EDL, and contains no editing logic or state —
// Claude SELECTS tools, the client computes ranges and applies them.
//
// Key handling mirrors the transcribe proxy exactly: ANTHROPIC_API_KEY is read
// from the environment only, never logged and never returned to the client.

import process from 'node:process'

// Minimal shape of the Netlify (v1) function event we rely on. Declared inline so
// the function stays strictly typed without pulling in @netlify/functions.
type AgentEvent = {
  httpMethod: string
  body: string | null
}

type AgentResponse = {
  statusCode: number
  headers?: Record<string, string>
  body: string
}

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 1024

// Behavioral system prompt. The proxy owns this; the client owns `messages` and
// the per-command context block. It steers tool SELECTION only — never timestamps.
const SYSTEM_PROMPT = `You are a video-editing assistant for a transcript-based editor.

You receive the user's natural-language command, the transcript with per-word source timestamps, and the current kept duration of the edit. Use the provided tools to achieve the user's intent.

Guidelines:
- PREFER non-destructive cuts (remove_silences, remove_filler_words, remove_stumbles) BEFORE any trim_to_duration, which crops the tail of the video and permanently loses content. Only trim to a target duration after the non-destructive cuts if the result is still over the target.
- remove_stumbles removes verbal stumbles — repeated words, false starts, and re-said phrases — keeping the speaker's final take; it takes no arguments.
- For a vague "remove the silences", a threshold of about 600 ms is a sensible default; honor a specific pause length if the user names one.
- Silence removal keeps ~250 ms of each removed gap by default so pacing stays natural; set keep_gap_ms=0 only if the user explicitly asks for maximally tight or rapid-fire pacing.
- After each tool call you will receive the new kept duration. Stop and give a one-sentence summary once the goal is met.
- NEVER invent or compute timestamps — the tools detect ranges from the transcript themselves. Your job is to choose which tools to run and with what arguments.`

// Tool schemas. These mirror the client-side executors EXACTLY — same names and
// input shapes — so a tool Claude selects maps 1:1 onto a pure executor.
const TOOLS = [
  {
    name: 'cut_segment',
    description:
      'Remove one explicit source time-range (in seconds) from the edit. Use only when the user names a specific range to cut.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'number', description: 'Range start, in source seconds.' },
        end: { type: 'number', description: 'Range end, in source seconds.' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'remove_silences',
    description:
      'Shorten every inter-word gap longer than the threshold, keeping keep_gap_ms of breathing room. Non-destructive — it only cuts pauses between words.',
    input_schema: {
      type: 'object',
      properties: {
        threshold_ms: {
          type: 'number',
          description:
            'Minimum gap length to remove, in milliseconds (e.g. 600 for typical pauses).',
        },
        keep_gap_ms: {
          type: 'number',
          description:
            'Milliseconds of each removed gap to KEEP for natural pacing. Defaults to 250; set 0 only for maximally tight, rapid-fire pacing.',
        },
      },
      required: ['threshold_ms'],
    },
  },
  {
    name: 'remove_filler_words',
    description:
      'Remove each occurrence of a filler word or phrase. Non-destructive. Omit "words" to use the default set (um, uh, uhh, er, like, you know, i mean).',
    input_schema: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional custom list of filler words/phrases to remove.',
        },
      },
      required: [],
    },
  },
  {
    name: 'remove_stumbles',
    description:
      "Remove verbal stumbles — immediately repeated words, partial-word false starts, and re-said phrases — keeping the speaker's final take. Non-destructive; detection runs on the transcript and takes no arguments.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'trim_to_duration',
    description:
      'Crop the TAIL of the edit until the kept duration is at most target_seconds. Destructive — loses content from the end. Use last, after non-destructive cuts.',
    input_schema: {
      type: 'object',
      properties: {
        target_seconds: {
          type: 'number',
          description: 'Maximum kept duration, in seconds.',
        },
      },
      required: ['target_seconds'],
    },
  },
]

function json(statusCode: number, payload: unknown): AgentResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

export const handler = async (event: AgentEvent): Promise<AgentResponse> => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed; POST { messages }.' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === '') {
    return json(500, { error: 'Server is missing ANTHROPIC_API_KEY.' })
  }

  if (event.body === null || event.body === '') {
    return json(400, { error: 'Empty request body; expected { messages }.' })
  }

  let messages: unknown
  try {
    const parsed: unknown = JSON.parse(event.body)
    if (typeof parsed !== 'object' || parsed === null) {
      return json(400, { error: 'Request body must be a JSON object.' })
    }
    messages = (parsed as { messages?: unknown }).messages
  } catch {
    return json(400, { error: 'Request body was not valid JSON.' })
  }

  if (!Array.isArray(messages)) {
    return json(400, { error: 'Expected a "messages" array.' })
  }

  let upstream: Response
  try {
    upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    })
  } catch (err) {
    return json(502, {
      error: `Could not reach the model service: ${String(err)}`,
    })
  }

  if (!upstream.ok) {
    const detail = await upstream.text()
    return json(upstream.status, { error: `Agent request failed: ${detail}` })
  }

  const payload: unknown = await upstream.json()
  if (typeof payload !== 'object' || payload === null) {
    return json(502, { error: 'Malformed response from the model.' })
  }

  // Relay Claude's reply unchanged: the client reads `content` (tool_use blocks
  // and text) and `stop_reason` to drive the loop.
  const { content, stop_reason } = payload as {
    content: unknown
    stop_reason: unknown
  }
  return json(200, { content, stop_reason })
}
