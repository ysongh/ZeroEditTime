# Phase 11 — Part Y performance and cost

Retake analysis remains an explicit **Check for retakes** action. Part Y removes
repeated local work from ordinary editor updates without changing detection
thresholds, model policy, request limits, source timing, or progress copy.

## Safeguards and evidence

| Requirement | Implementation and regression evidence |
| --- | --- |
| No automatic retake model calls | [App.tsx](../src/App.tsx) calls the batch only from the explicit panel action. [App.test.tsx](../src/App.test.tsx) exercises mounted effects, playback, transcript deletion, overlay edits, EDL changes/Undo, captions, and the real Export button callback without starting retake analysis. Transcription/encoding and model transport remain mocked. |
| No repeated screening on playback/edit renders | App memoizes current advice by immutable transcript and recommendation-list identities, then memoizes open advice. With no advice it skips freshness screening entirely. Tests use call-through spies and 30 playhead updates, edits, selection, export, and progress updates to verify reuse; new transcript text or advice invalidates it. |
| Fast local candidate screening | [nearbyTakes.ts](../src/retakes/nearbyTakes.ts) shares one sentence index across a suppression pass and inspects at most four neighboring sentence positions per candidate. Valid ordered, non-overlapping transcripts reuse each sentence's words; unusual timings/custom bounds retain full-word filtering. [nearbyTakes.test.ts](../src/retakes/nearbyTakes.test.ts) checks one grouping pass for 300 candidates, no full-word filter on that fast path, no network, fallback equivalence, and no stale cross-call index. |
| No work for already-cancelled runs | [batchAnalysis.ts](../src/retakes/batchAnalysis.ts) checks the abort signal after cheap input validation and before screening/cache creation. Its regression proves no local screening, cache creation, progress, or fetch. |
| Bounded model cost | Existing [costControls.ts](../src/retakes/costControls.ts) caps a run at 10 selected candidates and 2 concurrent requests, deduplicates overlapping candidates, and retains at most 50 validated results in a page-session LRU cache. Existing batch/cost tests cover zero-request cases, reuse, caps, and selective retries. |
| Bounded context | Existing [context.ts](../src/retakes/context.ts) limits candidate text to 120 words/1,200 characters; each adjacent sentence to 40/400; and each of at most two alternate windows to 80/800. Browser and relay validation enforce the envelope. No recording bytes are sent for retake analysis. |
| Useful progress, no token counters | Existing [RetakesPanel.tsx](../src/retakes/RetakesPanel.tsx) displays checked sections out of the selected total, including settled failures, and distinguishes partial results/errors from clean success. Its tests cover progress, accessible status, and the disabled running button. No raw token counts are displayed. |

The memo is only a render optimization. Freshness still validates source evidence
when its inputs change, and the existing latest-request/cancellation guards still
control asynchronous results. No global transcript index, persistent cache,
background analysis, worker, or new dependency was added.

## Local screening measurement

An offline Node/Vite SSR measurement on the development machine used 300 and 600
ten-word filler-heavy sentences (3,000 and 6,000 words). Each sentence used the
test fixture's dashboard wording with three fillers and a distinct final word;
words were 0.25 seconds apart, 0.2 seconds long, with sentence starts ten seconds
apart. All sentences remained candidates before and after the optimization.

Only `buildScreenedRetakeCandidates` was timed with `performance.now()`; Vite module
loading was excluded. One invocation per size in fresh processes produced:

| Words / retained candidates | Before (ms) | After (ms) |
| --- | --- | --- |
| 3,000 / 300 | 349.65 | 31.33 |
| 6,000 / 600 | 805.98 | 49.11 |

These are illustrative single-run observations, not a browser latency guarantee,
statistical benchmark, model latency measurement, or proof that the entire
pipeline is linear. Other detector/signal/context processing still scales with
transcript size. CI verifies deterministic work counts and behavior instead of
fragile wall-clock thresholds.

Run the focused regressions with:

```bash
pnpm exec vitest run src/App.test.tsx src/retakes/nearbyTakes.test.ts src/retakes/batchAnalysis.test.ts src/retakes/costControls.test.ts src/retakes/RetakesPanel.test.tsx
```

## Browser follow-up (not run)

On a real recording, use the [manual setup](phase-11-manual-verification.md#setup-and-evidence)
and record browser/version, commit, source duration/word count, and a performance
trace. Check playback, edits, and export before and after obtaining advice. Verify
that these actions create no retake-mode `/api/agent` requests, then explicitly
check for retakes and observe section progress. Distinguish ordinary editing-agent
requests and transcription uploads from retake requests.

Record observed responsiveness or long tasks and their reproduction steps; do not
infer a browser pass from the offline timing table. Real-recording quality checks
from Part X and the separate Part Z backward-compatibility review remain pending.
