# AI Clarity Edit — implementation notes

Parts 1–5 implement pure local sentence mapping, a bounded clarity-analysis API,
review/freshness guards, temporary edited preview, and applying selected cuts as
one undoable action. Analysis runs only on an explicit click.

## Using the Clarity tab

1. Load a video and transcribe it. Open **Clarity** in the inspector.
2. Optionally enter a target duration in seconds, an audience, and **What must
   stay?**. Click **Suggest clarity edits**.
3. Review each proposed sentence's exact local wording, original source time,
   reason, and explanation. **Play original** auditions that sentence and stops
   at its end. The regular transport also stops playback.
4. Toggle **Remove this sentence** to compare the locally calculated proposed
   duration. An unmet target is shown explicitly; no extra request forces it.
5. **Preview edited version** plays the selected cuts from the first kept range.
   **Stop preview**, pausing, or seeking returns to ordinary playback. Changing a
   selection also stops preview so you can preview the revised choices explicitly.
6. **Apply selected cuts** commits all selected removals together. One **Undo**
   restores the content from immediately before Apply.
7. **Discard** clears review and cancels pending analysis or active Clarity playback.

An empty proposal is a successful result. Deselecting every suggestion still
shows the returned cards, with zero selected. Oversized input is rejected with
the applicable limit, without sending a truncated recording for analysis.

The tab stays mounted while hidden, preserving draft settings and review state.
Analysis, selection, audition, edited preview, and Discard do not change editor content, Undo,
caption text, overlays, audio settings, retake workflow, or export inputs. The
proposed duration is calculated locally; export reads the committed edit even
during preview. Empty/deselected proposals cannot start edited preview or Apply.

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
entry, including when silence would remain. Apply revalidates freshness and
rebuilds actual local ranges synchronously before committing.

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
and draft-setting changes invalidate review and cancel analysis. Source replacement
resets draft settings. Caption, overlay, audio, and retake-only changes preserve
review. No cancellation starts a replacement request automatically.

### Local freshness and ownership

[`freshness.ts`](../src/clarity/freshness.ts) captures a detached, frozen snapshot of:

- Source ID, URL, and duration.
- Every original transcript word's exact text and start/end times, including
  deleted words that still determine sentence identities.
- Ordered kept source ranges, coalescing exactly adjacent structural splits.
- Raw target-duration, audience, and must-stay drafts. Even a whitespace-only
  draft change invalidates the review conservatively.

Freshness uses exact values, without hashes, rounding, or gap tolerances. Captions,
source display dimensions, and segment IDs do not affect this value comparison.
The snapshot stays local; it never expands the model's kept-speech payload.

The hook separately binds callbacks to the current mounted input session and
results to their originating request. It checks ownership and snapshot values
before starting a request, accepting success/failure, changing selection, or
returning an audition range. An old callback cannot start work after later input
changes or unmount. Returning to earlier settings does not revive previous advice.
Discard is scoped to its request so an obsolete control cannot clear newer advice.

Editor changes revoke ownership synchronously before dispatch. Async editing-agent
callbacks compare against the snapshot actually under review, rather than their
captured EDL. Layout-effect cleanup cancels obsolete work and stops its audition
before subsequent playback events; render also hides outcomes from another session.
Reference replacement of source, ranges, or transcript conservatively creates a
fresh session, even when values compare equal. Value checks additionally reject
accidental in-place changes before effects or another render.

Apply uses the same snapshot check synchronously, then validates selected ranges
again against the latest reducer state before its single history commit.

`review.ts` keeps draft validation, card mapping, and selected-duration calculation
pure. `useClarityReview.ts` owns ephemeral request/selection state, and
`ClarityPanel.tsx` is a controlled view. `App.tsx` owns bounded source playback.
Clarity and retake playback have separate owners; clearing clarity review does
not stop ordinary playback or a retake audition.

Only normalized text, IDs, eligibility, durations, and settings are sent to the
same-origin relay and then the model. Source URLs, filenames, raw media, actual
source ranges, editor content, and credentials are excluded from this request.

## Edited preview and Apply

[`edit.ts`](../src/clarity/edit.ts) shares pure edit derivation between preview and
Apply. It checks snapshot values, rebuilds the current catalog, validates the full
proposal and selected IDs, and resolves source ranges locally. Every selected cut
passes through `applyRemovedRange` in source order. Existing cuts remain intact;
protected sentences, unknown IDs, and all-speech removal are rejected. Empty or
unchanged derivations return the original EDL so they cannot create history.

Edited playback uses a temporary EDL and a token bound to the exact proposal and
selection. It forces that EDL's cuts while preserving the ordinary **Skip Cuts**
setting. Stop, pause/end, seek, selection changes, a new analysis, Discard, Apply,
source/input invalidation, or switching to an original/retake audition exits the
temporary mode. Old Stop callbacks and late playback failures cannot cancel newer
playback. Export, timeline, and transcript stay bound to committed content.
Captions and image overlays retain their current source-time content during preview.

Apply captures the current selected IDs and revokes the review's ownership to
prevent a double click from committing twice. The dedicated `apply-clarity` reducer
action revalidates and derives cuts against its latest EDL, preserving caption text
and any caption/overlay edits queued before Apply. It snapshots the latest content
once and preserves retake workflow and export settings. Captions are never
regenerated. A single Undo restores that pre-Clarity EDL and overlay content;
discarded advice does not return with Undo.

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

Part 4 adds 27 snapshot tests and 20 App lifecycle regressions. These cover exact
input changes, old callbacks after multiple changes/unmount, returning to prior
settings, late success/failure after cancellation, completed-proposal audition
cleanup, and preservation of newer review and caption edits. Build and lint passed;
the full suite passed **1,439 tests across 64 files**. The same desktop/mobile
Chrome smoke check also passed again with mocked media, transcription, and model
responses. Apply was not part of that step.

Part 5 adds 29 pure derivation tests, 12 component tests, and 32 App integration
regressions. Coverage includes selected/deselected cuts, existing gaps and protected
speech, temporary playback lifecycle, stale callbacks and queued media events,
freshness at Apply, queued caption/overlay edits, export isolation, no-op/double
Apply, and one-step Undo. `pnpm build` and `pnpm lint` passed; `pnpm test` passed
**1,512 tests across 65 files**.

A headless Chrome check passed at 1480×1100 and 390×844; both screenshots were
visually inspected. With mocked media metadata/playback, transcription, extraction,
and model responses, it verified temporary cut skipping, Stop, selection changes,
Discard, Apply, ordinary playback after Apply, and one-step Undo, with exactly
three explicit analysis requests and no runtime exceptions. These checks exercised
the actual React UI, including Strict Mode; they did not decode or listen to media.

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
- Preview selected cuts with **Skip Cuts** both on and off. Check playback starts
  at the first kept range, skips earlier and selected cuts, and stops at the final
  kept range. Check Stop, pause, seek, selection edits, and Discard restore ordinary
  playback without changing the saved edit or Undo.
- Make caption and overlay edits after analysis, then Apply multiple selections.
  Verify one Undo restores the pre-Clarity edit while preserving those prior edits,
  audio settings, and retake workflow. Export during preview and after Apply; verify
  the first uses committed cuts and the second includes accepted Clarity cuts,
  with aligned captions/overlays and synchronized audio in the encoded output.
