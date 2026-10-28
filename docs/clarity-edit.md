# AI Clarity Edit — implementation notes

Parts 1–2 implement pure local sentence mapping and a bounded clarity-analysis
API. They are not wired into the editor yet: there is no Clarity tab, preview,
or Apply action, and the app does not automatically make clarity requests.

## Sentence mapping

The local foundation lives in
[`src/clarity/sentences.ts`](../src/clarity/sentences.ts).

`buildClaritySentenceCatalog(transcript, edl)` groups the original transcript
using the existing sentence parser. IDs use original inclusive word-index spans
(`sentence:12:18`), so repeated wording remains distinct and earlier cuts do not
renumber surviving sentences. IDs are scoped to that transcript; they do not
establish freshness across source or transcript replacement. Later proposals must
also capture their source, transcript, kept ranges, and analysis settings.

All local ranges are half-open **original-source seconds**. A removable sentence
has its entire spoken envelope kept and no overlap with any outside word.
Adjacent structural EDL splits count as continuous coverage; any positive cut
inside a sentence, including a cut through silence, protects it. Removal ranges
contain only the sentence envelope, without padding into adjacent speech or
silence. This module calculates ranges but does not apply cuts.

The local catalog retains original wording for display. Use
`buildClaritySentenceContext(catalog)` for the separate context projection:

- Only fully audible word runs carry transcript text.
- Existing cuts separate runs with `cut` markers; partly audible words use
  `partial-word` markers without their original text.
- Fully removed sentences are omitted, even if inner silence remains.
- Protected sentences have no removal range and are marked non-removable.
- Durations include kept silence within each sentence envelope. They are not the
  full edited-video duration, which also includes silence outside sentences.

Malformed text, nonfinite/invalid/out-of-source timings, reversed word order,
or invalid EDL ranges produce an error. Inputs are never silently sorted,
clamped, or mutated. Overlapping words within one sentence use the maximum end
time; overlap across sentence boundaries protects the affected sentences.

The existing punctuation-based parser can split abbreviations and treats an
unpunctuated transcript as one sentence. This step does not change that policy.
Range eligibility does not prove a sentence is unnecessary or establish proposal
freshness. The response validator now rejects proposals covering every context
entry, including when silence would remain. Later editor integration must still
revalidate freshness and actual local ranges synchronously before Apply.

## Clarity-analysis API

[`context.ts`](../src/clarity/context.ts) builds the request from the safe catalog
projection plus the locally computed full kept duration and optional settings:
`targetDurationSeconds`, `audience`, and `mustStay`. `buildClarityAnalysisContext`
validates this complete context and throws on malformed or oversized input.
`analyzeClarityContext` in
[`analysisApi.ts`](../src/clarity/analysisApi.ts) sends exactly one request:

```ts
{
  mode: 'clarity-analysis',
  context: {
    sentences, // IDs, eligible/protected status, durations, and safe speech parts
    currentDurationSeconds,
    settings: { targetDurationSeconds: 60, audience: 'Developers', mustStay: 'Setup and result' }
  }
}
```

The existing `/api/agent` relay owns the prompt, model configuration, API key,
and forced `submit_clarity_analysis` tool. It uses the repository's configured
`claude-sonnet-4-6` model with a separate 8,192-output-token budget. It executes
no edits. The legacy editing mode (no `mode` field) and `retake-analysis` retain
their existing behavior and 1,024-token budgets.

The result is `{ suggestions: [{ sentenceId, reason, explanation }] }`. Allowed
reasons are `repeated-explanation`, `off-topic-detail`, `redundant-example`, and
`excessive-introduction`. The model is instructed to preserve meaning, voice,
setup, caveats, technical accuracy, and conclusions, and to prefer coherence over
the duration target. Transcript commands are treated as quoted data. An empty
suggestion array is a valid success.

Browser and relay validate requests and model results. Unknown/protected IDs,
unknown result fields (including timestamps or replacement text), malformed
suggestions, and proposals removing all kept speech are rejected. Every duplicate
is validated; the first occurrence wins and suggestions are returned in source
order. Exactly one result tool block with a `tool_use` stop reason is required.
Truncated output, multiple tools, and additional narration are rejected rather
than treated as a partial successful proposal.

## Limits and cancellation

Shared limits live in [`limits.ts`](../src/clarity/limits.ts):

| Input/output | Limit |
| --- | --- |
| Sentence entries, including protected context | 200 |
| Total transcript text across speech parts | 24,000 characters |
| Total speech/cut/partial-word parts | 1,000 |
| Audience | 500 characters |
| What must stay? | 2,000 characters |
| Sentence ID | 64 characters, canonical original word-index span |
| Raw suggestions, before deduplication | 50 |
| Explanation per suggestion | 240 characters |
| Model output | 8,192 tokens |
| Client request deadline | 30 seconds |

Character limits count JavaScript UTF-16 code units before trimming. Transcript
wording is preserved; optional instructions and explanations are trimmed. Unknown
request fields are dropped instead of forwarded. Invalid context receives HTTP
400 and oversized context HTTP 413, without calling the model. Oversized input is
never truncated or silently divided into requests. Malformed/unsafe model results
receive HTTP 502. There are no automatic retries, cache, or background analysis.

The adapter accepts a caller `AbortSignal` as its fourth argument. Cancellation
and timeout settle even if a transport ignores abort; late success/error cannot
change the settled result. The input is copied before sending and reused to
validate the response. Latest-request ownership and source/transcript/EDL/settings
invalidation in the editor remain part of the later UI lifecycle work.

Only normalized text, IDs, eligibility, durations, and settings are sent to the
same-origin relay and then the model. Source URLs, filenames, raw media, actual
source ranges, editor content, and credentials are excluded from this request.

## Verification

Offline tests cover mapping, exact limits, request/result validation, duplicate
rules, all-speech protection, cancellation/late responses, and relay compatibility.
Network and model calls are mocked. Build, lint, and test commands are the standard
`pnpm build`, `pnpm lint`, and `pnpm test`.

Part 2 verification: build and lint passed; the full suite passed 1,311 tests
across 61 files. The new boundary, adapter, and relay suites add 241 tests.

Live-model proposal quality remains unverified. Browser playback, Undo, captions,
overlays, and actual exported-video checks await editor integration; offline API
tests do not establish those behaviors.
