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
- **Phase 8 (done):** caption TEXT editing + SRT download + a burn toggle — the
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
  untouched, still a stateless relay. **Part C (done)** — SRT download + burn toggle, wiring
  only in `ExportButton` (engine, `buildExportArgs`, `runExport`, and the burn pipeline
  untouched): a render-time `prepared = prepareCaptionsForExport(edl.captions, edl)` (cheap,
  pure) feeds BOTH paths, so the export and the .srt always match the current EDL.
  "Download SRT" serializes `buildSrt(prepared)` to a text/plain `zero-edit-time.srt` via the
  same download-anchor helper as the MP4 — output-time by construction, so it lines up with
  the exported `zero-edit-time.mp4` as a sidecar pair for YouTube/LinkedIn closed captions —
  and disables with a hint when every caption's speech was cut. The "Burn captions into
  video" checkbox (default CHECKED, rendered only when captions exist) passes `prepared` to
  `runExport` when on and `[]` when off — zero prepared captions stages no font/SRT and takes
  the no-srtFile graph, byte-identical to Phase 5.5 and already covered by its tests.
- **Phase 9A, Parts A–M (done; stop here):** still-image-overlay timing, render planning,
  editor state, the local image media panel, quick-add placement presets, and source-time
  preview. Part A:
  `src/overlays/timing.ts` defines millisecond-based `SourceRange`, `RemovedRange`, and
  `ProjectedSourceSegment` contracts. `normalizeRemovedRanges` sorts and unions unsorted,
  overlapping, adjacent, nested, and duplicate half-open removals without mutating inputs;
  invalid/non-finite ranges are ignored and negative source bounds clamp to zero.
  `projectSourceRangeToOutputSegments` intersects a source-authored range with the surviving
  timeline and returns its chronologically ordered source pieces mapped onto concatenated
  OUTPUT milliseconds, accounting for every removal before each piece and never emitting a
  zero-length segment. A fully removed or invalid source range produces `[]`. The pure behavior
  is unit-tested in `src/overlays/timing.test.ts`. Part B: `src/overlays/types.ts` adds the
  serializable `OverlayAsset`, `ImageOverlay`, and `OverlayFit` domain contracts.
  Shared `normalizeImageOverlay` in `src/overlays/normalize.ts` normalizes source timing,
  in-frame geometry, opacity, z-index, and fades without mutation; invalid timing returns
  `null`. `buildImageOverlayRenderPlan`
  ignores invalid/missing-asset overlays, projects each valid overlay through removals, preserves
  z-order, applies fades only to the first/final surviving pieces (clamped to those pieces), and
  deterministically sorts by z-index → output start → overlay id. It is unit-tested in
  `src/overlays/renderPlan.test.ts`. Part C: pure immutable operations in
  `src/overlays/editorState.ts` add/remove assets, add/update/remove/duplicate/select overlays,
  cascade dependent overlays on asset removal, and move layers one rank forward/backward.
  Invalid references/timing and duplicate IDs are no-ops; duplicates take a caller-supplied ID
  and receive a visible position (or full-frame timing) offset. Forward/backward assigns a
  unique z-index immediately across the adjacent layer level, so equal-z ordering cannot depend
  on cut-sensitive output timing. A typed overlay reducer applies all operations against its
  latest supplied state. App owns the backward-compatible `[] / [] / null` overlay state in an
  atomic editor reducer and extends its ONE Undo history to snapshot EDL + overlay assets/layers,
  while selection remains ephemeral. The reducer always applies async EDL commits against the
  latest overlay state. Blob URLs stay live while referenced by current state or Undo history,
  are deduplicated across shared asset URLs, and are revoked only when unreachable or on
  disposal. Part D: `MediaPanel` accepts local PNG/JPEG/WebP files only, validates MIME before
  allocating a URL, decodes natural dimensions through an always-revoked temporary object URL,
  then stores a persistent blob URL (never base64) as an undoable asset. It shows thumbnails,
  filenames, dimensions, usage counts, and visible upload/decode errors. Unused assets remove
  directly; used assets confirm before the existing cascade removal, with the persistent URL
  retained while Undo can restore it. The D-required "Add at playhead" bridge creates the basic
  centered, aspect-preserving, contain-fit, opaque, no-fade, three-second source-time overlay
  above existing layers; EOF produces a visible seek-first error. Part E adds three pure
  quick-add presets through the SAME one-history-entry + ephemeral-selection path: Cutaway is
  full-frame `contain` for three seconds; Picture-in-picture is aspect-preserving at up to 30%
  frame width, bottom-right with a 4% safe margin, for three seconds; Logo is
  aspect-preserving at up to 12% width, top-right with the same margin, from playhead to source
  end. Tall PIP/logo assets shrink to the available 92% height without leaving the frame.
  "Add image over selected transcript range" is deliberately skipped: transcript selection is
  private local state in `Transcript.tsx`, and lifting/redesigning it is explicitly not required.
  Part F adds a pure `buildImageOverlayPreviewItems` derivation: it resolves valid assets,
  normalizes definitions, applies exact half-open SOURCE-millisecond visibility and a
  deterministic `min(fade-in, fade-out)` opacity envelope, then sorts simultaneous layers by
  z-index and id. `OverlayStage` renders that list as normalized absolute DOM images with
  contain/cover/stretch fit. Its fixed stacking context stays below the caption layer; a separate
  editor-only selection outline stays above captions. Overlay hitboxes opt into pointer events
  only in the explicit image-edit mode, which is entered automatically after adding an image and
  can be toggled beside the preview. Clicking an image selects ephemerally; clicking elsewhere on
  the video clears selection without preventing native controls. Part G adds pure normalized
  move/resize geometry in `transform.ts`: movement and all four corner directions clamp fully
  inside the frame, keep the opposite resize corner fixed, preserve the starting aspect ratio by
  default, and allow Shift to unlock width/height. `OverlayStage` owns the pointer-captured
  transform session and transient draft geometry, pauses playback at gesture start, updates only
  local React state during pointer movement, and dispatches exactly one existing
  `update-image-overlay` action on pointer-up. Pointer cancel or Escape discards the draft.
  Four labeled corner handles sit in the editor layer above captions; Delete/Backspace removes
  the selection unless focus is in a text editor, and Escape without a gesture clears selection.
  Removing the final overlay leaves edit mode. Part H adds `OverlayInspector`, shown from the full
  editor array whenever an image is selected (even if its time range is not visible at the
  playhead). Start/end and fade fields use source-millisecond `m:ss.mmm` formatting with strict
  seconds/clock parsing, visible errors, source/duration clamping, and blur/Enter as the single
  commit path; Escape restores the authoritative value. Fit and percentage opacity update the
  same overlay patch path. Layer order is a one-based back-to-front control backed by a pure
  deterministic reducer action that renumbers z-indices atomically; the existing one-step
  forward/backward actions remain available. Fill frame, centered reset position, duplicate, and
  delete also use the one overlay reducer/history; a full-frame duplicate chooses a backward
  timing offset near EOF so its range remains inside the source. Inspector text is only an
  ephemeral draft, keyed to authoritative field values so Undo never leaves stale local state.
  Part I adds a compact `OverlayTimelineTrack` below the existing EDL timeline. Every image gets
  a labeled filename row positioned against the full original SOURCE duration, so removed EDL
  ranges never shift overlay blocks. Clicking a block selects it and seeks to its start. Move and
  left/right trim gestures use pointer capture and an origin-based local draft, then commit both
  timing boundaries once on pointer-up through the same `update-image-overlay` path; cancel,
  lost capture, and Escape discard the draft. Pure timeline math clamps moves/trims to the source,
  preserves move duration, and enforces a 100 ms trim floor without expanding a valid pre-existing
  shorter near-EOF overlay. Arrow keys provide 100 ms keyboard move/trim steps (Shift: one second).
  Part J composites the current image overlays into exported MP4s. Pure
  `src/export/imageOverlays.ts` derives removed ranges as the complement of kept EDL segments,
  builds the existing output-time render plan, and turns it into deterministic ffmpeg image
  inputs/filter clauses. Each referenced asset is staged once under a generated MIME-derived VFS
  name; reused assets fan out through `split`. The graph fixes the base to even output dimensions,
  converts normalized rectangles to pixels, implements contain/cover/stretch, preserves PNG alpha,
  multiplies existing alpha by opacity, reproduces preview fade envelopes (including overlapping
  in/out fades), uses half-open output-time enables, and composites back-to-front with equal-z ID
  ordering matching preview. `buildExportArgs` assembles kept video into the overlay graph first,
  then burns captions from the composited output so captions stay above images; every existing
  audio clause and mapping is unchanged. `runExport` stages overlay bytes only when exporting,
  reuses them across the loudnorm fallback, checks ffmpeg's exit code, and best-effort deletes all
  generated image files on success, partial staging, or encode failure. `ExportButton` passes the
  current overlay state/render plan without constructing filters. Empty/non-surviving overlays keep
  the previous argument array byte-identical. Part K preserves the source-accurate split render plan
  (for example source 10–14 and 16–20 remains two provenance segments at adjacent output 10–14 and
  14–18), then `coalesceContinuousOverlaySegments` derives separate output-only compositor
  intervals. It merges adjacent pieces only for the same overlay/asset with identical geometry,
  fit, opacity, and layer, no fade on either side of the join, forward time progress, and endpoints
  equal within a one-nanosecond floating-point tolerance. The already-clamped first fade-in and
  final fade-out survive; source inputs are never mutated or falsely represented as contiguous.
  The ffmpeg graph counts asset uses after coalescing, so a cut-spanning logical overlay becomes one
  half-open enable window and one image branch with no boundary switch to flash or disappear.
  Part L completes the required 50-case unit/integration matrix using the existing offline Vitest
  suites: source projection edge cases, render-plan fades/layers/normalization, immutable editor
  operations, geometry at 1280×720 and 1920×1080, proportional/in-frame placement, every fit mode,
  safe/unique export filters and filenames, split/coalesced timing enables, captions-after-images,
  unchanged audio mapping, PNG alpha/opacity/fades, and the byte-identical empty-overlay path.
  Mocked-engine runtime tests cover staging, retry reuse, output, and cleanup without downloading
  ffmpeg or requiring large binary fixtures. Part M adds the concise browser end-to-end checklist
  at `docs/phase-9a-manual-verification.md`: setup/fixtures plus upload, preview, timeline, export,
  cut-continuity, alpha, captions, audio/lip-sync, progress, recovery, and result-recording checks.
  The document provides instructions and blank result fields; its existence does not claim a
  human browser run has passed. Phase 9A implementation is complete.
- **Phase 10, Parts A–R (done; stop here):** the typed export-time audio-cleanup settings model,
  pure settings-to-plan boundary, disabled-path compatibility seam, and conservative noise
  reduction, voice leveling, configurable loudness normalization, peak protection, and smoother
  EDL joins, locked filter ordering, and a dedicated pure FFmpeg audio builder. Part A:
  `src/export/audioCleanupSettings.ts` defines `NoiseReductionLevel`,
  `AudioCleanupSettings`, and the recommended enabled-by-default configuration (light noise
  reduction, voice leveling, -16 LUFS normalization, -1 dB true-peak limit, and smooth joins).
  Pure `normalizeAudioCleanupSettings` returns an independent value, clamps finite loudness
  targets to [-24, -10] LUFS and true-peak limits to [-6, 0] dB, and replaces non-finite targets
  with the documented defaults. Focused unit tests cover preservation/purity, both bounds, and
  non-finite recovery. Part B: `src/export/audioCleanupPlan.ts` defines a serializable,
  deterministic `AudioCleanupPlan`; `buildAudioCleanupPlan` normalizes through the shared Part-A
  boundary, gates every operation behind the master switch, maps off/light/strong noise intent,
  and carries validated loudness targets without FFmpeg strings, DOM objects, runtime instances,
  or input mutation. Unit tests cover defaults, global and individual disabling, shared clamping,
  determinism, and purity. Part C: `BuildExportOptions.audioCleanup` accepts the pure plan at the
  FFmpeg argument boundary; a globally disabled plan adds no Phase-10 filters and preserves the
  legacy command exactly, while individually disabled operations add no placeholder filters.
  Exact-array regression tests cover single and
  multiple segments plus existing loudnorm fallback, captions, and image-overlay combinations,
  preserving the legacy path byte-for-byte. Part D: enabled light or strong noise intent adds one
  `afftdn` after EDL concat and before the existing mastering tail; light is `nr=6:nf=-45`, while
  strong is `nr=12:nf=-40`. Noise-floor tracking stays off to avoid chasing speech, and existing
  segment-local declick fades remain unchanged. `runExport` accepts the plan as an optional final
  argument. It verifies actual core support on first attempted use; a missing `afftdn` retries
  without denoising, reports a visible `onNote` warning, and caches the result per shared FFmpeg
  instance so later exports do not retry an unsupported filter. The fallback composes with the
  existing missing-`loudnorm` retry. Part E: enabled voice-leveling intent adds one
  speech-oriented downward `acompressor` after optional denoising and before the legacy loudness
  tail: threshold 0.125 (~-18 dBFS), 3:1 ratio, 20 ms attack, 250 ms release, soft knee, RMS
  detection, maximum-channel linking, and no makeup gain (avoiding new clipping before later
  stages). A missing `acompressor` follows the same per-instance cached retry path, exports without
  leveling, and contributes a visible warning; multiple fallback warnings are combined into one
  `onNote` string so the existing UI cannot overwrite an earlier warning. Part F: enabled
  loudness intent uses the plan's validated LUFS target in the existing final one-pass `loudnorm`
  stage (default -16 LUFS), followed by the required 48 kHz resample. Single-pass avoids a full
  browser analysis pass plus parsed measurement plumbing and a second encode. Loudness-off omits
  `loudnorm`; global Phase-10 disable retains the exact legacy `I=-16:TP=-1.5:LRA=11` filter.
  The existing missing-loudnorm retry/warning continues to apply. Part G: an enabled cleanup plan
  uses its validated true-peak target (default -1 dB) in `loudnorm` when loudness is on and always
  appends a final look-ahead `alimiter` after the 48 kHz resample. The dB ceiling is converted to
  deterministic linear amplitude; the limiter uses 5 ms attack, 50 ms release, auto-level off,
  and latency compensation on so protection neither boosts toward the ceiling nor shifts A/V
  sync. A missing or option-incompatible `alimiter` retries without it, warns through the combined
  `onNote`, and caches the result per FFmpeg instance; loudnorm's matching TP remains a secondary
  guard when enabled. Global Phase-10 disable stays byte-identical. Part H keeps the proven 15 ms
  segment-local fade-in/out strategy and half-segment clamp, adding FFmpeg's `qsin` curve when
  smooth joins are enabled. It deliberately does not use overlap/crossfade, delay, or tempo
  filters, so source ranges, concat duration, A/V sync, and preserved `keep_gap_ms` breathing room
  are unchanged. Smooth-joins-off retains the exact legacy linear declick fades, rather than
  removing the existing click protection. Part I locks the complete order to segment trim/PTS
  reset → short join fades → non-overlapping concat → denoise → compression → loudnorm → 48 kHz
  resample → final limiter. Resampling precedes limiting because loudnorm internally outputs at
  192 kHz and the configured ceiling must be applied to the final encoded sample rate. The cleanup
  tail contains no timing filters; limiter latency compensation remains enabled. Integration tests
  combine multiple source ranges, captions, and image overlays and assert identical audio/video
  EDL bounds, PTS resets, shared concat timing, final labels, and mappings. Thus cleanup does not
  change project duration or desynchronize captions/overlays. Part J extracts every audio-filter
  string and configurable-number formatter into pure `src/export/audioCleanupFilters.ts`.
  `buildAudioCleanupFilterGraph` returns a deterministic label-free post-concat chain plus the
  internal fade curve, matching the existing single/multi-segment architecture without adding
  labels or changing disabled arrays; `buildAudioSegmentFilterChain` owns the segment-local trim,
  PTS reset, and fades. Labels remain stable in `buildExportArgs` (`[ca]`/`[outa]`). Numeric intent
  is bounded and serialized with fixed locale-independent decimals (no exponent or negative zero),
  and malformed runtime values cannot inject filter syntax. The module has no React, DOM, browser,
  or FFmpeg-instance dependency and is tested directly in Node; `ffmpeg.ts` re-exports prior
  public constants. Part K adds `src/export/audioFilterCapabilities.ts`, a lightweight tri-state
  (`unknown`/`supported`/`unsupported`) capability cache keyed by the already-loaded FFmpeg
  instance. Importing or reading it cannot create/load FFmpeg, and it executes no separate probe:
  the first requested real encode verifies the exact filter invocation, successful filters are
  cached, and precisely classified missing/incompatible filters are cached before the existing
  warned fallback retry. Generic media/encode failures remain fatal and do not alter capability
  state. Later exports skip known-unsupported filters without probing again. `acrossfade` remains
  an exposed candidate but deliberately unknown because Part H uses non-overlapping `afade=qsin`,
  not crossfades. Focused tests cover defaults, updates, immutable snapshots, per-instance
  isolation, actual-use recording, unrequested filters, unrelated failures, and cached loudnorm.
  Part L adds a compact, accessible `AudioCleanupControls` fieldset to the existing export section.
  Local React state starts from the recommended defaults and exposes only the master switch,
  Off/Light/Strong denoising, voice leveling, smooth joins, -14/-16/-18 LUFS presets, and a bounded
  dB peak input—never compressor/filter internals. Strong denoising shows a concise voice-quality
  warning. Turning cleanup off preserves but disables the detail choices; all settings lock while
  FFmpeg is loading or encoding. Node-side server-render tests cover defaults/options,
  internal-detail omission, the Strong warning, master gating, preserved values, and the busy
  state. Part M intentionally defers Original/Cleaned comparison under the phase specification's
  permitted limitation. The app has one shared but currently unserialized FFmpeg instance;
  transcription and export own separate busy state, use fixed VFS input/output names, and attach
  per-operation listeners to the same log/progress emitter. A third preview job could therefore
  overwrite, read, or delete another operation's files and mix progress or fallback-classification
  logs. Reusing `runExport` would unnecessarily H.264-encode a video, while `extractAudio`'s mono
  16 kHz transcription output would not be a truthful quality comparison. A safe implementation
  first needs centralized FFmpeg job serialization, unique per-job paths, and an on-demand bounded
  audio-only renderer with cleanup/fallback parity, player URL cleanup, and stale-result handling.
  No disabled or misleading comparison controls were added; live/generated comparison is not
  available. Part N completes final-export integration: `ExportButton` snapshots the current
  Part-L settings at click time, normalizes them through `buildAudioCleanupPlan`, and passes the
  resulting plan as the existing final `runExport` argument. The default UI now produces the full
  cleanup chain; turning the master switch off preserves the byte-identical legacy audio path.
  Captions-to-burn, image-overlay projection, source EDL segments, lazy loading, progress/error
  listeners, codec/container settings, and output download remain on their existing branches.
  Combined graph regressions require exactly two explicit mappings—processed `[outv]` and one
  processed `[outa]`—with no original or duplicate audio mapping; the path with every individually
  toggleable operation off also retains exactly one `[outa]` mapping. Part O keeps source-format
  handling metadata-neutral. FFmpeg discovers sample rate and channel layout from the decoded
  stream; the graph specifies only `aresample=48000` and never `-ac`, `aformat`, `pan`,
  `channelmap`, or a forced layout. The 48 kHz output target handles 44.1 kHz sources and returns
  loudnorm's internal 192 kHz output to the established encode rate; omitting channel directives
  is intended to preserve FFmpeg's negotiated mono/stereo layout into AAC. Offline regressions
  verify that invariant across legacy/default cleanup and single/concat paths: exactly one
  `aresample=48000`, no channel-rematrix directive, and one audio mapping. They do not pretend to
  execute real source formats. Actual CDN-wasm exports of mono/stereo × 44.1/48 kHz fixtures,
  inspected for output rate/layout and checked for sync/listening, remain manual verification.
  Part P adds an explicit video-only argument path plus input-specific runtime recovery. The
  normal command remains byte-identical; only FFmpeg's precise `:a ... matches no streams`
  diagnostic clears any failed-attempt output and retries the already-staged export with video
  trim/concat (`a=0`), overlays, and captions intact while omitting every audio input label,
  cleanup filter, `[outa]` map, and AAC option. That successful video-only retry does not mark any
  audio filter supported or unsupported and reports one visible note. Valid silent or almost-silent
  audio still attempts the established
  one-pass loudnorm path. If loudnorm itself fails with a non-finite loudness measurement, only
  loudnorm is removed for that export; denoising, voice leveling, 48 kHz resampling, and limiting
  remain, and loudnorm capability stays unknown because silence is an input condition rather than
  a core limitation. A neighboring generic malformed-input error is deliberately not classified
  as silence and remains fatal after one exec. One-millisecond clips retain nonnegative half-length
  fades. No `apad` or `-shortest` policy was added: multi-segment concat keeps FFmpeg's established
  shorter-stream handling, while real no/silent/short-audio media still requires browser-wasm
  fixture verification rather than being claimed by the mocked/offline suites. Part Q deliberately
  adds no persistence mechanism. This repository has no project serializer/deserializer, project
  file import/export, local/session storage, or persisted settings schema; its EDL, overlays, and
  export choices are an in-memory React editor session, and save/load remains explicitly out of
  scope. Audio-cleanup settings therefore stay in the existing mounted `ExportButton` state and
  start from a fresh clone of `DEFAULT_AUDIO_CLEANUP_SETTINGS`. There is currently no older project
  payload to migrate and no missing `audioCleanup` field to parse. A future shared project format
  must default an absent field through the same settings default/normalization boundary, but Part Q
  does not scaffold that future format or create audio-only `localStorage` behavior. Part R audits
  all 60 requested automated-test cases against the existing suites and adds the missing focused
  coverage. Settings tests now exercise every noise level and independently default NaN and both
  infinities. Pure Phase-10 integration tests feed no-cut, one-cut-through-speech, several-cut,
  closely-spaced-cut, and natural-pacing `removeSilences` EDLs into the real argument builder,
  checking paired A/V source bounds, stable labels, one audio map, preserved summed kept duration,
  three-or-more-segment concat, tiny fade clamping, and absence of retiming filters. Mocked runtime
  tests compose cleanup + captions + overlays, verify all VFS cleanup after a failed encode, keep a
  caller progress listener reachable, reject a missing required audio stage with a useful non-raw
  error, and cover successful finite loudnorm reports for nearly silent, very quiet, and already
  loud inputs. A no-DOM `ExportButton` harness verifies lazy load ordering, the default plan handoff,
  progress clamping/listener removal, and error recovery; a fully mocked engine suite proves import
  and pure filename work construct nothing, explicit access is singleton, and repeated load skips
  network setup. The normal suite remains offline: mono/stereo and 44.1/48 kHz are command-neutrality
  invariants, while actual sound, timestamps, and media decoding remain Part S manual verification.
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
  and unit-tested in `src/captions/` (`CaptionOverlay`, the Phase-8 `CaptionList`, and the
  App/ExportButton wiring are the only caption UI); the burn font is a committed asset, not a
  dependency. No caption timing edits, add/delete/split/merge, styling UI, SRT import, or
  karaoke timing.
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
  full-length segment) plus Phase-9A overlay editor state. Its single history snapshots both EDL
  and persistent overlay content in one reducer; `commitEdl` dispatches an atomic EDL commit,
  and `undo` pops the latest cross-feature edit while overlay selection remains ephemeral. Owns
  the file picker (which preloads the shared ffmpeg engine
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
  captions), and the `CaptionList` render. Video object URLs are revoked on replace/unmount;
  overlay blob URLs are retained across current state + Undo history and revoked only once
  unreachable or on unmount. Phase 9A Part D renders `MediaPanel` for local image
  upload/thumbnail/removal and dispatches its asset/layer changes through the same editor
  reducer. Part F renders `OverlayStage` from the same source-time playhead and adds the local
  image-edit-mode toggle; overlay selection still dispatches through the existing reducer and
  never adds an Undo entry. Part G pauses the video at transform start and receives one final
  geometry callback per completed drag/resize, dispatching it through `update-image-overlay` so
  each gesture is one persistent Undo step rather than one step per pointer event. Part H renders
  the selected `OverlayInspector`; its field commits reuse that exact generic update callback,
  while duplicate/layer/delete actions dispatch through the same atomic overlay reducer. Part I
  renders `OverlayTimelineTrack` on the full source scale; it selects/seeks ephemerally and sends
  one final timing patch through that callback per completed drag or trim.
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
- `src/captions/` — the caption layer (Phase 6 + Phase 8): pure and React-free except the two
  components (`CaptionOverlay`, `CaptionList`); no ffmpeg.
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
    fixed above Phase-9A images, and `pointerEvents: none` so the native controls stay clickable);
    returns null when no caption is active. Purely derived — no state, no canvas, no timers.
  - `CaptionList.tsx` — the Phase-8 editing surface (rendered near the transcript when
    `edl.captions` is non-empty): a scannable list in a transcript-style scrolling box, one
    row per caption (SOURCE mm:ss seek button + text), the playhead's row highlighted like
    the transcript's active word. Clicking the text opens an inline input (local `editingId`
    + `draft`; one row at a time); BLUR is the single commit path via `onEditText` (App's
    `editCaptionText` → `updateCaptionText`) — Enter blurs the input, Escape cancels via a
    `cancelledRef` the close-triggered blur checks. Display-only `CaptionOverlay` stays
    untouched — this is the READ-and-fix surface.
- `src/overlays/` — Phase 9A image-overlay work. Parts A–M exist. Domain/timing/state/preview
  derivation helpers remain pure and framework-free; React UI is isolated in `MediaPanel` and
  the preview/editor components.
  - `types.ts` — serializable still-image asset and source-time overlay definitions. Coordinates
    and dimensions are normalized to the video frame; timing and fades use milliseconds.
  - `normalize.ts` — the shared `normalizeImageOverlay` invariant boundary used by editor
    operations and render planning, avoiding a state-layer dependency on export planning.
  - `timing.ts` — pure, framework-free millisecond timing primitives:
    `normalizeRemovedRanges` canonicalizes arbitrary removed-range lists, and
    `projectSourceRangeToOutputSegments` splits a half-open source range around those cuts and
    maps each kept piece to the concatenated output clock. No React, DOM, assets, editor state,
    or ffmpeg.
  - `timing.test.ts` — Vitest coverage for the specification example, removals before/inside a
    range, complete removal, no intersection, complex normalization, half-open boundaries,
    invalid/zero-length inputs, and input immutability. Part L makes no-removal, before/after,
    overlap-start, and overlap-end projection cases explicit.
  - `renderPlan.ts` — `buildImageOverlayRenderPlan`, the deterministic export-ready projection
    of valid asset-backed overlays. It re-exports `normalizeImageOverlay` for compatibility.
    Split overlays retain fades only on their outer surviving pieces; no ffmpeg strings are
    generated here.
  - `renderPlan.test.ts` — Vitest coverage for normalization, missing/invalid assets and
    overlays, cut splitting, fade ownership/clamping, deterministic ordering, and immutability.
  - `editorState.ts` — backward-compatible overlay editor state defaults and immutable operations
    for assets, overlays, selection, duplication, and unambiguous layer ordering, plus a typed
    `overlayEditorReducer` for applying those operations against current state. Also provides
    `collectOverlayObjectUrls`, the pure reachability helper App uses across current state + Undo
    snapshots before revoking blob URLs. Part H adds atomic direct positioning by a one-based
    back-to-front rank; real moves deterministically assign sequential z-indices in one edit.
  - `editorState.test.ts` — Vitest coverage for all Part-C operations, identity no-ops,
    cascading removal, normalization, selection, duplicate offsets, tied layer ordering, and
    shared object-URL reachability.
  - `imageFiles.ts` — exact PNG/JPEG/WebP MIME validation plus browser dimension decoding via a
    temporary object URL that is revoked in `finally`; the persistent asset URL is created only
    after decode succeeds. `imageFiles.test.ts` covers accepted/rejected MIME types, dimensions,
    decode failures, invalid dimensions, and URL cleanup with injected test dependencies.
  - `defaultOverlay.ts` — the shared pure quick-add factory + next-layer helper: the centered
    40%-width default plus Part-E Cutaway, Picture-in-picture, and Logo presets. Timing stays in
    source milliseconds; all geometry is normalized; PIP/logo share a 4% safe area and shrink
    tall images without distorting them. `defaultOverlay.test.ts` covers exact preset
    timing/geometry, aspect preservation, safe-area clamping, invalid/EOF inputs, immutability,
    and layer choice.
  - `preview.ts` — pure source-time preview derivation. It filters invalid/missing-asset layers,
    reuses shared normalization, applies base opacity plus fade envelopes, maps stretch to CSS
    fill, and returns simultaneous layers in deterministic back-to-front order.
    `preview.test.ts` covers half-open visibility, ordering, missing assets, defensive
    normalization/immutability, fit mapping, base opacity, both fade ramps and their overlap,
    and invalid inputs.
  - `OverlayStage.tsx` — memoized DOM preview for visible items. Percent geometry and CSS
    object-fit render image layers in a bounded z-index context below captions. Part G keeps
    pointer gesture state and draft geometry local, uses pointer capture for move/resize, and
    commits once on release. The selected editor layer above captions supplies four labeled
    corner handles with arrow-key resizing, Shift-unlocked free resizing, minimum on-screen
    size, Escape cancel/clear, and input-safe Delete/Backspace removal.
  - `transform.ts` — pure normalized move and four-corner resize math. It clamps full geometry
    inside the frame, preserves the fixed opposite corner and aspect ratio by default, supports
    independent dimensions when unlocked, enforces configurable minimums, and normalizes
    defensive numeric inputs without mutation. `transform.test.ts` covers all handle directions,
    aspect-locked and free resizing, minimum and frame bounds, invalid values, and immutability.
  - `inspector.ts` — pure Part-H value/derived helpers: millisecond-precise compact source
    timestamp formatting and parsing, source-bound clamping, percentage opacity parsing,
    fill/center geometry, and deterministic layer rank/availability. `inspector.test.ts` covers
    exact round trips, malformed values, clamping, geometry purity, and tied layer ordering.
  - `OverlayInspector.tsx` — selected-image controls for source timing, fades, fit, opacity,
    direct/relative layer order, fill/reset, duplication, and deletion. Text fields own only
    temporary strings/errors and commit once on blur/Enter through App's shared overlay update;
    invalid drafts never enter editor state and Escape cancels them.
  - `timeline.ts` — pure Part-I source-time track math: block fractions, pixel-to-source deltas,
    and immutable move/start-trim/end-trim drafts with source bounds and a 100 ms minimum.
    `timeline.test.ts` covers scale conversion, both movement clamps, both trim boundaries,
    minimum and sub-minimum ranges, invalid inputs, no-op identity, and immutability.
  - `OverlayTimelineTrack.tsx` — one compact labeled row per image on the original source scale.
    It owns only the pointer-captured timing draft, commits one final range through App on release,
    cancels without mutation, and exposes separate keyboard-accessible move and trim controls.
  - `MediaPanel.tsx` — compact upload/thumbnail list with filename, dimensions, usage count,
    default/preset Add actions, removal confirmation for used assets, busy state, and visible
    errors. A source-id key/unmount guard prevents a slow decode from entering a replacement
    document.
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
  - `engine.test.ts` — Part-R fully mocked proof that importing the module or calling
    `inputExtension` constructs/loads nothing, first explicit access creates one singleton, and a
    completed load prevents repeat CDN/core setup without making a network request.
- `src/export/` — the Phase-5 export plus Phase-9A Parts J–L image compositing/timing/tests, a read-only
  consumer of the one EDL and overlay state. Fully client-side; no proxy and no React in the
  testable core.
  - `audioCleanupSettings.ts` — Phase-10 Part-A typed intent model and defaults for export-time
    cleanup. `normalizeAudioCleanupSettings` is pure and clamps LUFS/true-peak targets to their
    supported bounds, using documented defaults for non-finite values. Parts L/N wire that model
    through the controls and final export; Part Q intentionally leaves it in mounted React state
    until a shared project persistence boundary exists.
  - `audioCleanupSettings.test.ts` — unit coverage for valid-value preservation, input purity,
    lower/upper clamping, and independent NaN/positive-infinity/negative-infinity fallback behavior.
  - `audioCleanupPlan.ts` — Phase-10 Part-B pure translation from normalized editor intent to a
    serializable cleanup plan. It gates nested operations behind the global switch and deliberately
    contains no FFmpeg syntax or browser/runtime objects.
  - `audioCleanupPlan.test.ts` — unit coverage for default mapping, master and per-operation
    disabling, explicit off/light/strong noise intent, validated targets, determinism, and input
    immutability.
  - `audioCleanupFilters.ts` — Phase-10 Part-J pure FFmpeg audio builder. It owns the legacy and
    cleanup filter constants, bounded/locale-independent numeric serialization, deterministic
    post-concat chain construction, and segment-local trim/fade construction. It returns no new
    labels because `buildExportArgs` retains the established `[ca]`/`[outa]` orchestration.
  - `audioCleanupFilters.test.ts` — offline coverage for the exact disabled chain, complete order,
    each stage independently, runtime fallback overrides, bounds/no-exponent/no-negative-zero
    formatting, malformed-value injection rejection, determinism, immutability, legacy segment
    strings, smooth curves, and tiny-segment clamping.
  - `audioFilterCapabilities.ts` — Phase-10 Part-K lazy-safe, per-FFmpeg-instance tri-state cache
    for candidate audio filters. It learns from actual requested encodes instead of running a
    separate `-filters` probe, allowing the runtime to skip verified-unsupported stages later.
  - `audioFilterCapabilities.test.ts` — offline coverage for unknown defaults, attempt decisions,
    isolated updates, per-instance caching, and immutable returned snapshots.
  - `AudioCleanupControls.tsx` — Phase-10 Part-L controlled, accessible export-settings fieldset.
    It normalizes edits through the shared settings boundary and exposes only simple user intent;
    nested values remain intact when the master switch is off.
  - `AudioCleanupControls.test.tsx` — server-rendered UI coverage for recommended defaults and
    presets, the Strong warning, absence of low-level parameters, master/detail disabling, and
    busy-state locking.
  - `imageOverlays.ts` — pure export adaptation: derives removed source ranges from kept EDL
    segments, calls `buildImageOverlayRenderPlan`, and builds deterministic image-input/filter
    metadata. Generated numeric VFS names and `ov*` labels keep user filenames/IDs out of ffmpeg
    syntax; each unique asset is one looped input and repeated uses consume `split` branches. The
    graph scales the kept-video base to even dimensions, maps normalized geometry to bounded pixel
    rectangles, implements contain (transparent pad), cover (center crop), and stretch, preserves
    straight PNG alpha while multiplying opacity, applies alpha fades in output time, gates each
    segment with a half-open enable, and chains layers in preview-equivalent back-to-front order.
    Part K adds `OverlayCompositeInterval` + `coalesceContinuousOverlaySegments`: the source-aware
    plan stays split around cuts, while visually identical same-overlay pieces that touch on the
    output clock (with no boundary fade) collapse before asset split/use counting and graph
    generation. Outer fades remain exactly as assigned by the Part-B render plan.
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
    byte-identical to Phase 5.5. Part J's optional `imageOverlayGraph` instead assembles kept video
    into `[ovbase]`, appends the image-only graph, maps `[ovout]` directly when captions are off,
    or feeds `[ovout]` into subtitles when they are on. The graph's extra `-i` args stay between
    the source input and `-filter_complex`; existing audio generation and `[outa]` mapping do not
    change. With no overlay graph, every prior args-array variant remains byte-identical. Phase-10
    Part C adds an optional pure `audioCleanup` plan to `BuildExportOptions`; a globally disabled
    plan emits the exact legacy argument array, and individually disabled operations add no
    placeholder filters.
    Phase-10 Part D translates enabled noise intent into one post-concat `afftdn` before the
    legacy mastering tail (`nr=6:nf=-45` for light; `nr=12:nf=-40` for strong), leaving per-segment
    fades unchanged. Phase-10 Part E appends the conservative `SPEECH_COMPRESSOR` after optional
    denoising and before loudnorm, with no makeup gain. Phase-10 Part F builds the one-pass
    `loudnorm` target from `AudioCleanupPlan.loudness.targetLufs` (default -16), omits it when that
    operation is disabled, and retains the legacy constant when Phase 10 is globally disabled.
    Phase-10 Part G feeds the plan's peak target to loudnorm and adds a final post-resample
    `alimiter` with deterministic dB-to-amplitude conversion, auto-level disabled, and latency
    compensation enabled. Phase-10 Part H adds `curve=qsin` to the same short, clamped per-segment
    fades when smooth-join intent is enabled; it does not overlap or retime segments, while
    smooth-joins-off preserves the legacy linear fades. Phase-10 Part I documents and regression-
    locks the complete post-concat order; the tail contains no duration-changing filters and the
    resample intentionally precedes the latency-compensated final limiter. Phase-10 Part J moves
    this syntax into `buildAudioCleanupFilterGraph` and segment trim/fade syntax into
    `buildAudioSegmentFilterChain`; `buildExportArgs` only composes their pure results with its
    stable labels, video, captions, and overlays. Phase-10 Part K consults the lazy-safe
    per-instance capability cache after staging and records only filters attempted in a successful
    encode; known-unsupported filters are skipped with the established warning, while unknown
    filters are verified by their first real use. Phase-10 Part O deliberately supplies only the
    48 kHz output rate—no channel-count/layout directive—so decoded mono and stereo layouts remain
    negotiated end to end. Phase-10 Part P adds `BuildExportOptions.includeAudio`; its default is
    true and preserves every established array, while false builds video-only trim/concat (using
    `a=0` for multiple segments), overlay, caption, mapping, and codec syntax without constructing
    any audio filter graph. Float seconds pass straight through for frame accuracy; re-encodes
    (never `-c copy`, which only cuts
    on keyframes). Alongside it, `runExport` (using
    the shared engine's `inputExtension`) writes the source into the VFS — plus, when given
    non-empty PREPARED captions, the committed font (fetched same-origin from
    `/fonts/Roboto-Bold.ttf` into `/fonts` in the VFS; `createDir` guarded) and the `buildSrt`
    output as `captions.srt` — runs the one exec (capturing the log; on a "No such filter:
    loudnorm" failure it retries without loudnorm and reports via `onNote`; a "No such filter:
    subtitles" failure throws a clear error instead — never a drawtext fallback), optionally
    stages each generated overlay image once for both normal/fallback attempts, checks a nonzero
    ffmpeg exit code before reading output, reads the MP4 back as a Blob, and best-effort frees the
    VFS (input, output, font, SRT, and every planned image path) in a `finally`. Part D's optional
    cleanup-plan argument runtime-verifies `afftdn` through the first real encode: a missing filter
    retries without noise reduction, warns through `onNote`, and is cached per FFmpeg instance;
    this composes with the existing loudnorm fallback. Part E applies the same behavior to a
    missing `acompressor`, caching support per instance and retrying without voice leveling;
    fallback messages are consolidated into one final `onNote` call per export. Part G likewise
    runtime-verifies and caches `alimiter`; missing-filter or incompatible-option failures retry
    without the limiter while retaining the rest of cleanup. Part K consolidates those results
    plus loudnorm into the shared tri-state cache; precise missing-filter failures downgrade, the
    limiter also recognizes its fixed option incompatibility, and unrecognized failures stay
    fatal rather than silently removing cleanup. Part P adds two non-cached input fallbacks: the
    exact missing-source-audio diagnostic retries video-only, and a loudnorm-specific non-finite
    silence failure retries without that stage. Successful silent normalization is accepted;
    malformed input remains fatal. Video-only success records no audio-filter support.
    The engine instance + CDN loader live in `src/ffmpeg/engine.ts`.
  - `ExportButton.tsx` — the Export section: gets the shared engine via `getFfmpeg()`/`loadFfmpeg()`
    from `src/ffmpeg/engine.ts` (no longer holds its own instance), loads it if needed (distinct
    "Loading engine…" state), encodes with a progress bar, and downloads `zero-edit-time.mp4`.
    Disabled while busy and when nothing is kept. Routes `runExport`'s non-fatal fallback notes
    into its existing error line (no new UI). Phase 8: a render-time
    `prepareCaptionsForExport(edl.captions, edl)` feeds both the burn and "Download SRT"
    (`buildSrt` → text/plain `zero-edit-time.srt` via the same download helper as the MP4;
    output-time, so it matches the exported file; disabled with a hint when every caption was
    cut), and the "Burn captions into video" checkbox (default checked, shown only when
    captions exist) passes the prepared captions to `runExport` when on and `[]` when off
    (no font/SRT staged; the Phase 5.5-identical no-srtFile graph). Part J also derives the current
    overlay render plan from the EDL/assets/layers and passes it plus source dimensions to
    `runExport`; FFmpeg filter construction remains outside React. Phase-10 Part L renders the
    audio-cleanup fieldset and owns its normalized local settings state, disabling edits during
    loading/encoding. Part M deliberately adds no comparison control: a safe on-demand audio
    preview requires shared-engine job serialization and a bounded audio-only render path that do
    not exist yet. Phase-10 Part N builds the plan from those settings at export click time and
    passes it to `runExport` without changing caption/overlay inputs, EDL ranges, progress/error
    handling, lazy engine loading, or download behavior. Part Q leaves settings in the same local
    mounted-editor state as the burn-caption export choice. No project persistence boundary exists
    to extend, so it adds neither an EDL field nor a parallel storage/migration format; a fresh
    mount clones the recommended defaults.
  - `ExportButton.test.tsx` — Part-R no-DOM orchestration harness. It invokes the real click handler
    with mocked hooks/engine/runtime to verify load-on-demand ordering, normalized default-plan
    handoff, progress clamping, listener removal on success/failure, download reachability, and
    visible error-state recovery without loading FFmpeg.
  - `ffmpeg.test.ts` — Vitest unit tests for `buildExportArgs` (2-segment concat, 1-segment
    no-concat, exact float bounds and fade times, the tiny-segment fade clamp, the
    loudnorm→aresample tail on both paths, the video chain unchanged, and the loudnorm-off
    fallback option; with `srtFile`: the exact subtitles clause — force_style hardcoded verbatim
    so a style regression fails — on both paths, composition with `loudnorm: false`, and
    no-`srtFile` graphs staying byte-identical to Phase 5.5; Part J image inputs, single/multiple
    kept-video routing, unchanged audio, captions after overlays, and the byte-identical empty
    overlay path; and Phase-10 Part-C exact-array coverage for globally disabled and all-
    cleanup plans across the established export variants and per-operation omission; plus Part-D
    light/strong `afftdn` settings, post-concat ordering, unchanged join fades, Part-E compressor
    parameters/ordering, Part-F configurable single-pass LUFS targets and loudness-off path, and
    Part-G configurable limiter ceiling/order/latency compensation, and Part-H curved/linear join
    paths, tiny-segment clamp, and no-retiming invariants; and Part-I exact full-pipeline ordering
    plus combined EDL/caption/image-overlay synchronization; Part N additionally locks the full
    cleanup chain and exactly one processed-audio mapping for the combined path, plus one audio
    mapping when every individually toggleable operation is off; Part O locks the format-neutral
    rate/layout invariant across legacy/default and single/concat paths; Part P locks single- and
    multi-segment video-only graphs (including captions/overlays), absence of all audio syntax, a
    one-millisecond cleanup path, and absence of newly invented padding/shortest policy), run
    offline with no ffmpeg.
  - `phase10.integration.test.ts` — Part-R pure cross-layer coverage that carries real EDL and
    `removeSilences` results into `buildExportArgs`: no cut, a speech cut, several cuts, closely
    spaced cuts with a tiny kept segment, and two naturally paced silent-gap removals. It asserts
    deterministic labels, paired trim/PTS bounds, three/four-segment concat, a single cleanup tail
    and audio map, equal enabled/disabled video clauses, summed kept duration, and no retiming
    filters; these are command invariants, not a claim about decoded-media timestamps.
  - `imageOverlays.test.ts` — pure coverage for EDL-complement derivation/projection, safe
    asset deduplication and input splitting, fit/geometry at even output dimensions, PNG alpha +
    opacity, normal and overlapping fades, half-open enables, deterministic/equal-z layer order,
    validation, label collision protection, and input immutability. Part K adds the exact 10–20 /
    14–16-cut provenance example, single-window no-flash graph generation, multiple-join
    coalescing, outer-fade preservation, strict non-merge boundaries, floating-point adjacency,
    and coalescing immutability. Part L adds cross-resolution proportional geometry, defensive
    in-frame pixel bounds, non-coalesced unique branches/exact enables, and fade-present/absent
    assertions; together with the timing, render-plan, editor-state, and ffmpeg suites this covers
    the complete required 50-case matrix.
  - `ffmpeg.runtime.test.ts` — mocked-engine coverage for unique VFS staging, generated exec args,
    loudnorm retry without restaging, MP4 output, and best-effort cleanup after success or partial
    staging failure. Phase 10D adds missing-`afftdn` retry/warning/cache coverage and verifies that
    afftdn and loudnorm fallbacks can occur sequentially in one export. Phase 10E adds cached
    missing-`acompressor` retry and warning coverage. Phase 10G adds cached missing-`alimiter`
    retry and warning coverage. Phase 10K adds tri-state actual-use recording, unrequested-filter
    preservation, unrelated-failure safety, and cached missing-`loudnorm` coverage. Phase 10P adds
    precise no-audio video-only retry, non-cached silence-specific loudnorm bypass, accepted silent
    success, and malformed-stream one-attempt fatality coverage. Part R adds combined
    cleanup/caption/overlay staging and success, all-file cleanup after failed exec, caller progress
    continuity, a required-audio-stage fatal message with unchanged capabilities, and finite
    near-silent/quiet/already-loud diagnostic paths. Every engine/runtime dependency remains mocked.
- `docs/phase-9a-manual-verification.md` — Part M's concise human browser checklist. It defines
  fixtures and pass observations for image upload/decode, source-time preview/editor behavior,
  timeline interactions, overlay/caption export across cuts, PNG alpha, audio/lip-sync, progress,
  controlled failure recovery, and issue recording; it is not an automated pass claim.
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
