// Shared boundary limits, not model configuration. Character counts use
// JavaScript string length (UTF-16 code units), before trimming any input.
export const CLARITY_LIMITS = {
  maxSentences: 200,
  maxTranscriptCharacters: 24_000,
  maxContextParts: 1_000,
  maxAudienceCharacters: 500,
  maxMustStayCharacters: 2_000,
  maxSuggestions: 50,
  maxExplanationCharacters: 240,
  maxSentenceIdCharacters: 64,
} as const
