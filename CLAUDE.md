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
- **Phase 4 (done):** an AI agent. A natural-language command box ("remove the silences",
  "cut the filler words", "get it under 30 seconds") drives edits. A Netlify Function
  (`/api/agent`) is a **stateless relay**: it injects a system prompt + tool schemas and forwards
  to Claude, executing no tools and holding no EDL. The CLIENT runs an agent loop (`run.ts`),
  executes the returned tool calls against a working EDL via the existing pure functions, and
  commits the whole run as ONE `commitEdl` change (one Undo). Reported numbers (tools run, kept
  duration before→after) are computed client-side; Claude's text is narration only.
- **Phase 5 (done):** export. A fully client-side `ffmpeg.wasm` encode turns the EDL into a
  downloadable MP4. It READS `edl.segments` (already the kept ranges, in order), trims each off
  decoded frames (resetting PTS) and concatenates them re-encoded — all in the browser with no
  network calls, no proxy, and no cross-origin isolation. A pure `buildExportArgs` maps the
  segments to the exact ffmpeg filter graph and is unit-tested; the encode itself is verified
  manually under plain `pnpm dev`.
- **Phase 2.5 (done):** client-side audio extraction so real footage clears the transcription
  upload limit. A synchronous Netlify Function base64-encodes its body (an effective ~4.5 MB cap),
  so a real 1–2 min video couldn't be transcribed. Fix: BEFORE uploading, extract + downsample the
  audio to a tiny 16 kHz mono file in the browser, reusing the SAME `ffmpeg.wasm` engine Phase 5
  proved (no WebAudio, no hand-rolled encoder). The single `FFmpeg` instance is consolidated into
  ONE shared `src/ffmpeg/engine.ts` (used by export too); `extractAudio` produces a tiny mono
  16 kHz mp3 (PCM-WAV fallback); the Transcribe flow extracts first, then uploads the small audio
  Blob (distinct "Preparing audio…" vs "Transcribing…" states); the proxy names the OpenAI upload
  from the request's Content-Type (a pure, unit-tested `extensionForContentType`); and the engine
  is preloaded fire-and-forget on file-select so it's warm by the time the user acts. Adds NO new
  dependency and no new editing features.
- **Phase 4.5 (done):** a `remove_stumbles` agent tool. Pure `findStumbleSpans` detects verbal
  stumbles in the transcript — immediate word repeats, partial-word restarts (final-word prefix,
  ≥ 3 chars), and re-said phrases in a tight window (recurrence starts ≤ 2 words and ≤ 3.0 s after
  the abandoned take) — and KEEPS THE LAST TAKE: each removed range runs
  [abandoned take start, kept take start), so dead air and filler between takes go too. Chained
  takes collapse to the final one; matching is longest-first (up to 4-grams) so a single-word rule
  never fires inside a phrase repeat, and single-word repeats fire only on immediate adjacency.
  Detection is deliberately conservative (precision over recall — repetition is also normal
  speech) and purely transcript-based: whisper-1 silently repairs many small flubs, so the tool
  cuts only what survives transcription. Wired on both sides of the contract — the executor
  funnels through `applyRemovedRange`, the loop registers it, and the relay gains the schema +
  one system-prompt line (still a stateless relay). No new UI and no new dependencies.
- **Phase 5.5 (Part A done; Part B NOT built yet):** export audio polish + natural-pacing
  silence removal. **Part A (done)** — all inside `buildExportArgs`; the VIDEO chain is
  byte-identical to Phase 5 (no video fades — the hard cut is correct). Each segment's audio
  chain appends ~15 ms declick micro fades after `asetpts` (`AUDIO_FADE_S = 0.015`, clamped to
  half the segment duration so a tiny sliver never gets a negative fade-out start), and the
  combined audio ends `loudnorm=I=-16:TP=-1.5:LRA=11` → `aresample=48000` on BOTH paths: concat
  emits an intermediate `[ca]` that runs the mastering tail into `[outa]`; a single segment
  chains the identical tail directly. The `aresample` is required (loudnorm internally upsamples
  to 192 kHz). `runExport` retries without loudnorm ONLY on a "No such filter: loudnorm" exec
  failure — fades + resample stay, never a silent dynaudnorm substitute — and surfaces a note
  via `onNote` into the Export button's existing error line. **Part B (pending — do not assume
  built):** `keep_gap_ms` on silence removal (shorten each qualifying gap to ~250 ms kept
  breathing room, split half/half, instead of deleting it wholly). `findSilences`, the
  `remove_silences` executor/schema, and the relay prompt are all still the Phase-4 versions.
- **Later phases (do NOT build):** captions. Out of scope this project; do not scaffold for it.

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
- Phase-5 export runs **`ffmpeg.wasm`** entirely in the browser via `@ffmpeg/ffmpeg` +
  `@ffmpeg/util` (the only Phase-5 deps). The single-threaded `@ffmpeg/core` is loaded from a
  CDN (pinned version) — not bundled — so there is no proxy, no server, and no cross-origin
  isolation requirement; export works under plain `pnpm dev`. As of Phase 2.5 the single `FFmpeg`
  instance and its CDN loader live in a shared `src/ffmpeg/engine.ts` (built lazily, loaded once
  per session), shared by export and Phase-2.5 audio extraction — no new dependency.

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
- **Export reads, never mutates.** Phase-5 export READS `edl.segments` and re-encodes them
  client-side; it changes no EDL state, adds no editing features, and makes no network calls. Keep
  the testable core (`buildExportArgs`) pure and React-free, and keep it unit-tested. Do not add
  captions, server-side export, or a bundled `@ffmpeg/core` (load it from the CDN).
- **One shared `ffmpeg.wasm` engine.** There is exactly ONE `FFmpeg` instance for the whole app,
  in `src/ffmpeg/engine.ts` — never construct a second. It is built LAZILY in `getFfmpeg()` (not at
  module load) so node-side unit tests that import the module's pure helpers don't trip
  `new FFmpeg()`, which throws "ffmpeg.wasm does not support nodejs"; it loads at most once per
  session via the ESM CDN core, shared by export and (Phase 2.5) audio extraction.
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
  mutation and `undo` pops it back. Owns the file picker (which preloads the shared ffmpeg engine
  fire-and-forget so it's warm for Transcribe/Export), edit controls (set in/out, trim, delete
  range, split, undo, reset), the two-phase Transcribe action (extract audio client-side, then
  upload — `'preparing' | 'transcribing'` states), and the EDL-driven playback controller that
  skips removed ranges on the video's `timeupdate` and stops after the last kept segment. Object
  URLs are revoked on replace/unmount to avoid leaks.
- `src/Timeline.tsx` — one-track timeline rendered one-way from the EDL (segments, gaps,
  playhead, selection); click-to-seek maps a pixel position back to source time.
- `src/transcript/` — the transcript view, a second view onto the one EDL.
  - `types.ts` — `Word` (`text`, `start`, `end`) and `Transcript`.
  - `api.ts` — client call to the proxy: POSTs the extracted audio Blob with its `type` as the
    request Content-Type (no filename query param); validates and returns `{ words }`.
  - `extractAudio.ts` — Phase-2.5 `extractAudio(file)`: via the shared engine it writes the source
    into the VFS and runs ONE ffmpeg exec to a tiny mono 16 kHz mp3 (`libmp3lame`, ~0.5 MB/min;
    `-vn -ac 1 -ar 16000`), returning it as a Blob whose `type` (`audio/mpeg`, or `audio/wav` if the
    core lacks `libmp3lame`) becomes the upload Content-Type. Captures ffmpeg's log to surface a
    clear "no audio track" error and to trigger the WAV fallback; frees the VFS in `finally`.
    mov/mp4/webm/mkv all decode here, which moots the old ".mov rejected" problem.
  - `sentences.ts` — pure `groupSentences` (words → inclusive index spans at terminal
    punctuation), unit-tested in `sentences.test.ts`. Backs "delete a sentence in one action".
  - `Transcript.tsx` — clickable words with index-based selection (click / shift-click span)
    and per-sentence delete; words render struck-through derived from `isSourceTimeKept`, never
    a stored flag. Deleting a span calls back into `App`'s `commitEdl` path.
- `src/agent/` — the Phase-4 agent, a third view onto the one EDL. Detection and executors are
  framework-free and unit-tested; the loop is offline-testable via an injectable transport.
  - `detect.ts` — pure range detection: `findSilences` (inter-word gaps over a threshold),
    `findFillerSpans` (case-insensitive, punctuation-stripped, greedy longest-first matching of
    filler words/phrases), and (Phase 4.5) `findStumbleSpans` (repeats/restarts/re-said phrases,
    keeping the last take; thresholds are named constants — `MAX_NGRAM`, `MAX_BETWEEN_WORDS`,
    `MAX_RETAKE_GAP_S`, `MIN_PREFIX_LEN`). Returns `Range[]`; touches no EDL.
  - `tools.ts` — pure executors `(edl, transcript, args) => { edl, removed_count, removed_seconds }`
    for `cut_segment`, `remove_silences`, `remove_filler_words`, `remove_stumbles` (no args), and
    `trim_to_duration`. Every removal funnels through `applyRemovedRange`; `trim_to_duration` reuses
    `edlTimeToSource` to crop the tail. A model-supplied silence threshold is clamped to a floor
    (`MIN_SILENCE_MS`).
  - `run.ts` — the client agent loop: owns the Anthropic `messages` array and a working EDL,
    POSTs to `/api/agent`, runs each `tool_use` through the matching executor (working EDL threads
    across turns), feeds back a `tool_result`, and re-POSTs until `end_turn` or a 6-iteration cap.
    Returns the uncommitted EDL plus the client-computed summary; the `transport` is injectable.
  - `AgentBar.tsx` — the command box (input + Run, thinking/disabled state, error + summary).
    Calls `runAgent` and commits the result ONCE via App's `commitEdl`; shows the client-side
    tools-run + kept-duration delta.
  - `detect.test.ts` / `tools.test.ts` / `run.test.ts` — Vitest unit tests for the detection, the
    executors (including `trim_to_duration` via `edlTimeToSource`), and the loop (scripted
    transport), all run offline with no API.
- `src/ffmpeg/` — the one shared `ffmpeg.wasm` engine, used by BOTH export and (Phase 2.5)
  audio extraction so the ~31 MB core loads at most once per session.
  - `engine.ts` — owns the single `FFmpeg` instance via `getFfmpeg()` (built LAZILY on first call,
    never at module load: `new FFmpeg()` throws under node and would crash the offline unit tests
    that import the pure `inputExtension` from here), the CDN `loadFfmpeg` (single-threaded, guarded
    on `ffmpeg.loaded`), and the `inputExtension` helper. **Load the ESM core
    (`@ffmpeg/core@<ver>/dist/esm`), not umd** — Vite bundles `@ffmpeg/ffmpeg`'s worker as a
    *module* worker, and only the ESM build has the `export default createFFmpegCore` it imports;
    the umd build leaves `createFFmpegCore` undefined there and load fails with "failed to import
    ffmpeg-core.js".
- `src/export/` — the Phase-5 export, a read-only consumer of the one EDL. Fully client-side; no
  network, no proxy, no React in the testable core.
  - `ffmpeg.ts` — `buildExportArgs(segments, inputName?, outputName?, options?)` is the **pure**
    core: it maps the kept segments to the exact ffmpeg exec args — one `-filter_complex` string
    that `trim`/`atrim`s each segment off decoded frames, resets PTS (`setpts`/`asetpts=PTS-STARTPTS`)
    so audio stays in sync across joins, and `concat`s them (a single segment skips concat and
    labels `[outv]` directly). Since Phase 5.5A the AUDIO chain adds per-segment declick fades
    after `asetpts` (`afade` in/out, `AUDIO_FADE_S = 0.015` clamped to half the segment duration)
    and a mastering tail `LOUDNORM` → `aresample=OUTPUT_SAMPLE_RATE` (48 kHz) into `[outa]` on
    both the concat (`[ca]` intermediate) and single-segment paths; `options.loudnorm: false`
    drops only the normalizer (the runtime fallback). The video chain is unchanged from Phase 5.
    Float seconds pass straight through for frame accuracy; re-encodes (never `-c copy`, which
    only cuts on keyframes). Alongside it, `runExport` (using the shared engine's
    `inputExtension`) writes the source into the VFS, runs the one exec (capturing the log; on a
    "No such filter: loudnorm" failure it retries without loudnorm and reports via `onNote`),
    reads the MP4 back as a Blob, and best-effort frees the VFS in a `finally`. The engine
    instance + CDN loader live in `src/ffmpeg/engine.ts`.
  - `ExportButton.tsx` — the Export section: gets the shared engine via `getFfmpeg()`/`loadFfmpeg()`
    from `src/ffmpeg/engine.ts` (no longer holds its own instance), loads it if needed (distinct
    "Loading engine…" state), encodes with a progress bar, and downloads `zero-edit-time.mp4`.
    Disabled while busy and when nothing is kept. Routes `runExport`'s non-fatal loudnorm-fallback
    note into its existing error line (no new UI).
  - `ffmpeg.test.ts` — Vitest unit tests for `buildExportArgs` (2-segment concat, 1-segment
    no-concat, exact float bounds and fade times, the tiny-segment fade clamp, the
    loudnorm→aresample tail on both paths, the video chain unchanged, and the loudnorm-off
    fallback option), run offline with no ffmpeg.
- `netlify/functions/transcribe.ts` — Phase-2 proxy: POSTs the audio to Whisper, returns
  `{ words: Word[] }`, and hides the API key. The OpenAI upload is named from the request's
  Content-Type via the pure, exported `extensionForContentType` (Phase 2.5) — unit-tested in
  `netlify/transcribe.test.ts`, which sits ABOVE `functions/` so Netlify doesn't bundle the test
  as a stray function. Run `netlify dev` for local transcription.
- `netlify/functions/agent.ts` — Phase-4 stateless relay: injects the system prompt + the 5
  tool schemas and forwards `{ messages }` to the Claude Messages API (`claude-sonnet-4-6`),
  returning `{ content, stop_reason }` unchanged. Executes no tools, holds no EDL; reads
  `ANTHROPIC_API_KEY` from env only. Reachable at `/api/agent` via the `/api/*` redirect.
- `src/main.tsx` — React entry (`StrictMode`).
- `src/index.css` — Vite template styles (`#root` is a centered 1126px column).
- `public/_headers` — sets COOP `same-origin` + COEP `require-corp`. **Do not remove.** These
  enable cross-origin isolation / `SharedArrayBuffer`. Phase-5 export deliberately uses the
  *single-threaded* `ffmpeg.wasm` core, so it does NOT require these headers (export runs under
  plain `pnpm dev`); they remain in place for the deployed app and any future multi-threaded use.
  Vite copies `public/` verbatim into `dist/`.
