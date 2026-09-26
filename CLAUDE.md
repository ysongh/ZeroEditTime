# Zero Edit Time — repository guidance

Zero Edit Time is a browser-based, non-destructive video editor built with React 19, TypeScript, Vite 8, Vitest, Netlify Functions, and `ffmpeg.wasm`. Editing, preview, audio extraction, and export run in the browser. Netlify Functions proxy transcription and Claude requests so API keys stay on the server.

## Current state and scope

- Phases 0–6, 8, 9A, 10, and 11 are implemented. The intermediate phases 2.5, 4.5, and 5.5 are also complete. Phase 11 ends at Part Z; no next feature phase has been specified.
- Phase 11 retake recommendations are advisory. The automated suites and handoff are complete, but real-recording, browser, live-model quality, and actual-output verification are still pending. Do not describe those checks as passed.
- Implement only the task or phase currently requested. Do not scaffold future phases or add speculative dependencies.
- Save/load is deferred. Caption timing edits, caption add/delete/split/merge, styling UI, SRT import, an agent tool for editing caption text, and karaoke timing remain outside the existing scope unless explicitly requested.

## Commands and tooling

Use **pnpm** only; do not use npm or yarn.

```bash
pnpm dev      # Vite development server
pnpm build    # TypeScript build and Vite production build
pnpm lint     # ESLint
pnpm test     # Vitest, run once
pnpm preview  # Preview production build
```

Use `netlify dev` for local end-to-end transcription and agent requests. Keep `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in the functions' environment, never in client code. Run `pnpm build` and relevant `pnpm test` suites for code changes; use real browser/media checks when behavior cannot be proved by offline tests. Keep Vitest tests outside `netlify/functions/` so Netlify does not bundle them as functions.

Use strict TypeScript and avoid `any`. Keep the existing toolchain configuration; do not reinitialize the project. Add dependencies only when the requested work actually needs them. There is no UI or styling framework.

## Architecture invariants

### EDL and editor state

- The Edit Decision List (EDL) is the source of truth for kept video. Its segments use **source seconds**. Preserve the original media; cuts update the EDL and do not encode until export.
- Keep EDL math pure, immutable, and React-free in `src/edl/`. All removals, including trim, transcript deletions, and agent cuts, go through `applyRemovedRange`. Derive deleted-word styling from `isSourceTimeKept`; do not store a second deleted-word flag.
- Persistent content edits pass through `App.tsx`'s editor reducer/history. EDL, captions, overlay assets, and overlay layers share one Undo history. Each user action or agent run should commit once. Ephemeral selection does not enter Undo. Apply asynchronous EDL commits to the latest editor state.
- Source replacement resets the document. Manage source and overlay blob URLs so they remain valid while referenced by current state or Undo history, then revoke them when unreachable.

### Agent and transcription

- `netlify/functions/transcribe.ts` proxies extracted audio to Whisper and returns word timings. `src/transcript/extractAudio.ts` uses the shared FFmpeg engine to make small mono 16 kHz audio before upload; its MP3 path has a WAV fallback.
- `netlify/functions/agent.ts` is a **stateless relay** to Claude. It owns the server-side prompt/tool schemas and never executes tools, stores an EDL, or computes edits. The client loop in `src/agent/run.ts` executes pure tools against a working EDL and commits the whole command once. Compute reported counts and durations client-side; model text is narration.
- Preserve the shared `/api/agent` transport's editing mode and retake-analysis mode. Validate unknown input and model results at their respective boundaries; send bounded text context, not raw media or credentials, for retake analysis.

### Time bases and overlays

- Captions in `edl.captions` use **source seconds**, derive from kept transcript words, and are undoable. `prepareCaptionsForExport` re-clips them against the current EDL and maps them to **output time**. Preview uses source time. Caption text edits use `updateCaptionText`; a no-op must not create an Undo entry. SRT download and the burn toggle use the same prepared captions.
- Still-image overlays use source-time ranges in **milliseconds** and normalized in-frame geometry. Keep their projection through cuts, layer order, opacity/fades, and preview/export behavior consistent. Overlay assets use local blob URLs and are committed with overlay content to the shared history.
- Retake recommendations use half-open **original-source milliseconds**, never output time. They do not modify the EDL, captions, overlays, audio settings, export, or content Undo. Dismiss/resolve state survives content Undo and Reset; source replacement clears it. Show only advice proven current for the transcript.
- Retake analysis runs only after an explicit user action. Preserve local candidate screening, bounded model context, strongest-ten selection, at most two concurrent candidate requests, page-session cache, per-candidate failure isolation, and latest-request ownership/cancellation. Do not let a superseded request update UI state or cache.

### FFmpeg and export

- `src/ffmpeg/engine.ts` owns **one** shared `FFmpeg` instance for extraction and export. Construct it lazily, never at module import, so pure helpers remain importable in Node tests. Load the pinned, single-threaded **ESM** `@ffmpeg/core` from the CDN; share overlapping load requests and allow retry after failed preloads. Do not introduce another FFmpeg instance or bundle the core.
- `src/export/ffmpeg.ts` builds pure, testable export arguments from kept EDL segments. Export reads editor state and re-encodes client-side; it must not mutate the EDL. Keep audio/video PTS aligned through segment trim and concat, with captions and overlays projected onto the output clock. The font in `public/fonts/` is a committed asset for caption burn.
- Audio cleanup is export-time only. Settings normalize to a pure plan; the master-off path preserves the legacy command. Keep the established filter order: segment trim/PTS reset and short fades, concat, optional denoise, optional voice compression, optional loudness normalization, 48 kHz resample, optional final limiter. Preserve one processed audio mapping when audio exists and a video-only path for sources without audio.
- Retry only precisely recognized missing optional filters, no-source-audio, or silent-loudness failures. Report degraded successes visibly; treat unrelated encode failures as fatal. Clean staged VFS files even on failure. Do not add a Cancel control without centralized ownership/serialization of the shared FFmpeg engine.
- Keep `public/_headers` COOP/COEP headers. The current single-threaded export works under plain `pnpm dev` and does not require cross-origin isolation.

## Where to work

| Area | Primary files/directories |
| --- | --- |
| Editor state, playback, history, source replacement | `src/App.tsx`, `src/Timeline.tsx` |
| Pure EDL math | `src/edl/` |
| Transcript display, grouping, upload and extraction | `src/transcript/` |
| Editing agent, detectors, client tool loop | `src/agent/` |
| Caption generation, text edits, preview, SRT | `src/captions/` |
| Image overlay state, timing, preview, geometry | `src/overlays/` |
| Retake candidates, validation, freshness, workflow, UI | `src/retakes/` |
| Shared FFmpeg engine | `src/ffmpeg/engine.ts` |
| Export graph, audio cleanup, runtime and UI | `src/export/` |
| Transcription and stateless Claude relays | `netlify/functions/transcribe.ts`, `netlify/functions/agent.ts` |

## Verification and detailed references

- Test pure calculations at their module boundaries and integration behavior at the editor/export seams. Mock model, network, and FFmpeg runtime calls in offline tests; do not claim they validate real media quality or browser playback.
- For actual browser checks, use `docs/phase-9a-manual-verification.md`, `docs/phase-10-manual-verification.md`, and `docs/phase-11-manual-verification.md`. Their checklists are not evidence of a completed manual run.
- For Phase 11 contracts, cost policy, file inventory, and evidence, consult `docs/phase-11-handoff.md`, `docs/phase-11-test-coverage.md`, and `docs/phase-11-performance.md` before changing retake behavior.
- Read the relevant source and tests before editing. Keep this file focused on active guidance; put detailed phase logs, numeric thresholds, and test inventories in the applicable docs and source tests.
