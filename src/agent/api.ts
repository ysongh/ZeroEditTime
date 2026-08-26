// Shared browser transport for the stateless Claude relay. The browser sends
// only the request contract selected by the caller; the relay owns the model
// credentials and adds them server-side.

export type AgentReply = { content: unknown; stop_reason: unknown }

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

/**
 * POST one request to the same-origin Claude relay. `body` stays generic so
 * each server-owned mode can define its own JSON contract without duplicating
 * browser networking or error handling.
 */
export async function postAgentRequest(
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<AgentReply> {
  const res = await fetchImpl('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = `The agent request failed (HTTP ${res.status}).`
    try {
      const data: unknown = await res.json()
      if (
        typeof data === 'object' &&
        data !== null &&
        typeof (data as { error?: unknown }).error === 'string'
      ) {
        detail = (data as { error: string }).error
      }
    } catch {
      // Body was not JSON; keep the generic message.
    }
    throw new Error(detail)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('Received a malformed response from the agent.')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Received a malformed response from the agent.')
  }

  const { content, stop_reason } = data as {
    content: unknown
    stop_reason: unknown
  }
  return { content, stop_reason }
}
