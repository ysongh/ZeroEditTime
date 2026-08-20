# Phase 10 audio-cleanup manual verification

Use this checklist for a real browser export and headphone-listening pass. An
unchecked item or blank result means it has not been verified. This document's
existence does not claim that any browser, media, or listening check passed.

Use real spoken recordings for every speech-quality comparison; the edge cases
intentionally include silence and video-only media. Compare downloaded files in
the same external player at the same system/player volume. The in-app preview
plays the unprocessed source signal while following the current EDL and has no
Original/Cleaned comparison player.

## Result key

- **PASS** — performed and met every listed criterion.
- **FAIL** — performed and one or more criteria failed.
- **BLOCKED** — could not perform it, including when the relevant optional
  FFmpeg filter fell back as unavailable.
- **NOT RUN** — not attempted.

Do not count a successful fallback export as proof that the skipped cleanup
stage works. Record its exact on-screen note.

## Setup

1. Run `pnpm dev` and open the printed local URL in a supported desktop browser.
   If transcription, generated captions, or agent-created cuts are needed, use
   `pnpm exec netlify dev` with the project's existing `OPENAI_API_KEY` and
   `ANTHROPIC_API_KEY` setup instead.
2. Use headphones. Disable playback-device enhancements such as automatic
   volume leveling, noise cancellation, spatial audio, or EQ, and keep playback
   volume fixed across each comparison.
3. After every export, rename the downloaded `zero-edit-time.mp4` immediately so
   the browser's duplicate-filename suffixes cannot confuse the comparison.
4. Type a Peak limit value, then click outside that field before exporting; the
   value is committed on blur.
5. Record this run before checking any result:

   - Date/time:
   - Commit:
   - Tester:
   - Browser/version:
   - Operating system:
   - Headphones/playback device:
   - Fixed player/system volume:
   - FFmpeg core requested by the app: `@ffmpeg/core` 0.12.10 ESM CDN build
   - General notes/issues:

The first uncached core load needs network access for the approximately 31 MB
FFmpeg download. File selection may preload it, so `Loading engine…` can be
brief or absent. Do not run transcription and export at the same time; they
share one FFmpeg instance.

Successful fallback notes and fatal errors use the same crimson status line. A
fallback counts as a successful degraded export only when an MP4 downloads; a
fatal error does not. Record the exact text immediately because the next export
clears the line.

## Fixtures

Record the actual files used. A fixture may cover more than one row.

| Fixture | Required content | File and source metadata |
| --- | --- | --- |
| Baseline/sync | 45–90 seconds of clear speech, visible lips, pauses, an audible filler, a repeated take, and recognizable visual events | |
| Steady-noise set | 20–30 seconds of speech plus room tone; collectively cover a computer fan, AC, and low constant hiss | |
| Voice dynamics | One speaker moving between intentionally quiet, normal, and loud speech without source clipping | |
| Loudness triplet | The same real speech at quiet, normal, and loud input gains | |
| Mono 44.1 kHz | Real speech | |
| Mono 48 kHz | Real speech | |
| Stereo 44.1 kHz | Real speech with distinguishable left/right content | |
| Stereo 48 kHz | Real speech with distinguishable left/right content | |
| Video-only | Video with no audio stream | |
| Digital silence | Video with an audio stream containing silence | |
| Nearly silent | Very low-level but intelligible speech | |
| Very short | A very short spoken clip | |

Across the format fixtures, include at least one MP4 and one MOV that the app
already supported before Phase 10. Prefer the same known-supported video/audio
codecs so a codec difference does not get mistaken for an audio-cleanup issue.

## Settings reference

The `Audio cleanup` fieldset defaults to:

- `Improve voice audio`: checked
- `Noise reduction`: `Light`
- `Level voice volume`: checked
- `Smooth edit joins`: checked
- `Loudness target`: `-16 LUFS`
- `Peak limit`: `-1 dB`

Turning `Improve voice audio` off selects the pre-Phase-10 export path; it is not
untouched source audio. That legacy path still has linear 15 ms declick fades,
legacy loudness normalization, and 48 kHz resampling. Turning only Noise
reduction off leaves the other cleanup stages enabled. Turning Smooth edit joins
off retains the legacy linear fades; on uses the new curved fades, and neither
mode overlaps or crossfades audio.

Settings remain only in the mounted editor and reset after a reload or source
replacement. Write down the settings used for every comparison.

## Baseline

Use one identical source and EDL for all three exports. Record the cut boundaries
so the project can be reproduced. Compare against a saved export from the last
pre-Phase-10 revision (`335dc56`) or produce that reference in a separate
checkout. If no real pre-Phase-10 reference is available, mark that comparison
BLOCKED rather than inferring a pass.

| Export | Settings | Output filename | Visible note | Result |
| --- | --- | --- | --- | --- |
| Pre-Phase-10 reference | Historical build | | | |
| Current OFF | `Improve voice audio` unchecked | | | |
| Current ON | Recommended defaults | | | |

- [ ] Current OFF matches the pre-Phase-10 reference in retained content,
      timing, perceived sound, and join behavior.
- [ ] Current OFF introduces no new click, pop, dropout, or drift.
- [ ] ON changes only the exported audio; source playback and the EDL remain
      unchanged.
- [ ] Both current exports download, open, and contain exactly one audible audio
      track.
- Baseline result/observations:

## Noise reduction

Use the steady-noise fixtures with no cuts. Keep cleanup on, Level voice volume
off, and every loudness/peak/join setting identical. For each fan, AC, and hiss
condition, change only Noise reduction and export Off, Light, and Strong.

| Noise condition | Variant | Output filename | Noise/timbre/artifact observation | Visible note | Result |
| --- | --- | --- | --- | --- | --- |
| Computer fan | Off | | | | |
| Computer fan | Light | | | | |
| Computer fan | Strong | | | | |
| AC | Off | | | | |
| AC | Light | | | | |
| AC | Strong | | | | |
| Low room hiss | Off | | | | |
| Low room hiss | Light | | | | |
| Low room hiss | Strong | | | | |

- [ ] Light audibly reduces the steady noise bed compared with Off.
- [ ] Speech remains intelligible and natural with Light.
- [ ] Strong reduces more steady noise than Light.
- [ ] Strong causes no unacceptable metallic ringing, robotic chirping,
      lisping, hollowing, or intelligibility loss.
- [ ] Selecting Strong displays `Strong noise reduction may alter voice quality.`
- [ ] No export reports that `afftdn` was unavailable. If it does, fallback
      visibility may pass, but the affected listening result is BLOCKED.
- Noise-reduction result/observations:

## Voice leveling

Use the voice-dynamics fixture with no cuts. Keep cleanup on, Noise reduction
Off, and every other setting identical. Export once with `Level voice volume`
unchecked and once with it checked.

| Variant | Output filename | Quiet/loud/timbre observation | Visible note | Result |
| --- | --- | --- | --- | --- |
| Leveling off | | | | |
| Leveling on | | | | |

- [ ] Quiet words are easier to understand with leveling on.
- [ ] Loud phrases are controlled without sounding flattened or distorted.
- [ ] There is no excessive pumping, breathing/noise swell, transient smearing,
      or unnatural voice change.
- [ ] No export reports that `acompressor` was unavailable. If it does, fallback
      visibility may pass, but the leveling result is BLOCKED.
- Voice-leveling result/observations:

## Loudness and peak safety

Use the quiet, normal, and loud versions of the same real speech. Keep cleanup
on, Noise reduction Off, Level voice volume off, Loudness target at `-16 LUFS`,
Peak limit at `-1 dB`, and playback volume unchanged. Then export the normal
fixture again at `-14 LUFS` and `-18 LUFS` with all else unchanged.

| Input/target | Output filename | Perceived level/clipping observation | Optional measured LUFS/peak | Visible note | Result |
| --- | --- | --- | --- | --- | --- |
| Quiet / -16 | | | | | |
| Normal / -16 | | | | | |
| Loud / -16 | | | | | |
| Normal / -14 | | | | | |
| Normal / -18 | | | | | |

- [ ] Quiet, normal, and loud inputs have reasonably consistent perceived speech
      level after export.
- [ ] The -14 LUFS export is predictably louder than the -18 LUFS export.
- [ ] No export has audible clipping, crackle, or flattened/distorted peaks.
- [ ] No export reports that `loudnorm` or `alimiter` was unavailable. If one is
      skipped, mark the corresponding normalization or peak result BLOCKED.
- [ ] If a trusted meter is available, record its readings without requiring an
      exact -16 LUFS or -1 dB result: normalization is one-pass and AAC encoding
      can shift measured peaks slightly.
- Loudness/peak result/observations:

## Join smoothing

Create one EDL containing every difficult boundary below. Record the source-time
cut ranges, then export it three times: with the cleanup master off, with cleanup
on and `Smooth edit joins` unchecked, and with cleanup on and Smooth edit joins
checked. Keep all other settings identical.

| Required boundary | Cut range/how created | Cleanup master off | Cleanup on, smoothing off | Cleanup on, smoothing on |
| --- | --- | --- | --- | --- |
| Silence → speech | | | | |
| Speech → speech | | | | |
| Mid-sentence filler removal | | | | |
| Repeated-take removal | | | | |
| Very short retained pause | | | | |
| At least five closely spaced cuts | | | | |

- Cleanup-off output filename/result:
- Cleanup-on/smooth-off output filename/result:
- Cleanup-on/smooth-on output filename/result:
- [ ] The smoothed export contains no click or pop at any boundary.
- [ ] It contains no unnatural gap, doubled consonant, smeared word, or audible
      overlap.
- [ ] Retained consonants and word starts/ends are not perceptibly clipped.
- [ ] All three variants contain the same retained speech in the same order and have
      the same duration within one source frame or 50 ms.
- Join-smoothing result/observations:

## Combined synchronization

Use visible lip movement and at least ten cuts distributed from the beginning to
the end, including naturally paced silence removal with `keep_gap_ms = 250`.
Generate and burn captions, add a visible image overlay that spans at least one
cut, and export with cleanup on. Also export the identical project with cleanup
off for a duration/timing comparison.

Use `Transcribe` and wait for both preparation/transcription phases. In the agent
command box, enter a request such as “remove silences longer than 600 ms and keep
250 ms of each gap,” then select `Run`. Add manual/transcript cuts until the EDL
contains at least ten cuts. Only then select `Generate captions` and leave `Burn
captions into video` checked. Under `Images`, use `Upload image`, seek before a
cut, and use `Add as logo`, or configure another overlay range that crosses a
cut.

| Checkpoint | Source/output time or word | Lip-sync | Caption-sync | Overlay-sync |
| --- | --- | --- | --- | --- |
| Beginning | | | | |
| Middle | | | | |
| End | | | | |

- Cleanup-off filename/duration:
- Cleanup-on filename/duration:
- Visible fallback notes:
- [ ] Lip-sync is correct at all three checkpoints and does not worsen toward
      the end.
- [ ] Burned captions stay on the corresponding spoken words before and after
      cuts.
- [ ] Image overlays appear on their intended visual/source events and remain
      aligned across a cut.
- [ ] There is no duplicated, echoed, dropped, or progressively drifting audio.
- [ ] ON and OFF output durations differ by no more than one source frame or
      50 ms.
- [ ] Export progress remains visible, the UI returns to idle, and each MP4
      downloads and opens.
- [ ] Exporting does not change the EDL, captions, overlays, or source playback.
- Synchronization result/observations:

## Format matrix

Export real spoken mono and stereo fixtures at both 44.1 and 48 kHz with cleanup
on. Include an MP4 and, if that exact container/codec combination was already
supported, a MOV. A MOV failure is a Phase-10 regression only if the same source
worked before Phase 10.

If desktop `ffprobe` is available, inspect each downloaded file:

```bash
ffprobe -v error -select_streams a \
  -show_entries stream=index,sample_rate,channels,channel_layout \
  -of default=noprint_wrappers=1 zero-edit-time.mp4
```

| Source | Container/codecs | Input rate/channels | Output rate/channels/layout | Playback/sync observation | Result |
| --- | --- | --- | --- | --- | --- |
| Mono 44.1 kHz | | | | | |
| Mono 48 kHz | | | | | |
| Stereo 44.1 kHz | | | | | |
| Stereo 48 kHz | | | | | |
| Supported MOV | | | | | |

- [ ] Every supported source previews and exports successfully.
- [ ] Every output is a playable MP4 with intelligible, synchronized speech.
- [ ] Output audio is 48 kHz where metadata inspection is available.
- [ ] Mono remains one channel and stereo remains two channels; otherwise mark
      the metadata check BLOCKED rather than relying on listening alone.
- [ ] Metadata shows exactly one audio stream, and identifiable left/right
      content reveals no unexpected channel loss, swapping, or rematrixing.
- Format result/observations:

## Silent, no-audio, and short media

These browser-media checks complement the offline Part-R tests.

- [ ] A video-only source with cleanup and a visible overlay exports a playable
      silent MP4, preserves its video/overlay, and reports
      `The source has no audio track — exported video without audio.`
- [ ] Digital-silence audio exports without bursts or added noise. Normal success
      or the explicit silent-loudness fallback note is acceptable and recorded.
- [ ] Nearly silent speech stays playable and synchronized without a sudden
      blast, clipping, raw non-finite error, or catastrophic noise amplification.
- [ ] A very short spoken clip exports completely with nonnegative duration,
      correct sync, and no click or pop.
- Edge-fixture filenames, exact notes, and results:

## Runtime filter support

Package/version presence alone does not confirm a filter. A successful real
browser export that requests a stage and produces no corresponding fallback
warning confirms that exact invocation in this core.

| Stage | How requested | Status | Exact warning/result |
| --- | --- | --- | --- |
| `afftdn` | Light or Strong export | Confirmed / Unsupported / Not run | |
| `acompressor` | Level voice volume on | Confirmed / Unsupported / Not run | |
| `loudnorm` | Cleanup export | Confirmed / Unsupported / Not run | |
| `alimiter` | Cleanup on | Confirmed / Unsupported / Not run | |
| `atrim`, `asetpts`, `afade`, `aresample` | Successful audio export | Confirmed / Fatal failure / Not run | |
| `acrossfade` | Not used by Phase 10 | N/A | |

- [ ] Every successful optional-filter fallback produced a visible note naming
      the omitted treatment; no degraded export was silently described as fully
      cleaned.
- [ ] Any missing required audio-processing stage caused a clear fatal export
      error rather than an untreated success.
- Runtime-support observations:

## Optional performance measurements

These fields begin unverified. Blank fields mean no benchmark was run, and the
single-command design alone is not a timing result.

`Improve voice audio` off is the legacy export path, not stream copy or a raw
audio path. It still decodes and re-encodes the media, applies EDL trims and
linear join fades, performs legacy one-pass loudness normalization, and
resamples to 48 kHz. The comparison below measures only the incremental cost of
the Phase-10 denoising, compression, curved fades, configurable normalization,
and limiting.

Default cleanup runs inside the existing FFmpeg command without a separate
analysis, decode, or encode pass, but its extra audio filters still consume CPU
and may increase browser export time. The first use of an unavailable optional
filter can also trigger one or more warned retries; later exports on that engine
skip the cached unsupported stage. Do not report a fallback run as full-cleanup
performance.

### Startup and lazy loading

Use production builds of the current commit and pre-Phase-10 revision
`335dc56` in separate checkouts. Keep the browser/profile, cache policy,
hardware, power state, and preview-server setup identical. Perform five reloads
of each build before selecting a source and compare medians.

In the browser Network panel, confirm that neither `ffmpeg-core.js` nor
`ffmpeg-core.wasm` is requested before source selection. Selecting a file
intentionally begins the existing background preload and is outside this
startup measurement.

| Build | Five load measurements (ms) | Median (ms) | Core requested before source selection? | Result/notes |
| --- | --- | --- | --- | --- |
| Pre-Phase-10 `335dc56` | | | | |
| Current commit | | | | |

For a consistent browser navigation measurement, run this after each load:

```js
const navigation = performance.getEntriesByType('navigation')[0]
console.table({
  domContentLoadedMs:
    navigation.domContentLoadedEventEnd - navigation.startTime,
  loadMs: navigation.loadEventEnd - navigation.startTime,
})
```

### Warm export timing

Use one real spoken fixture, one unchanged EDL, and identical caption and image
settings. First perform one untimed default-cleanup export to finish the core
download, WebAssembly initialization, filter-capability learning, and warm-up.
Then alternate five master-OFF and five recommended-default ON exports. Keep the
browser, hardware, power state, and background workload unchanged.

Time from activating `Export MP4` until the UI returns to idle and the download
starts. Record every visible note. If either measured variant falls back, report
it as degraded/unsupported and exclude that pair from the supported-path
comparison; master OFF still requests legacy `loudnorm` and can fall back.

| Iteration | Order | Master OFF (s) | Default ON (s) | Visible notes (OFF/ON) |
| --- | --- | --- | --- | --- |
| 1 | OFF → ON | | | |
| 2 | ON → OFF | | | |
| 3 | OFF → ON | | | |
| 4 | ON → OFF | | | |
| 5 | OFF → ON | | | |
| Median | | | | |

- Fixture filename/codecs/source duration:
- Kept duration, segment/cut count, captions, and overlays:
- OFF median:
- ON median:
- Difference in seconds and percentage of OFF:
- Run-to-run spread:
- Observed impact/materiality:
- Performance result: PASS / FAIL / BLOCKED / NOT RUN

Only call an increase material when it repeats outside the observed run-to-run
spread. OFF-versus-ON cannot isolate `loudnorm`, because one-pass loudness
normalization already exists in the legacy OFF path. Do not attribute a timing
difference to one filter without a separate controlled measurement.

## Completion

- Overall result: PASS / FAIL / BLOCKED / NOT RUN
- Failed/blocked items:
- Reproduction steps:
- Browser console output:
- Source fixture description:
- Exact settings and on-screen message:
- Follow-up issue/owner:

- [ ] Every required Baseline, Noise reduction, Voice leveling, Loudness, Join
      smoothing, Synchronization, and Format check has a recorded result.
- [ ] Every failure or blocked result has enough detail to reproduce it.
- [ ] Any code fix is followed by `pnpm test`, `pnpm build`, `pnpm lint`, and a
      repeat of the affected listening/export scenario.
