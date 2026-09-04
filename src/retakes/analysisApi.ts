// Browser API for one Phase-11 retake candidate. The existing stateless Claude
// relay owns credentials, model selection, prompts, and tool schemas; this
// module sends only the bounded context and validates the returned tool input.

import {
  postAgentRequest,
  type AgentReply,
  type FetchLike,
} from '../agent/api'
import {
  RETAKE_ANALYSIS_MODE,
  extractRetakeAnalysisResult,
  type RetakeAnalysisResult,
} from './analysis'
import {
  normalizeRetakeAnalysisContext,
  type RetakeAnalysisContext,
} from './context'

export const RETAKE_ANALYSIS_TIMEOUT_MS = 30_000

function requestTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? value
    : RETAKE_ANALYSIS_TIMEOUT_MS
}

/**
 * Analyze exactly one already-screened candidate context.
 *
 * Validation happens before and after the relay call: malformed/oversized
 * context cannot leave the browser, and raw model output cannot enter the
 * trusted retake domain. A successful negative result remains explicit and is
 * not converted into a recommendation in this Part-F layer.
 */
export async function analyzeRetakeContext(
  context: RetakeAnalysisContext,
  fetchImpl: FetchLike = fetch,
  timeoutMs = RETAKE_ANALYSIS_TIMEOUT_MS,
): Promise<RetakeAnalysisResult> {
  const boundedContext = normalizeRetakeAnalysisContext(context)
  if (boundedContext === null) {
    throw new Error('Cannot analyze a malformed retake context.')
  }

  const controller = new AbortController()
  let didTimeOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeOut = true
      controller.abort()
      reject(new Error('Retake analysis timed out. Try again.'))
    }, requestTimeoutMs(timeoutMs))
  })

  let reply: AgentReply
  try {
    const request = postAgentRequest(
      { mode: RETAKE_ANALYSIS_MODE, context: boundedContext },
      (input, init) =>
        fetchImpl(input, { ...init, signal: controller.signal }),
    )
    reply = await Promise.race([request, timeout])
  } catch (cause) {
    if (didTimeOut) {
      throw new Error('Retake analysis timed out. Try again.', { cause })
    }
    throw cause
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
  const result = extractRetakeAnalysisResult(reply)
  if (result === null) {
    throw new Error('Received a malformed retake-analysis result.')
  }

  return result
}
