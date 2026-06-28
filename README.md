# Zero Edit Time

A browser-based, AI-assisted video editor that runs **entirely client-side**. Pick a local video,
edit it non-destructively (by hand, by deleting words in the transcript, or by typing a natural-
language command), and export a trimmed MP4 — all in the browser. The source is never uploaded for
editing and never re-encoded until you export.

## How it works

The single source of truth is an **EDL** (Edit Decision List): the ordered set of source
time-ranges that play. Every edit — a timeline trim, a transcript-word delete, an AI agent command
— records a removed range and recomputes the kept segments. The UI derives from the EDL one-way, so
the preview, the timeline, and the struck-through transcript words all stay in lockstep, and a
single **Undo** restores them together. Nothing is re-encoded until **Export**, which reads the kept
segments and produces a downloadable MP4 with `ffmpeg.wasm`.

### Built in phases

- **Phase 0** — pick a local video, play it, show its duration.
- **Phase 1** — the EDL model + trimming. Preview plays the kept ranges and skips removed ones.
- **Phase 2** — transcription. A Netlify Function proxies the media to Whisper and returns
  word-level timings; the transcript is clickable (click-to-seek) with an active-word highlight.
- **Phase 2.5** — client-side audio extraction. Before uploading, the browser extracts and
  downsamples the audio to a tiny 16 kHz mono file (reusing the export engine), so real 1–2 min
  footage clears the proxy's request-body limit and any source format (including `.mov`) works.
- **Phase 3** — transcript editing. Delete a word span or a whole sentence; each maps to a source
  range and is removed through the same EDL primitive as timeline edits.
- **Phase 4** — an AI agent. A natural-language command box ("remove the silences", "cut the filler
  words", "get it under 30 seconds") drives edits. A Netlify Function relays to Claude, which only
  *selects* tools; the client computes the ranges, applies them, and commits the whole run as one
  Undo.
- **Phase 5** — export. A fully client-side `ffmpeg.wasm` encode trims each kept segment off decoded
  frames and concatenates them into one re-encoded MP4 — no network calls, no proxy.

## Stack

- **React 19 + TypeScript** (strict, no `any`), bundled with **Vite 8**.
- **pnpm** only — never `npm` or `yarn`.
- No UI/styling/state libraries — plain React.
- **Vitest** for the pure EDL math, the agent detection/executors/loop, and the export-args builder.
- **Netlify Functions** for the Whisper transcription proxy (Phase 2) and the Claude agent relay
  (Phase 4). API keys live only in the functions' `.env`.
- **`ffmpeg.wasm`** (`@ffmpeg/ffmpeg` + `@ffmpeg/util`) for Phase-5 export and Phase-2.5 audio
  extraction, sharing one engine; the single-threaded `@ffmpeg/core` is loaded from a CDN, so it
  needs no proxy and no cross-origin isolation.

## Commands

```bash
pnpm install   # install dependencies
pnpm dev       # start the Vite dev server (playback, editing, and EXPORT work here)
pnpm build     # tsc -b && vite build — typecheck + production build
pnpm lint      # eslint
pnpm preview   # serve the production build locally
pnpm test      # vitest run — the unit tests
```

### Local end-to-end

- **Editing and export** run under plain `pnpm dev` — they are 100% client-side.
- **Transcription and the AI agent** need the Netlify Functions, so run the app with `netlify dev`
  and provide the keys in a `.env`:

  ```bash
  # .env (never committed)
  OPENAI_API_KEY=...        # used by the Whisper transcription proxy
  ANTHROPIC_API_KEY=...     # used by the Claude agent relay
  ```

  Note: the browser extracts a small audio file before uploading (Phase 2.5), so multi-minute clips
  and any source format (including `.mov`) transcribe fine — the proxy's ~4.5 MB request-body limit
  no longer bites for normal footage.

## Using it

1. Load a video. It plays and shows its duration; the EDL starts as one full-length segment.
2. Edit:
   - **Timeline** — Set In / Set Out, then Delete range or Trim to selection; Split at playhead.
   - **Transcript** (after Transcribe) — click words to select a span, or delete a whole sentence;
     struck-through words show what's been cut.
   - **Agent** — type a command and Run; it edits via the same EDL primitives in one Undo.
   - **Undo / Reset** at any time.
3. **Export MP4** — loads the encode engine (≈31 MB, first time only), shows a progress bar, then
   downloads `zero-edit-time.mp4` containing only the kept segments, in order, audio in sync.

## Project layout

- `src/edl/` — framework-free EDL core: types and pure math (`createEdl`, `applyRemovedRange`,
  `splitSegmentAt`, time mapping, `isSourceTimeKept`). All times are seconds into the source.
- `src/App.tsx` — the app shell: file picker, EDL state + history (`commitEdl` / `undo`), the
  skip-removed-ranges playback controller, and the edit controls.
- `src/Timeline.tsx` — the one-track timeline, rendered one-way from the EDL.
- `src/transcript/` — the clickable transcript view, sentence grouping, client-side audio
  extraction (Phase 2.5), and the proxy client.
- `src/agent/` — the AI agent: pure range detection and tool executors, the client agent loop, and
  the command-box UI.
- `src/ffmpeg/` — the one shared `ffmpeg.wasm` engine (a lazy single instance + CDN loader), used
  by both export and audio extraction so the core loads at most once per session.
- `src/export/` — Phase-5 export: the pure `buildExportArgs` filter-graph builder, the run
  mechanics, and the Export button.
- `netlify/functions/` — the Whisper transcription proxy and the stateless Claude agent relay.

See [CLAUDE.md](CLAUDE.md) for the detailed architecture and contributor guidance.
