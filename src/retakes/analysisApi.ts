// Browser API for one Phase-11 retake candidate. The existing stateless Claude
// relay owns credentials, model selection, prompts, and tool schemas; this
// module sends only the bounded context and validates the returned tool input.

import {
  postAgentRequest,
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
): Promise<RetakeAnalysisResult> {
  const boundedContext = normalizeRetakeAnalysisContext(context)
  if (boundedContext === null) {
    throw new Error('Cannot analyze a malformed retake context.')
  }

  const reply = await postAgentRequest(
    { mode: RETAKE_ANALYSIS_MODE, context: boundedContext },
    fetchImpl,
  )
  const result = extractRetakeAnalysisResult(reply)
  if (result === null) {
    throw new Error('Received a malformed retake-analysis result.')
  }

  return result
}
