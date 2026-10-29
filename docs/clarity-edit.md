# AI Clarity Edit — implementation notes

Parts 1–3 implement pure local sentence mapping, a bounded clarity-analysis API,
and a working Clarity inspector for analysis and review. Edited-version preview
and applying selected cuts remain pending. Analysis runs only on an explicit click.

## Using the Clarity tab

1. Load a video and transcribe it. Open **Clarity** in the inspector.
2. Optionally enter a target duration in seconds, an audience, and **What must
   stay?**. Click **Suggest clarity edits**.
3. Review each proposed sentence's exact local wording, original source time,
   reason, and explanation. **Play original** auditions that sentence and stops
   at its end. The regular transport also stops playback.
4. Toggle **Remove this sentence** to compare the locally calculated proposed
   duration. An unmet target is shown explicitly; no extra request forces it.
5. **Discard** clears review and cancels pending analysis or its active audition.

An empty proposal is a successful result. Deselecting every suggestion still
shows the returned cards, with zero selected. Oversized input is rejected with
the applicable limit, without sending a truncated recording for analysis.

The tab stays mounted while hidden, preserving draft settings and review state.
Analysis, selection, audition, and Discard do not change editor content, Undo,
caption text, overlays, audio settings, retake workflow, or export inputs. The
proposed duration is a comparison only; export still reads the committed edit.

## Sentence mapping

The local foundation lives in
[`src/clarity/sentences.ts`](../src/clarity/sentences.ts).

`buildClaritySentenceCatalog(transcript, edl)` groups the original transcript
using the existing sentence parser. IDs use original inclusive word-index spans
(`sentence:12:18`), so repeated wording remains distinct and earlier cuts do not
renumber surviving sentences. IDs are scoped to that transcript; they do not
establish freshness across source or transcript replacement. Current review also
captures its source, transcript, kept ranges, and analysis settings.

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
validate the response. The review hook owns the latest request and ignores late
success/failure/finalization from superseded work. Source, transcript, ranges,
and draft-setting changes invalidate review and cancel analysis; rendered results
are also filtered by input identity before effect cleanup. Async editing-agent
callbacks compare against the input actually being reviewed when invalidating.
Source replacement resets draft settings. Caption, overlay, audio, and retake-only
changes preserve review. Future Apply must still revalidate freshness synchronously
against the latest editor content before a single history commit.

`review.ts` keeps draft validation, card mapping, and selected-duration calculation
pure. `useClarityReview.ts` owns ephemeral request/selection state, and
`ClarityPanel.tsx` is a controlled view. `App.tsx` owns bounded source playback.
Clarity and retake auditions have separate owners; clearing clarity review does
not stop ordinary playback or a retake audition.

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

Part 3 adds pure review, component, and App integration tests for explicit-only
requests, settings, hidden panels, local text/ranges/durations, empty/error states,
audition events, Discard/history/export isolation, cancellation, and input changes.
Build and lint passed; the full suite passed **1,392 tests across 63 files**,
including 81 new review/UI/integration tests.

A headless Chrome smoke check passed at 1480×1100 and 390×844, with screenshots
visually inspected. It exercised the live React UI with mocked media metadata/
playback, audio extraction, transcription, and model responses: explicit request
count, hidden-tab persistence, settings, original text, checkbox duration updates,
unmet target, bounded audition events, Discard, empty results, and unchanged Undo.
This was a UI check, not a real-media or live-model run.

Live-model proposal quality and real-recording playback remain unverified. Actual
media decoding, sentence-boundary sound, and encoded-output quality are not proved
by mocked browser or automated tests.

## Manual recording checklist (pending)

- Use a real rambling demo with setup, repeated detail, caveats, and a conclusion.
  Check that the model proposes useful removals and honors audience/must-stay
  settings; accept empty results when no useful cuts exist.
- Make earlier word/pause cuts, then analyze. Confirm fragmented sentences stay
  protected and neighboring retained words are not included in removal ranges.
- Audition multiple originals and pause/seek/Discard. Listen for accurate source
  boundaries and verify ordinary playback resumes normally.
- Change source, transcript, ranges, or settings during analysis. Verify obsolete
  advice never returns, and no background requests start on playback or tab changes.
- Keep hand-edited captions, overlays, audio settings, and dismissed retakes.
  Confirm review/Discard leave them and Undo unchanged; compare exported output
  before and after review.
- After the later preview/Apply step is implemented, verify temporary edited
  playback, one-step Undo, caption/overlay alignment, and the actual exported edit.
