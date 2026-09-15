# Phase 11 — Part W test coverage

This maps the specification's 75 checks to offline Vitest evidence. Run `pnpm test`
from the repository root; `pnpm lint` and `pnpm build` check the test and application
code together. Network/model responses, transcription, clipboard, and media loading
are mocked wherever invoked. Proxy tests live in `netlify/agent.test.ts`, outside
the deployed functions directory.

The coverage below includes earlier parts and the Part W additions. It does not
claim live-model accuracy, browser accessibility, playback/encoding quality, or
verification with real recordings. Use the [Part X manual checklist](phase-11-manual-verification.md)
to record those real-world observations separately.

## Candidate generation and context

| Check | Evidence |
| --- | --- |
| 1. Clean sentence | [heuristics.test.ts](../src/retakes/heuristics.test.ts): clean speech/punctuation-only case. |
| 2. Single filler | Same suite: one filler or two fillers at high density remain unflagged. |
| 3. Dense fillers | Same suite: inclusive three-fillers/30-percent threshold. |
| 4. Internal hesitation | Same suite: full source-time gap inside a sentence. |
| 5. Paragraph pause | Same suite: long inter-sentence pause does not trigger hesitation. |
| 6. Severe stumble | Same suite: two stumble markers in one sentence. |
| 7. Repeated failed attempts | Same suite: retained attempts without an invented score. |
| 8. Nearby clean take | [nearbyTakes.test.ts](../src/retakes/nearbyTakes.test.ts): clean following sentence suppresses the failed take. |
| 9–12. Source timing, ordering, purity, optional confidence | [candidates.test.ts](../src/retakes/candidates.test.ts): full-sentence source milliseconds, chronological identities, fresh immutable outputs, absent-data guards. |
| 13. Candidate wording | [context.test.ts](../src/retakes/context.test.ts): exact payload with adjacent sentences. |
| 14–15. Bounded before/after | Same suite: closest edges of oversized surrounding context. |
| 16. Nearby takes | Same suite: bounded speech across an intervening sentence and alternate text/range preservation. |
| 17. Exclude unrelated transcript | Same suite: adjacent-window test plus Part W's screening → context → normalization test with distant private-text sentinels. |
| 18. Preserve source timestamps | Same suite: exact payload and Part W pipeline preserve candidate/alternate milliseconds through request validation. |

Part W's long-transcript pipeline case also checks omitted optional confidence and
unchanged transcript/candidate inputs. [contextValidation.test.ts](../src/retakes/contextValidation.test.ts)
separately exercises all request text/word/alternate caps and field whitelists.

## Response validation and normalization

| Check | Evidence |
| --- | --- |
| 19. Valid positive | [analysis.test.ts](../src/retakes/analysis.test.ts): fresh, trimmed, whitelisted positive; [agent.test.ts](../netlify/agent.test.ts): valid positive relayed without model-forged timing/workflow fields. |
| 20. Negative decision | [analysisApi.test.ts](../src/retakes/analysisApi.test.ts): exact negative result with recommendation-only fields removed. |
| 21–23. Missing reason, severity, confidence | [analysis.test.ts](../src/retakes/analysis.test.ts): missing/unknown enum and malformed-confidence matrices; finite confidence clamps to 0–1. |
| 24. Invalid timestamps | [recommendation.test.ts](../src/retakes/recommendation.test.ts): malformed/non-finite/empty source-range matrices. Model analysis owns no timestamps; Part W also asserts forged timing is discarded. |
| 25–26. Unknown reason and extra fields | Same recommendation suite and [analysis.test.ts](../src/retakes/analysis.test.ts): enum rejection, exact whitelists, locally owned IDs. |
| 27–28. Malformed JSON and empty replies | [analysisApi.test.ts](../src/retakes/analysisApi.test.ts) and [agent.test.ts](../netlify/agent.test.ts): controlled browser/proxy failures, including Part W's malformed browser JSON and empty successful model body. |
| 29. Sort | [recommendations.test.ts](../src/retakes/recommendations.test.ts): canonical source order independent of input order. |
| 30. Identical duplicate | Same suite: deduplication and regenerated local identity. |
| 31. Overlapping duplicates | Same suite: specification example, exact thresholds, stable overlap-bridge merging. |
| 32. Unrelated spans | Same suite: touching, gapped, and incompatible issue families stay separate. |
| 33. Strongest severity | Same suite: independent severity/copy preservation and every severity level. |
| 34. Confidence | Same suite: finite confidence clamps, non-finite confidence fails. |
| 35–36. Invalid/empty ranges and source bounds | Same suite: ranges empty after normalization are removed and source bounds enforced. |
| 37. Purity | Same suite: deep-fresh outputs, provenance copies, and unchanged inputs. |

## Clean-take decisions

| Check | Evidence |
| --- | --- |
| 38. Failed then clean | [nearbyTakes.test.ts](../src/retakes/nearbyTakes.test.ts): following clean sentence and internally repaired chained starts. [batchAnalysis.test.ts](../src/retakes/batchAnalysis.test.ts): local suppression never reaches the transport. |
| 39. Repeated failures without a clean take | Nearby-take tests retain incomplete/dirty attempts; batch tests carry positive mocked decisions into source-timed recommendations. This proves routing, not live semantic accuracy. |
| 40. Clean take before failure | Nearby-take suite: checks preceding and following speech. |
| 41. Unrelated nearby sentence | Nearby-take suite: unrelated speech cannot establish a clean alternative. Neighboring speech may still be supplied as bounded context for model judgment. |

## State, UI, and API behavior

| Check | Evidence |
| --- | --- |
| 42. Idle defaults | [editorState.test.ts](../src/retakes/editorState.test.ts): backward-compatible defaults; [App.test.tsx](../src/App.test.tsx): document initialization/reset. |
| 43–46. Progress, cards, empty success, errors | [RetakesPanel.test.tsx](../src/retakes/RetakesPanel.test.tsx) and App regressions: controlled rendering, partial/all-failure outcomes, successful-empty provenance. |
| 47–48. Dismiss/resolve | State reducer tests and App's panel action regression: exact stored status, open-only cards/markers. |
| 49. Copy | App regression: exact clipboard text, success, rejection, stale copy suppression; panel suite checks associated announcements. |
| 50–51. Source Play/seek and EDL isolation | App regression: bounded original-source preview inside an actual removed range, marker select/seek, unchanged EDL/history. |
| 52. Dismiss preserves transcript | Part W strengthens App's panel action test with deep transcript comparison and the actual TranscriptView prop after dismiss, resolve, copy, and outcomes. |
| 53. Source-time marker | [RetakeTimelineTrack.test.tsx](../src/retakes/RetakeTimelineTrack.test.tsx): source percentages/endpoints and exact callback; App verifies seeking in a removed source interval. |
| 54. Open count | Panel suite excludes dismissed/resolved cards and distinguishes zero-open from successful-empty. |
| 55. No candidates, no request | [batchAnalysis.test.ts](../src/retakes/batchAnalysis.test.ts): zero-analyzer tests plus Part W's default API adapter test with a fetch spy. |
| 56. Candidate cap | [costControls.test.ts](../src/retakes/costControls.test.ts): prioritize then cap; batch suite verifies worker/candidate limits and actual relay request count. |
| 57. No duplicate requests | Cost selector overlap tests; Part W's batch test injects duplicate candidate envelopes, observes one fetch, then reruns unchanged input with a fresh abort signal and observes a cache hit. |
| 58. Partial recovery | Batch suite retains valid siblings; Part W's real decoder/default adapter test rejects an invalid severity, preserves valid advice, retries only the failed candidate, and caches both positive/negative successes. |
| 59. Stale requests | App's Part U test covers older completion while newer work is pending and lock ownership; Part W adds old success/error after newer completion, including late progress and preservation of successful-empty state. |
| 60. Server-only credentials | [analysisApi.test.ts](../src/retakes/analysisApi.test.ts): secret-free same-origin request; [agent.test.ts](../netlify/agent.test.ts): server-owned configuration, authentication, and error redaction. |
| 61. No raw video payload | Part W strengthens the browser/proxy exact-payload tests with raw-byte, video-base64, and frame sentinels that must be absent upstream. |
| 62. Necessary transcript context only | Browser/proxy whitelist tests, context cap tests, and the long-transcript pipeline regression. |

## Existing editor and export regressions

| Check | Evidence |
| --- | --- |
| 63. AI editing | [run.test.ts](../src/agent/run.test.ts) threads a working EDL through mocked tool turns; [agent.test.ts](../netlify/agent.test.ts) preserves the editing relay mode. |
| 64. Range subtraction | [edl.test.ts](../src/edl/edl.test.ts): existing `applyRemovedRange` math/purity cases. |
| 65. Transcript editing | [App.test.tsx](../src/App.test.tsx): transcript deletion, captions, and Undo share one EDL. |
| 66–68. Silence/filler/stumble removal | [detect.test.ts](../src/agent/detect.test.ts) and [tools.test.ts](../src/agent/tools.test.ts): existing detector thresholds and pure EDL executors; run tests cover tool dispatch. |
| 69. Captions | [captions.test.ts](../src/captions/captions.test.ts), caption component suites, App, and export wiring tests. |
| 70. Image overlays | [renderPlan.test.ts](../src/overlays/renderPlan.test.ts), [imageOverlays.test.ts](../src/export/imageOverlays.test.ts), overlay editor/preview/timing suites, and export handoff. |
| 71. Audio-cleanup export | [phase10.integration.test.ts](../src/export/phase10.integration.test.ts), [ffmpeg.test.ts](../src/export/ffmpeg.test.ts), runtime and ExportButton suites preserve cleanup graph, fallback, and orchestration behavior. |
| 72. Recommendations preserve export | Part W's strengthened App action test carries actual ExportButton props through real pure caption, overlay, and audio-cleanup export builders and compares the complete argument array. |
| 73. Duration | Same App test fixes a 5.5-second kept duration and checks it across analysis, source preview/seek, copy, resolution, dismissal, and failure. |
| 74. Caption timing | Same test retains an authored caption across an EDL cut and compares source data, output timing, and generated SRT. |
| 75. Overlay timing | Same test retains an authored overlay across a cut and compares source data, both projected pieces, fades, and the resulting export graph. |

Existing tests continue to run as part of the full suite. Export checks above use
pure builders and mocked runtime boundaries; they do not encode media or substitute
for listening to and viewing a real exported recording.
