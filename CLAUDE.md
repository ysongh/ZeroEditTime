# CLAUDE.md

Guidance for working in this repository.

## Project

**Zero Edit Time** — a browser-based, AI-assisted video editor that runs entirely client-side.
It is being built in **phases**. Build only the current phase; do not scaffold, stub, or create
empty folders for future phases.

- **Phase 0 (done):** "file-in → plays". Pick a local video, play it, show its duration.
- **Phase 1 (done):** non-destructive EDL editing model + trim. Edits are recorded in an
  EDL (the single source of truth); preview plays the kept ranges and skips removed ones.
  Nothing is re-encoded — encoding happens only at export, later.
- **Phase 2 (done):** transcription. A thin Netlify Function proxies the media to Whisper and
  returns word-level timings; the app renders a clickable transcript with click-to-seek and an
  active-word highlight that tracks the playhead.
- **Phase 3 (done):** transcript editing. Delete a word span or a whole sentence; each maps to
  a source range and removes it through the same EDL primitive as timeline edits. Struck-through
  words derive from the EDL (no per-word flag), and a single Undo restores the words, the EDL
  range, and the timeline together.
- **Phase 4 (in progress):** an AI agent. A natural-language command box ("remove the silences",
  "cut the filler words", "get it under 30 seconds") drives edits. A new Netlify Function
  (`/api/agent`) is a **stateless relay**: it injects a system prompt + tool schemas and forwards
  to Claude, executing no tools and holding no EDL. The CLIENT runs an agent loop, executes the
  returned tool calls against a working EDL via the existing pure functions, and commits the whole
  run as ONE `commitEdl` change (one Undo). So far: `src/agent/detect.ts` and `src/agent/tools.ts`
  (the pure detection + executors, now unit-tested). Still landing this phase: the loop
  (`run.ts`), the proxy (`netlify/functions/agent.ts`), and the `AgentBar` UI.
- **Later phases (do NOT build yet):** captions and `ffmpeg.wasm` export.

## Stack

- React 19 + TypeScript, bundled with Vite 8.
- Package manager: **pnpm only** — never `npm` or `yarn`.
- No UI or styling libraries. Plain React + the Vite template.
- Tests: **Vitest** — added for Phase 1 to unit-test the EDL math and (Phase 3) the kept-word
  predicate and sentence grouping.
- Transcription proxy runs as a **Netlify Function** (`netlify dev` for local end-to-end);
  `netlify-cli` is the only Phase-2 dev dependency.
- The Phase-4 agent proxy is a second Netlify Function calling the **Claude Messages API**
  (`claude-sonnet-4-6`) via a hand-rolled `fetch` — no SDK, no new dependency. `ANTHROPIC_API_KEY`
  lives only in the function (in `.env`), mirroring how the transcribe proxy hides its key.

## Commands

```bash
pnpm dev      # start the Vite dev server
pnpm build    # tsc -b && vite build — typecheck + production build
pnpm lint     # eslint
pnpm preview  # serve the production build locally
pnpm test     # vitest run — the EDL unit tests
```

Run `pnpm build` to confirm changes typecheck and compile, and `pnpm test` for the EDL math.

## Constraints

- **Strict TypeScript, no `any`.** Type DOM/React event handlers explicitly.
- **No new dependencies** unless a phase genuinely requires it (Phase 1 added Vitest, Phase 2
  added `netlify-cli`; Phase 3 added none).
- **The EDL is the single source of truth.** Editing never mutates or re-encodes the source;
  it records removed ranges and recomputes segments. React state derives one-way (EDL → UI).
- Keep the EDL math **pure and React-free** in `src/edl/`. `applyRemovedRange` is the sole
  removal primitive — trim, cut, and transcript-deletes all funnel through it — and must stay
  unit-tested.
- **One EDL, derived views.** The transcript has no separate "deleted words" state; a word is
  struck iff its midpoint is not kept (`isSourceTimeKept`). Every mutation routes through the
  single `commitEdl` in `App.tsx`, which snapshots history so one Undo restores all views.
- Keep UI in `src/App.tsx` (+ `src/Timeline.tsx`, `src/transcript/`, and `src/agent/`); add
  further components only if they help.
- **The agent proxy is a stateless relay.** It executes no tools, holds no EDL, and contains no
  editing logic or state — Claude only SELECTS tools; the client computes ranges and applies them.
  Detection and executors stay pure and React-free in `src/agent/` and must stay unit-tested. The
  agent loop mutates a working EDL through its turns and commits ONCE via the existing `commitEdl`,
  so a single Undo reverts the whole command. Reported numbers (tools run, kept duration
  before→after) are computed CLIENT-side; Claude's text is narration only.
- Do not re-init the project or overwrite toolchain config (`vite.config.ts`, `tsconfig*.json`,
  `eslint.config.js`).

## Layout

- `src/edl/` — framework-free EDL core (the shared contract for every phase). All times are
  seconds (floats) into the source.
  - `types.ts` — `EDL`, `Segment`, `Caption`.
  - `edl.ts` — pure math: `createEdl`, `applyRemovedRange` (subtract a range → new segments),
    `splitSegmentAt` (structural boundary insert), `totalKeptDuration`, EDL-time ↔ source-time
    mapping, and `isSourceTimeKept` (the derived-truth predicate for word strike-through). No
    React, no DOM, no mutation.
  - `edl.test.ts` — Vitest unit tests for the math.
- `src/App.tsx` — the app. Holds EDL state (initialized from the loaded source as one
  full-length segment) plus an EDL history stack; the single `commitEdl` snapshots before each
  mutation and `undo` pops it back. Owns the file picker, edit controls (set in/out, trim,
  delete range, split, undo, reset), transcription, and the EDL-driven playback controller that
  skips removed ranges on the video's `timeupdate` and stops after the last kept segment. Object
  URLs are revoked on replace/unmount to avoid leaks.
- `src/Timeline.tsx` — one-track timeline rendered one-way from the EDL (segments, gaps,
  playhead, selection); click-to-seek maps a pixel position back to source time.
- `src/transcript/` — the transcript view, a second view onto the one EDL.
  - `types.ts` — `Word` (`text`, `start`, `end`) and `Transcript`.
  - `api.ts` — client call to the proxy; validates and returns `{ words }`.
  - `sentences.ts` — pure `groupSentences` (words → inclusive index spans at terminal
    punctuation), unit-tested in `sentences.test.ts`. Backs "delete a sentence in one action".
  - `Transcript.tsx` — clickable words with index-based selection (click / shift-click span)
    and per-sentence delete; words render struck-through derived from `isSourceTimeKept`, never
    a stored flag. Deleting a span calls back into `App`'s `commitEdl` path.
- `src/agent/` — the Phase-4 agent, a third view onto the one EDL (so far the pure core; the
  loop and UI land later this phase). All detection and executors are framework-free and unit-tested.
  - `detect.ts` — pure range detection: `findSilences` (inter-word gaps over a threshold) and
    `findFillerSpans` (case-insensitive, punctuation-stripped, greedy longest-first matching of
    filler words/phrases). Returns `Range[]`; touches no EDL.
  - `tools.ts` — pure executors `(edl, transcript, args) => { edl, removed_count, removed_seconds }`
    for `cut_segment`, `remove_silences`, `remove_filler_words`, and `trim_to_duration`. Every
    removal funnels through `applyRemovedRange`; `trim_to_duration` reuses `edlTimeToSource` to crop
    the tail. A model-supplied silence threshold is clamped to a floor (`MIN_SILENCE_MS`).
  - `detect.test.ts` / `tools.test.ts` — Vitest unit tests for the detection and the executors
    (including `trim_to_duration` via `edlTimeToSource`), run offline with no API.
- `netlify/functions/transcribe.ts` — Phase-2 proxy: POSTs the media to Whisper, returns
  `{ words: Word[] }`, and hides the API key. Run `netlify dev` for local transcription.
- `src/main.tsx` — React entry (`StrictMode`).
- `src/index.css` — Vite template styles (`#root` is a centered 1126px column).
- `public/_headers` — sets COOP `same-origin` + COEP `require-corp`. **Do not remove.** These
  enable cross-origin isolation / `SharedArrayBuffer`, which `ffmpeg.wasm` export needs later.
  Vite copies `public/` verbatim into `dist/`.
