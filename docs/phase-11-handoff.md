# Phase 11 — AI retake recommendations handoff

Parts A–Z implement and test advisory retake recommendations. The Part Z changes
are compatibility regression coverage and this handoff; they do not add a new
editor feature or change production behavior. Final automated checks are recorded
below. Browser, real-recording, and live-model quality verification remain unrun.

## Files changed

Full Phase 11 inventory relative to the last Phase 10 commit, `bbfe3dd`.
Each paired test file covers the production boundary listed alongside it.

| Created or modified files | Purpose |
| --- | --- |
| [CLAUDE.md](../CLAUDE.md) | Phase-by-phase architecture, constraints, completion/verification status. |
| [phase-11-test-coverage.md](phase-11-test-coverage.md) | Maps all 75 Part W checks to offline evidence. |
| [phase-11-manual-verification.md](phase-11-manual-verification.md) | Unexecuted real-recording/browser checklist and result ledger. |
| [phase-11-performance.md](phase-11-performance.md) | Performance/cost safeguards, offline timings, unrun browser follow-up. |
| [phase-11-handoff.md](phase-11-handoff.md) | Final architecture, compatibility, contracts, evidence, and limitations. |
| [App.tsx](../src/App.tsx), [App.test.tsx](../src/App.test.tsx) | Advisory state, explicit analysis, cancellation, freshness, playback/workflow, memoization, and integration regressions; Part Z extends compatibility tests. |
| [api.ts](../src/agent/api.ts), [api.test.ts](../src/agent/api.test.ts) | Shared same-origin relay transport and error validation. |
| [run.ts](../src/agent/run.ts) | Existing editing-agent loop reuses the shared transport while retaining its request contract. |
| [detect.ts](../src/agent/detect.ts) | Exports existing speech-token normalization for local retake reuse; detector policy unchanged. |
| [agent.ts](../netlify/functions/agent.ts), [agent.test.ts](../netlify/agent.test.ts) | Existing relay gains a discriminated retake mode, server-owned prompt/tool, request/result validation, and mocked tests outside the deployed functions directory. |
| [index.css](../src/index.css) | Scoped retake focus styles and screen-reader-only text. |
| [recommendation.ts](../src/retakes/recommendation.ts), [recommendation.test.ts](../src/retakes/recommendation.test.ts) | Source-time recommendation model and defensive normalization. |
| [candidates.ts](../src/retakes/candidates.ts), [candidates.test.ts](../src/retakes/candidates.test.ts) | Sentence candidates and aggregated local evidence. |
| [heuristics.ts](../src/retakes/heuristics.ts), [heuristics.test.ts](../src/retakes/heuristics.test.ts) | Conservative signal thresholds. |
| [nearbyTakes.ts](../src/retakes/nearbyTakes.ts), [nearbyTakes.test.ts](../src/retakes/nearbyTakes.test.ts) | Nearby clean-take suppression, context windows, and per-pass index optimization. |
| [context.ts](../src/retakes/context.ts), [context.test.ts](../src/retakes/context.test.ts), [contextValidation.test.ts](../src/retakes/contextValidation.test.ts) | Bounded transcript payload construction and runtime request validation. |
| [analysis.ts](../src/retakes/analysis.ts), [analysis.test.ts](../src/retakes/analysis.test.ts) | Structured model-result union, whitelisting, and forced-tool extraction. |
| [analysisApi.ts](../src/retakes/analysisApi.ts), [analysisApi.test.ts](../src/retakes/analysisApi.test.ts) | One-candidate browser API, 30-second timeout, and caller cancellation. |
| [batchAnalysis.ts](../src/retakes/batchAnalysis.ts), [batchAnalysis.test.ts](../src/retakes/batchAnalysis.test.ts) | Explicit local-to-model orchestration, provenance, progress, partial failure, and cancellation. |
| [costControls.ts](../src/retakes/costControls.ts), [costControls.test.ts](../src/retakes/costControls.test.ts) | Deduplication, priority/caps, bounded page-session result cache. |
| [freshness.ts](../src/retakes/freshness.ts), [freshness.test.ts](../src/retakes/freshness.test.ts) | Local transcript fingerprints and fail-closed stale-advice filtering. |
| [recommendations.ts](../src/retakes/recommendations.ts), [recommendations.test.ts](../src/retakes/recommendations.test.ts) | Plural normalization, compatible-overlap merging, source ordering, provenance union. |
| [editorState.ts](../src/retakes/editorState.ts), [editorState.test.ts](../src/retakes/editorState.test.ts) | Empty/idle defaults and immutable advisory lifecycle/workflow state. |
| [RetakesPanel.tsx](../src/retakes/RetakesPanel.tsx), [RetakesPanel.test.tsx](../src/retakes/RetakesPanel.test.tsx) | Cards, explicit action, humane severity, scripts/copy, dismiss/resolve, progress/errors, accessibility. |
| [RetakeTimelineTrack.tsx](../src/retakes/RetakeTimelineTrack.tsx), [RetakeTimelineTrack.test.tsx](../src/retakes/RetakeTimelineTrack.test.tsx) | Source-time markers and ephemeral selection/seek. |
| [sourceTime.ts](../src/retakes/sourceTime.ts), [sourceTime.test.ts](../src/retakes/sourceTime.test.ts) | Compact visual clocks and precise spoken source ranges. |

No Phase 11 changes were required in the EDL math, captions, overlays, audio-cleanup
or encoding modules. Their existing suites remain in the full regression run.

## Architecture

1. An explicit panel action runs local filler, silence, and stumble detection,
   groups evidence by sentence, and keeps only strong candidates.
2. Local screening removes provably repairable restart chains and exact nearby
   clean takes. A shared per-call sentence index avoids rebuilding the entire
   transcript for each candidate; unusual timing retains the safe filter path.
3. Candidate selection deduplicates, prioritizes, and caps the work. Context
   construction supplies only bounded candidate/adjacent/nearby speech and signals.
4. The browser validates that envelope and sends it to the existing stateless
   relay. The relay validates again, injects its prompt and forced result tool,
   and calls the configured Claude model. It executes no editing tools in this mode.
5. Relay and browser reconstruct a validated model result. The client supplies
   original candidate timing, deterministic identity/title, evidence, and local
   provenance, then normalizes/merges the recommendation collection.
6. Advisory state sits beside EDL/overlay content, outside content Undo snapshots.
   It defaults to `retakeRecommendations: []` and `retakeAnalysisStatus: "idle"`.
   Only current, open advice is actionable. Analysis failures preserve or replace
   advice according to full-failure/partial-success policy, never by editing media.
7. Card **Play** auditions its original-source range, including cut speech, and
   pauses at the end. Marker clicks select/seek without starting bounded playback.
   Ordinary playback subsequently resumes EDL skipping. Source/advice changes
   revalidate freshness; ordinary editing/playhead updates reuse that derivation.

Every active run has an abort controller and latest-request identity guard. Source
or transcript replacement invalidates older progress/results even if a transport
ignores cancellation. Source ranges are half-open milliseconds; conversion to the
player's seconds happens at navigation, never through the shortened output clock.

## AI request shape

Example sanitized browser request to `POST /api/agent`:

```json
{
  "mode": "retake-analysis",
  "context": {
    "candidate": {
      "startSourceMs": 41000,
      "endSourceMs": 44900,
      "text": "The dashboard lets you um manage uh all er projects..."
    },
    "before": { "text": "Here is how project management works." },
    "after": { "text": "Next, let us look at settings." },
    "signals": {
      "fillerCount": 3,
      "fillerDensity": 0.3,
      "longPauseCount": 0,
      "longestPauseMs": 0,
      "stumbleCount": 0
    }
  }
}
```

Optional `nearbyAlternateTakes` contains at most two `{ startSourceMs, endSourceMs,
text, truncated? }` windows. Clipped text is marked with `[content omitted]` and
`truncated: true`. Candidate text is capped at 120 words/1,200 characters; each
adjacent sentence at 40/400; each alternate at 80/800. Unavailable confidence and
repeated-attempt scores are omitted, not fabricated. Character caps use JavaScript
string length (UTF-16 code units), not UTF-8 upload bytes.

The model receives the normalized `context` as JSON in one user message, plus a
server-owned editing-first system instruction and `submit_retake_analysis` tool
schema. The relay configuration in this repository is `claude-sonnet-4-6`, a
1,024-output-token limit, and forced single-tool selection with parallel tool use
disabled. Browser-supplied model/prompt/tool overrides are not forwarded.

No raw audio, raw video, frames, source URL, or filename is sent by retake analysis.
There is no separate whole-transcript upload: bounded excerpts can still cover
all speech in a short recording. Separate **Transcribe** uploads extracted audio
through the existing Whisper proxy; it is not part of a retake-analysis request.

## AI output schema

The validated result is a discriminated union:

```ts
type RetakeAnalysisResult =
  | {
      needsRetake: false
      confidence: number
      explanation?: string
    }
  | {
      needsRetake: true
      reason: RetakeReason
      severity: 'suggestion' | 'recommended' | 'strongly-recommended'
      explanation: string
      suggestedScript?: string
      confidence: number
    }
```

Allowed reasons are `no-clean-take`, `incomplete-thought`,
`repeated-failed-takes`, `severe-stumble`, `unclear-explanation`,
`excessive-fillers`, `long-hesitation`, `audio-quality`, and
`low-transcription-confidence`. The last two require reliable evidence under
the prompt policy; no such local detection signal is currently supplied.

Finite confidence is clamped to 0–1. A positive decision requires a known reason,
known severity, and nonblank explanation. Optional blank scripts are omitted.
Negative decisions discard positive-only fields. Unknown fields, model-authored
timestamps/IDs/workflow, ambiguous tool responses, and malformed results cannot
become trusted recommendation metadata. Structural validation does not establish
that an explanation or script is factually correct.

## Candidate rules

| Rule | Implemented policy |
| --- | --- |
| Filler cluster | At least three detected filler occurrences AND occurrence density at least 0.30 within one sentence. |
| Long hesitation | Full internal pause strictly greater than 2,000 ms in a sentence with at least five valid timestamped words. Paragraph gaps alone do not qualify. |
| Stumble severity | At least two existing detector stumble spans in one sentence. One removable stumble is ordinary editing. |
| Repeated attempts | Reuses actual detected restart/stumble spans; no invented separate score or punctuation-only semantic trigger. |
| Candidate window | One full sentence envelope in original source time, with immediate adjacent context; model excerpts have the caps above. |
| Nearby clean take | At most two sentence positions away and within three seconds, searching before/after; exact full cleaned wording, not generic shared openings or paraphrases. A clean take requires at least four content words, terminal sentence punctuation after filler removal (excluding ellipsis/trailing dash), at most one filler, no detected stumble, and no pause over two seconds. |
| Internal repair | Only a contiguous opening chain of substantial four-word detector-linked restarts whose final take is clean after projected cuts. |
| Candidate cap | Ten strongest deduplicated candidates per explicit run, analyzed in source order. |

Intentional limits/deviations: this is transcript screening, not an exhaustive
semantic pass over every sentence. Incomplete thoughts without strong local
signals can be missed. Whisper may normalize away the spoken evidence. No measured
audio-quality or confidence detector was added. Semantic clean alternatives are
left to bounded model judgment instead of guessed locally.

## Cost controls

- At most 10 selected candidates, one candidate per request, at most 2 requests
  in flight; no multi-candidate server protocol or background checking.
- Local pre-request deduplication keeps stronger candidates when overlap is at
  least 80% of the shorter range. Final advice is separately normalized and
  compatible overlaps merged conservatively.
- Up to 50 validated positive/negative decisions are reused in a page-session
  LRU cache, keyed by versioned bounded context and captured source provenance.
  Failed candidates are not cached; unchanged successful siblings can be reused
  when the user retries. Cache reuse does not replace current-transcript checks.
- A 30-second client deadline isolates an individual request failure. Already
  cancelled work skips screening; in-flight cancellation stops new queued work
  and excludes late cache/progress/result writes.
- No retake model calls on page load, playback, transcript/overlay/EDL edits, or
  export. Progress reports settled sections, including failures, not raw tokens.

## Backward compatibility (Part Z)

The supported legacy boundary is a fresh local-file session and existing EDL,
caption, overlay, and content-history data without retake fields. The constructor
provides empty/idle advisory defaults. No project save/load format exists, so this
is not a claim of persisted-project migration or cross-version hot-state hydration.

Content Undo snapshots contain only EDL and overlay content. Advice added,
dismissed, or resolved afterward stays current across Undo and a delayed editing
agent commit; it is not resurrected from an old snapshot. Replacing the source
uses the document-reset path and returns advisory state to safe defaults. The
editor's **Reset** button only resets editing content and preserves source advice.

Export receives only the source file, EDL segments, prepared captions, projected
overlays, and audio-cleanup plan. It has no retake parameter or import. Part W
compares real pure export filter/caption/overlay preparation before and after
advisory actions; Part Z additionally exercises the Export button's actual encode
handoff with non-default cleanup across absent/open/closed/error advice. These
tests protect source identity, removed/kept ranges, transcript, captions,
overlays, cleanup intent, duration, and filter inputs. They do not encode or
compare actual output videos; that remains a manual verification requirement.

## Tests

Final Part Z checks performed:

- `pnpm test`: 50 test files, **937 tests passed**.
- TypeScript: passed through `pnpm build` (`tsc -b`).
- `pnpm lint`: passed.
- `pnpm build`: production build passed.
- `git diff --check`, new-document whitespace checks, and local documentation
  link-target/inventory checks: passed.

Part Z adds three App test cases (dismissed/resolved legacy-history permutations
and one five-state export-handoff comparison) and strengthens the existing
empty-defaults test with missing-field and independent-array assertions.

Earlier suites cover model/normalization boundaries, candidate/clean-take rules,
payload limits, cost/freshness, partial failure/cancellation, UI/controller
behavior, and existing editor/agent/export regressions. Part Z adds focused
legacy-history and encoder-handoff compatibility checks, rather than changing
the production editing or export logic. See the [coverage matrix](phase-11-test-coverage.md).

## Manual verification

- Automated: offline Vitest and static/build checks only; network/model, media
  decoding, clipboard, and encoding boundaries are mocked where invoked.
- Browser/screen reader actually verified: not run.
- Live Claude/transcription behavior actually verified: not run.
- Real-recording playback, listening, and actual output video comparison: not run.
- Still required: complete the [recording checklist](phase-11-manual-verification.md)
  and [browser performance follow-up](phase-11-performance.md#browser-follow-up-not-run),
  recording failures and blocked checks rather than inferring a quality pass.

## False-positive behavior

Weak isolated signals do not create candidates. Exact nearby clean takes and
provably repairable restart chains are suppressed locally. The model is instructed
to prefer editing, preserve a usable alternate take, and reject advice motivated
only by ordinary fillers/pauses, mild noise, conversational grammar, or accents.
Scripts must preserve supplied meaning, terms, and personal style, without
invented capabilities; they remain optional when a faithful completion is unclear.

These are implemented safeguards, not measured accuracy claims. In particular,
**No retakes recommended** can mean no locally selected candidates, not that the
model reviewed or listened to the whole recording. Closing all cards instead
shows **0 open recommendations.**; partial failure is never clean success.

## Privacy

During retake analysis, only bounded transcript text, source-millisecond ranges,
and selected heuristic signals leave the browser for the same-origin Netlify
relay, then Claude. The relay owns its credentials; no API secret is included in
the browser bundle/request. Fingerprints, workflow status, EDL, captions, overlays,
cleanup settings, and raw media are not included in that request. Context and
cached results remain in page memory, not a new persistence or telemetry store.

Existing transcription uploads extracted audio separately. Existing engine/font
downloads and normal browser transport metadata are not eliminated by Phase 11.
Do not treat local-first editing as a promise that AI transcript evidence stays
on the device or that the upstream service retains no data.

## Limitations

- No re-recording capture, upload, replacement/insertion, or automatic editing.
  **Mark as re-recorded** only changes advisory status.
- No project persistence, cross-device history, explicit Cancel button, automatic
  retry loop, or full-transcript semantic/audio analysis.
- Detection depends on transcription wording/timing and sentence punctuation;
  local matching reuses the existing English-oriented token/filler rules.
- Ten-candidate and context caps can leave other problems unreviewed. Cache and
  fingerprinting preserve consistency, not semantic correctness.
- Confidence is model-reported, not calibrated accuracy. Invalid structure is
  rejected, but hallucinations or unsupported scripts still require human review.
- Source Play uses normal browser media events; exact audible/frame-boundary
  behavior, accessibility, latency, and output video parity await manual checks.

## Suggested next step

Run a real-recording release-validation pass using the existing Phase 11 checklist,
then address the observed failures before starting another feature phase.
