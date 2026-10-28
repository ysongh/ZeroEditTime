// Pure request boundary shared by the browser and stateless relay. Rebuild the
// whitelist rather than forwarding editor state or arbitrary client fields.

import { CLARITY_LIMITS } from './limits'
import {
  buildClaritySentenceContext,
  type ClarityContextPart,
  type ClaritySentence,
  type ClaritySentenceContext,
} from './sentences'

export type ClarityAnalysisSettings = {
  targetDurationSeconds?: number
  audience?: string
  mustStay?: string
}

export type ClarityAnalysisContext = {
  sentences: ClaritySentenceContext[]
  /** Full committed edit duration, including silence outside sentence ranges. */
  currentDurationSeconds: number
  settings: ClarityAnalysisSettings
}

export type ClarityContextValidation =
  | { ok: true; context: ClarityAnalysisContext }
  | { ok: false; kind: 'invalid' | 'oversized'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function invalid(message: string): ClarityContextValidation {
  return { ok: false, kind: 'invalid', message }
}

function oversized(message: string): ClarityContextValidation {
  return {
    ok: false,
    kind: 'oversized',
    message: `${message} Nothing was analyzed; clarity input is never truncated.`,
  }
}

/** Parse canonical original word-index IDs; they do not establish freshness. */
function sentenceSpan(id: string): { start: number; end: number } | null {
  const match = /^sentence:(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(id)
  if (match === null) return null
  const start = Number(match[1])
  const end = Number(match[2])
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end
    ? { start, end }
    : null
}

/** Validate the whole kept-speech context; never silently shorten or batch it. */
export function validateClarityAnalysisContext(
  value: unknown,
): ClarityContextValidation {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sentences) ||
    !positiveNumber(value.currentDurationSeconds) ||
    !isRecord(value.settings)
  ) {
    return invalid('Expected clarity sentences, a positive current duration, and settings.')
  }
  if (value.sentences.length === 0) {
    return invalid('No kept speech is available for clarity analysis.')
  }
  if (value.sentences.length > CLARITY_LIMITS.maxSentences) {
    return oversized(`Clarity analysis supports at most ${CLARITY_LIMITS.maxSentences} sentence entries.`)
  }

  const settings: ClarityAnalysisSettings = {}
  if (value.settings.targetDurationSeconds !== undefined) {
    if (!positiveNumber(value.settings.targetDurationSeconds)) {
      return invalid('Target duration must be a positive, finite number of seconds.')
    }
    settings.targetDurationSeconds = value.settings.targetDurationSeconds
  }
  for (const [key, limit, label] of [
    ['audience', CLARITY_LIMITS.maxAudienceCharacters, 'Audience'],
    ['mustStay', CLARITY_LIMITS.maxMustStayCharacters, 'What must stay?'],
  ] as const) {
    const text = value.settings[key]
    if (text === undefined) continue
    if (typeof text !== 'string') return invalid(`${label} must be text.`)
    if (text.length > limit) {
      return oversized(`${label} supports at most ${limit} characters.`)
    }
    if (text.trim() !== '') settings[key] = text.trim()
  }

  const sentences: ClaritySentenceContext[] = []
  let previousEndIndex = -1
  let transcriptCharacters = 0
  let contextParts = 0
  for (const row of value.sentences) {
    if (
      !isRecord(row) ||
      typeof row.sentenceId !== 'string' ||
      typeof row.removable !== 'boolean' ||
      !positiveNumber(row.durationSeconds) ||
      row.durationSeconds > value.currentDurationSeconds + 1e-9 ||
      !Array.isArray(row.parts) ||
      row.parts.length === 0
    ) {
      return invalid('Each clarity sentence needs an ID, valid duration, removal eligibility, and audible context.')
    }
    if (row.sentenceId.length > CLARITY_LIMITS.maxSentenceIdCharacters) {
      return oversized(`Clarity sentence IDs support at most ${CLARITY_LIMITS.maxSentenceIdCharacters} characters.`)
    }
    const span = sentenceSpan(row.sentenceId)
    if (span === null || span.start <= previousEndIndex) {
      return invalid('Clarity sentence IDs must be unique original word spans in source order.')
    }
    previousEndIndex = span.end

    contextParts += row.parts.length
    if (contextParts > CLARITY_LIMITS.maxContextParts) {
      return oversized(`Clarity analysis supports at most ${CLARITY_LIMITS.maxContextParts} speech and cut markers.`)
    }
    const parts: ClarityContextPart[] = []
    let hasSpeech = false
    for (const part of row.parts) {
      if (!isRecord(part)) return invalid('Malformed clarity speech context.')
      if (part.kind === 'speech') {
        if (typeof part.text !== 'string') {
          return invalid('Clarity speech context must contain nonblank transcript text.')
        }
        transcriptCharacters += part.text.length
        if (transcriptCharacters > CLARITY_LIMITS.maxTranscriptCharacters) {
          return oversized(`Clarity analysis supports at most ${CLARITY_LIMITS.maxTranscriptCharacters} transcript characters.`)
        }
        if (part.text.trim() === '') {
          return invalid('Clarity speech context must contain nonblank transcript text.')
        }
        parts.push({ kind: 'speech', text: part.text })
        hasSpeech = true
      } else if (part.kind === 'cut' || part.kind === 'partial-word') {
        parts.push({ kind: part.kind })
        if (part.kind === 'partial-word') hasSpeech = true
      } else {
        return invalid('Unknown clarity speech-context marker.')
      }
    }
    if (!hasSpeech) return invalid('Clarity context cannot contain a fully deleted sentence.')
    if (row.removable && (parts.length !== 1 || parts[0].kind !== 'speech')) {
      return invalid('Fragmented clarity sentences must be protected from removal.')
    }
    sentences.push({
      sentenceId: row.sentenceId,
      removable: row.removable,
      durationSeconds: row.durationSeconds,
      parts,
    })
  }

  return {
    ok: true,
    context: {
      sentences,
      currentDurationSeconds: value.currentDurationSeconds,
      settings,
    },
  }
}

/** Safe projection of the local catalog; do not send the catalog itself. */
export function buildClarityAnalysisContext(
  catalog: readonly ClaritySentence[],
  currentDurationSeconds: number,
  settings: ClarityAnalysisSettings = {},
): ClarityAnalysisContext {
  const result = validateClarityAnalysisContext({
    sentences: buildClaritySentenceContext(catalog),
    currentDurationSeconds,
    settings,
  })
  if (!result.ok) throw new Error(result.message)
  return result.context
}
