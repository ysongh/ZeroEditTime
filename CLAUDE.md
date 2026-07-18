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
- **Phase 5.5 (done):** export audio polish + natural-pacing silence removal. **Part A** — all
  inside `buildExportArgs`; the VIDEO chain is byte-identical to Phase 5 (no video fades — the
  hard cut is correct). Each segment's audio chain appends ~15 ms declick micro fades after
  `asetpts` (`AUDIO_FADE_S = 0.015`, clamped to half the segment duration so a tiny sliver never
  gets a negative fade-out start), and the combined audio ends `loudnorm=I=-16:TP=-1.5:LRA=11` →
  `aresample=48000` on BOTH paths: concat emits an intermediate `[ca]` that runs the mastering
  tail into `[outa]`; a single segment chains the identical tail directly. The `aresample` is
  required (loudnorm internally upsamples to 192 kHz). `runExport` retries without loudnorm ONLY
  on a "No such filter: loudnorm" exec failure — fades + resample stay, never a silent
  dynaudnorm substitute — and surfaces a note via `onNote` into the Export button's existing
  error line. **Part B** — silence removal no longer deletes a gap wholly (machine-gun pacing):
  `findSilences(transcript, threshold_ms, keep_gap_ms = 250)` emits a removal only when the gap
  exceeds BOTH the threshold and the keep (so it's always positive) and trims the MIDDLE of the
  gap, keeping `keep_gap_ms` split half/half — the earlier word's decay on one side, the next
  word's inhale on the other; `keep_gap_ms = 0` reproduces full-gap removal exactly. The
  `remove_silences` contract is `{ threshold_ms, keep_gap_ms? }` on BOTH sides: the client
  executor defaults to `DEFAULT_KEEP_GAP_MS` (250) and clamps to [0, `MAX_KEEP_GAP_MS` = 1000],
  and the relay adds the schema property + one prompt line (~250 ms breathing room by default;
  keep_gap_ms=0 only on an explicit maximally-tight ask). Still a stateless relay; no new UI.
- **Phase 6 (done):** captions — generated from the
  transcript, previewed over the video, burned into the exported MP4. The timebase model:
  captions are STORED in SOURCE seconds in `edl.captions` (consistent with segments; regenerable;
  undoable), GENERATED from kept words only (the existing `isSourceTimeKept` midpoint predicate),
  and BURNED in OUTPUT time (the exported file's clock = the concatenated kept timeline) via
  `sourceTimeToEdlTime`; export preparation defensively re-clips against the CURRENT EDL, so
  cutting more after generating never captions deleted speech. **Part A (done)** — the pure layer
  in `src/captions/captions.ts`: `buildCaptions` greedily chunks kept words, breaking at
  `MAX_CAPTION_WORDS` (5), after terminal punctuation (the transcript's shared `endsSentence`),
  and on OUTPUT-time gaps > `CAPTION_GAP_S` (0.8 s) — output time is the perceptually correct
  measure, so a big source gap wholly removed by a cut never breaks a line;
  `prepareCaptionsForExport` drops fully-cut captions, clips partially-cut ones to their kept
  instants, maps to output time, and enforces `MIN_CAPTION_S` (0.7 s) by extending without
  overlapping the next caption or passing `totalKeptDuration`; `formatSrtTime`/`buildSrt`
  serialize SRT (comma millis, 1-indexed blocks, single-line text). **Part B (done)** — the burn:
  `buildExportArgs` gains `options.srtFile`; when set, the assembled video lands on an
  intermediate `[cv]` and one appended `subtitles=…:fontsdir=/fonts:force_style='…'` clause
  produces `[outv]` (audio untouched; with no `srtFile` the graph is byte-identical to
  Phase 5.5). `runExport` accepts PREPARED captions; when non-empty it stages the committed
  `public/fonts/Roboto-Bold.ttf` + the built `captions.srt` into the VFS (ffmpeg.wasm's VFS
  ships NO fonts — the filter renders blank without one) and cleans both up in `finally`; a
  "No such filter: subtitles" failure surfaces as a clear error (no drawtext fallback).
  `ExportButton` prepares `edl.captions` at click time — export burns automatically whenever
  captions are present, no toggle. **Part C (done)** — the preview: `CaptionOverlay` (an
  absolutely positioned, pointer-events-none div inside a new position:relative wrapper around
  the `<video>`) shows the SOURCE-time caption containing the playhead (`start <= t < end`,
  like the transcript highlight; none → hidden), approximating the burn (white bold, black
  text-shadow, bottom-center); a "Generate captions" button in the transcript section runs
  `buildCaptions(transcript, edl)` and commits `{ ...edl, captions }` via `commitEdl` — one
  Undo removes them, regenerating replaces — and shows the caption count. **Part D (done)** —
  the `generate_captions` agent tool, completing the one-command rough cut ("tighten this up
  and add captions"): a pure executor runs `buildCaptions(transcript, workingEdl)` and returns
  `{ edl: { ...edl, captions }, removed_count: 0, removed_seconds: 0, captions_count }`;
  `run.ts` registers it and the tool_result JSON gains `captions_count` ONLY when a tool
  reports it (additive — every other tool's payload is byte-identical); the relay adds the
  empty-input schema + one system-prompt line (call it AFTER cutting tools so captions reflect
  the final edit — and even an early call stays safe, because export-time preparation re-clips
  against the final EDL). Still a stateless relay; no new UI.
- **Phase 8 (in progress):** caption TEXT editing + SRT download + a burn toggle — the
  fix-the-mishears phase: Whisper flubs dev jargon, so captions must be readable as a list and
  correctable before the burn. **Part A (done)** — pure `updateCaptionText(edl, id, text)` in
  `src/captions/captions.ts`: collapses internal newlines to spaces (the SRT/burn path is
  single-line) and trims, then replaces exactly that caption's text (times, ids, order,
  segments preserved; no mutation). Returns the SAME `edl` reference — the caller's
  skip-`commitEdl` no-op signal, so no junk undo entries — on an unknown id, empty/whitespace
  text, or unchanged text. Unit-tested (replacement isolation, all three identity cases,
  newline collapse + trim, purity). **Part B (done)** — a scannable, editable caption list:
  `CaptionList.tsx` renders one row per caption (SOURCE mm:ss button — exact seconds in its
  title — seeking via App's existing `onSeek`, plus the text) in a bordered, scrolling box
  styled like the transcript's, with the row at the playhead highlighted exactly like the
  transcript's active word (`start <= t < end`, `var(--accent)`). Clicking the text turns that
  row into an inline input (local `editingId` + `draft`, exactly one row editable at a time);
  BLUR is the single commit path — Enter just blurs the still-mounted input (focusout fires
  synchronously, one commit), Escape sets a `cancelledRef` so the close-triggered blur skips,
  reset on the next edit start. App's `editCaptionText` runs `updateCaptionText` and commits
  only on a real change (identity return → no commit, no undo entry), setting a React-state
  `captionsEdited` flag; the manual "Generate captions" button `window.confirm`s before
  overwriting when that flag is set and clears it on regenerate; the agent path clears it when
  a run included `generate_captions` (AgentBar's `onCommit` gains a `regeneratedCaptions`
  boolean → App's `handleAgentCommit`). The overlay and export pick up edits automatically
  (both read `edl.captions`). The relay gains ONE system-prompt line — if the user asks to
  regenerate after hand-editing, note that regeneration replaces manual edits — schema
  untouched, still a stateless relay. **Part C (pending)** — SRT download + burn toggle.
- **Out of scope (do NOT build):** save/load (deliberately deferred), caption timing edits,
  caption add/delete/split/merge, caption styling UI, SRT import, an agent tool for editing
  caption text, and word-by-word karaoke timing; do not scaffold for them.

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
- **Export reads, never mutates.** Phase-5 export READS `edl.segments` (and, Phase 6,
  `edl.captions`) and re-encodes them client-side; it changes no EDL state, adds no editing
  features, and makes no network calls beyond the same-origin font asset. Keep the testable core
  (`buildExportArgs`) pure and React-free, and keep it unit-tested. Do not add server-side
  export or a bundled `@ffmpeg/core` (load it from the CDN).
- **Captions are EDL state, mapped at the edges.** Stored in SOURCE seconds in `edl.captions`
  (committed via `commitEdl`, undoable like every edit); generated from KEPT words only; burned
  in OUTPUT time. `prepareCaptionsForExport` re-clips against the current EDL at export, so
  stale captions can never caption deleted speech. All caption logic stays pure, React-free,
  and unit-tested in `src/captions/` (`CaptionOverlay` + App's generate-button wiring are the
  only caption UI); the burn font is a committed asset, not a dependency. No caption editing,
  styling UI, SRT download, or karaoke timing.
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
  skips removed ranges on the video's `timeupdate` and stops after the last kept segment.
  Phase 6 wraps the `<video>` in a position:relative container hosting `CaptionOverlay` (fed
  `edl.captions` + the playhead) and adds the "Generate captions" button (`buildCaptions` →
  `commitEdl`, caption count shown) in the transcript section. Phase 8 adds a `captionsEdited`
  React-state flag (set by `editCaptionText`, cleared on manual/agent regenerate, reset on file
  change), the `window.confirm` regenerate guard, `editCaptionText` (`updateCaptionText` →
  commit only on a real change), `handleAgentCommit` (clears the flag when a run regenerated
  captions), and the `CaptionList` render. Object URLs are revoked on replace/unmount to avoid
  leaks.
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
    Exports `endsSentence` (the terminal-punctuation predicate) so Phase-6 caption chunking
    shares the one definition instead of duplicating the regex.
  - `Transcript.tsx` — clickable words with index-based selection (click / shift-click span)
    and per-sentence delete; words render struck-through derived from `isSourceTimeKept`, never
    a stored flag. Deleting a span calls back into `App`'s `commitEdl` path.
- `src/agent/` — the Phase-4 agent, a third view onto the one EDL. Detection and executors are
  framework-free and unit-tested; the loop is offline-testable via an injectable transport.
  - `detect.ts` — pure range detection: `findSilences` (inter-word gaps over a threshold; since
    Phase 5.5B it trims only the MIDDLE of each qualifying gap, keeping `keep_gap_ms` — default
    `DEFAULT_KEEP_GAP_MS` = 250 — split half/half, and fires only when the gap exceeds both the
    threshold and the keep), `findFillerSpans` (case-insensitive, punctuation-stripped, greedy
    longest-first matching of filler words/phrases), and (Phase 4.5) `findStumbleSpans`
    (repeats/restarts/re-said phrases, keeping the last take; thresholds are named constants —
    `MAX_NGRAM`, `MAX_BETWEEN_WORDS`, `MAX_RETAKE_GAP_S`, `MIN_PREFIX_LEN`). Returns `Range[]`;
    touches no EDL.
  - `tools.ts` — pure executors `(edl, transcript, args) => { edl, removed_count, removed_seconds }`
    for `cut_segment`, `remove_silences`, `remove_filler_words`, `remove_stumbles` (no args),
    `trim_to_duration`, and (Phase 6) `generate_captions` (no args — stores `buildCaptions`
    output on the working EDL, removes nothing, and adds `captions_count` to the result).
    Every removal funnels through `applyRemovedRange`; `trim_to_duration` reuses
    `edlTimeToSource` to crop the tail. A model-supplied silence threshold is clamped to a floor
    (`MIN_SILENCE_MS`) and `keep_gap_ms` to [0, `MAX_KEEP_GAP_MS`], defaulting to
    `DEFAULT_KEEP_GAP_MS` when absent.
  - `run.ts` — the client agent loop: owns the Anthropic `messages` array and a working EDL,
    POSTs to `/api/agent`, runs each `tool_use` through the matching executor (working EDL threads
    across turns), feeds back a `tool_result` (with the additive `captions_count` field when the
    tool reports one), and re-POSTs until `end_turn` or a 6-iteration cap.
    Returns the uncommitted EDL plus the client-computed summary; the `transport` is injectable.
  - `AgentBar.tsx` — the command box (input + Run, thinking/disabled state, error + summary).
    Calls `runAgent` and commits the result ONCE via App's commit path; shows the client-side
    tools-run + kept-duration delta. Phase 8: `onCommit(edl, regeneratedCaptions)` passes
    whether the run included `generate_captions` so App can clear its `captionsEdited` flag.
  - `detect.test.ts` / `tools.test.ts` / `run.test.ts` — Vitest unit tests for the detection, the
    executors (including `trim_to_duration` via `edlTimeToSource`), and the loop (scripted
    transport), all run offline with no API.
- `src/captions/` — the Phase-6 caption layer: pure and React-free except the one overlay
  component; no ffmpeg.
  - `captions.ts` — `buildCaptions(transcript, edl)` chunks KEPT words into source-time
    `Caption`s with deterministic `cap_${start}_${end}` ids (breaks: `MAX_CAPTION_WORDS` = 5,
    terminal punctuation via the shared `endsSentence`, OUTPUT-time gap > `CAPTION_GAP_S` =
    0.8 s); `updateCaptionText(edl, id, text)` (Phase 8) → new EDL with that caption's text
    replaced (newlines collapsed, trimmed) or the SAME reference as the no-op signal (unknown
    id / empty / unchanged); `prepareCaptionsForExport(captions, edl)` → output-time `PreparedCaption[]`
    (intersect with kept segments — drop empty, clip partial; enforce `MIN_CAPTION_S` = 0.7 s
    by extending, clamped to the next caption's start and `totalKeptDuration`); `formatSrtTime`
    ("HH:MM:SS,mmm", comma millis, negatives clamp to 0) and `buildSrt` (1-indexed blocks,
    single-line text).
  - `captions.test.ts` — the chunk-break rules, the no-break-across-a-cut case (~0 output gap
    over a big source gap — proves output-time chunking), deleted words never captioned,
    prepare's drop/clip/join-mapping/min-extension (no overlap, end clamp), the SRT
    format/block fixtures, and (Phase 8) `updateCaptionText`'s replacement isolation,
    identity no-ops, newline collapse, and purity.
  - `CaptionOverlay.tsx` — the Part-C preview: renders the active SOURCE-time caption
    (`start <= playhead < end`) bottom-centered over the video (white bold, black text-shadow,
    `pointerEvents: none` so the native controls stay clickable); returns null when no caption
    is active. Purely derived — no state, no canvas, no timers.
  - `CaptionList.tsx` — the Phase-8 editing surface (rendered near the transcript when
    `edl.captions` is non-empty): a scannable list in a transcript-style scrolling box, one
    row per caption (SOURCE mm:ss seek button + text), the playhead's row highlighted like
    the transcript's active word. Clicking the text opens an inline input (local `editingId`
    + `draft`; one row at a time); BLUR is the single commit path via `onEditText` (App's
    `editCaptionText` → `updateCaptionText`) — Enter blurs the input, Escape cancels via a
    `cancelledRef` the close-triggered blur checks. Display-only `CaptionOverlay` stays
    untouched — this is the READ-and-fix surface.
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
    drops only the normalizer (the runtime fallback). Since Phase 6, `options.srtFile` appends
    the caption burn: the assembled video lands on an intermediate `[cv]` (concat emits it; the
    single-segment path labels its trim `[cv]`) and one
    `subtitles=SRT:fontsdir=FONTS_DIR:force_style='SUBTITLE_STYLE'`
    clause produces `[outv]` — audio untouched; with no `srtFile` the video chain is
    byte-identical to Phase 5.5. Float seconds pass straight through for frame accuracy;
    re-encodes (never `-c copy`, which only cuts on keyframes). Alongside it, `runExport` (using
    the shared engine's `inputExtension`) writes the source into the VFS — plus, when given
    non-empty PREPARED captions, the committed font (fetched same-origin from
    `/fonts/Roboto-Bold.ttf` into `/fonts` in the VFS; `createDir` guarded) and the `buildSrt`
    output as `captions.srt` — runs the one exec (capturing the log; on a "No such filter:
    loudnorm" failure it retries without loudnorm and reports via `onNote`; a "No such filter:
    subtitles" failure throws a clear error instead — never a drawtext fallback), reads the MP4
    back as a Blob, and best-effort frees the VFS (input, output, font, SRT) in a `finally`.
    The engine instance + CDN loader live in `src/ffmpeg/engine.ts`.
  - `ExportButton.tsx` — the Export section: gets the shared engine via `getFfmpeg()`/`loadFfmpeg()`
    from `src/ffmpeg/engine.ts` (no longer holds its own instance), loads it if needed (distinct
    "Loading engine…" state), encodes with a progress bar, and downloads `zero-edit-time.mp4`.
    Disabled while busy and when nothing is kept. Routes `runExport`'s non-fatal loudnorm-fallback
    note into its existing error line (no new UI). At click time it runs
    `prepareCaptionsForExport(edl.captions, edl)` and passes the result to `runExport`, so the
    burn happens automatically whenever the EDL holds captions (zero prepared → burn skipped).
  - `ffmpeg.test.ts` — Vitest unit tests for `buildExportArgs` (2-segment concat, 1-segment
    no-concat, exact float bounds and fade times, the tiny-segment fade clamp, the
    loudnorm→aresample tail on both paths, the video chain unchanged, and the loudnorm-off
    fallback option; with `srtFile`: the exact subtitles clause — force_style hardcoded verbatim
    so a style regression fails — on both paths, composition with `loudnorm: false`, and
    no-`srtFile` graphs staying byte-identical to Phase 5.5), run offline with no ffmpeg.
- `netlify/functions/transcribe.ts` — Phase-2 proxy: POSTs the audio to Whisper, returns
  `{ words: Word[] }`, and hides the API key. The OpenAI upload is named from the request's
  Content-Type via the pure, exported `extensionForContentType` (Phase 2.5) — unit-tested in
  `netlify/transcribe.test.ts`, which sits ABOVE `functions/` so Netlify doesn't bundle the test
  as a stray function. Run `netlify dev` for local transcription.
- `netlify/functions/agent.ts` — Phase-4 stateless relay: injects the system prompt + the 6
  tool schemas and forwards `{ messages }` to the Claude Messages API (`claude-sonnet-4-6`),
  returning `{ content, stop_reason }` unchanged. Executes no tools, holds no EDL; reads
  `ANTHROPIC_API_KEY` from env only. Reachable at `/api/agent` via the `/api/*` redirect.
  Phase 8 adds one prompt line (regeneration replaces hand-edited caption text) — schema and
  relay behavior otherwise unchanged.
- `src/main.tsx` — React entry (`StrictMode`).
- `src/index.css` — Vite template styles (`#root` is a centered 1126px column).
- `public/fonts/` — `Roboto-Bold.ttf` (static, v3.005) + its Apache-2.0 `LICENSE.txt`, pulled
  from google/fonts commit `ff11ed9` (HEAD now carries only the variable font, relicensed under
  OFL — the static Apache-era file lives in history). A committed asset, NOT a dependency:
  fetched same-origin at export and written into the ffmpeg VFS, which ships no fonts of its
  own, so caption rendering has no CDN/network dependency.
- `public/_headers` — sets COOP `same-origin` + COEP `require-corp`. **Do not remove.** These
  enable cross-origin isolation / `SharedArrayBuffer`. Phase-5 export deliberately uses the
  *single-threaded* `ffmpeg.wasm` core, so it does NOT require these headers (export runs under
  plain `pnpm dev`); they remain in place for the deployed app and any future multi-threaded use.
  Vite copies `public/` verbatim into `dist/`.
