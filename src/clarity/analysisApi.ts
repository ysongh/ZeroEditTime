// One explicit, bounded clarity-analysis request through the shared relay.
// This adapter never applies edits or starts background work. The caller owns
// request freshness; its AbortSignal cancels obsolete requests promptly.

import {
  postAgentRequest,
  type AgentReply,
  type FetchLike,
} from '../agent/api'
import {
  CLARITY_ANALYSIS_MODE,
  extractClarityAnalysisResult,
  type ClarityAnalysisResult,
} from './analysis'
import {
  validateClarityAnalysisContext,
  type ClarityAnalysisContext,
} from './context'

export const CLARITY_ANALYSIS_TIMEOUT_MS = 30_000

export class ClarityAnalysisCancelledError extends Error {
  constructor() {
    super('Clarity analysis was cancelled.')
    this.name = 'AbortError'
  }
}

function requestTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? value
    : CLARITY_ANALYSIS_TIMEOUT_MS
}

/**
 * Validate both boundaries around exactly one relay call. The validated input
 * snapshot is also the ID whitelist for the response, even if callers later
 * mutate their input. An empty suggestion collection is a successful result.
 */
export async function analyzeClarityContext(
  context: ClarityAnalysisContext,
  fetchImpl: FetchLike = fetch,
  timeoutMs = CLARITY_ANALYSIS_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ClarityAnalysisResult> {
  if (signal?.aborted) throw new ClarityAnalysisCancelledError()

  const validation = validateClarityAnalysisContext(context)
  if (!validation.ok) throw new Error(validation.message)
  const boundedContext = validation.context

  const controller = new AbortController()
  let didTimeOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((reason: Error) => void) | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancelRequest = () => {
    const error = new ClarityAnalysisCancelledError()
    // Settle the caller-facing race before transport abort handlers run. This
    // also works with transports that ignore cancellation entirely.
    rejectCancellation?.(error)
    controller.abort(error)
  }
  signal?.addEventListener('abort', cancelRequest, { once: true })
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeOut = true
      controller.abort()
      reject(new Error('Clarity analysis timed out. Try again.'))
    }, requestTimeoutMs(timeoutMs))
  })

  let reply: AgentReply
  try {
    const request = postAgentRequest(
      { mode: CLARITY_ANALYSIS_MODE, context: boundedContext },
      (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
    )
    reply = await Promise.race([
      request,
      timeout,
      ...(signal === undefined ? [] : [cancellation]),
    ])
    if (signal?.aborted) throw new ClarityAnalysisCancelledError()
  } catch (cause) {
    if (didTimeOut) {
      throw new Error('Clarity analysis timed out. Try again.', { cause })
    }
    throw cause
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    signal?.removeEventListener('abort', cancelRequest)
  }

  const result = extractClarityAnalysisResult(reply, boundedContext)
  if (result === null) {
    throw new Error('Received a malformed clarity-analysis result.')
  }
  return result
}
