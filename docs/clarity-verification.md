# AI Clarity Edit — verification handoff

Part 6 completes the implementation verification and adds reproducible checks.
Use the [Clarity workflow and contracts](clarity-edit.md) for product behavior,
limits, cancellation, and the short [real-recording checklist](clarity-edit.md#manual-recording-checklist-pending).

## Offline coverage

| Requirement | Main coverage |
| --- | --- |
| Stable sentence IDs, exact ranges, earlier cuts, protected fragments/overlaps | `src/clarity/sentences.test.ts` |
| Bounded input, unknown IDs, duplicates, empty/malformed/all-speech results | `src/clarity/context.test.ts`, `analysis.test.ts`, `netlify/clarityAgent.test.ts` |
| Cancellation, late replies, source/transcript/range/settings freshness | `src/clarity/analysisApi.test.ts`, `freshness.test.ts`, `src/App.test.tsx` |
| Selected durations, unmet targets, local wording, explicit requests, hidden panels | `src/clarity/review.test.ts`, `ClarityPanel.test.tsx`, `src/App.test.tsx` |
| Temporary playback, Discard/history/export isolation, stale callbacks | `src/App.test.tsx` |
| Latest-state Apply, one Undo, no-op/double Apply, caption/overlay/audio/retake preservation | `src/clarity/edit.test.ts`, `src/App.test.tsx` |
| Accepted cuts through caption/SRT timing, overlay projection and audio/video export arguments | `src/clarity/exportIntegration.test.ts` |
| Existing editing and retake relay compatibility | `netlify/agent.test.ts`, `netlify/clarityAgent.test.ts` |

The three new export integration tests use real pure preparation functions with
existing gaps, multiple selected/deselected removals, hand-edited captions,
spanning/removed-only overlays, audio cleanup settings, and caption burning off.
They do not encode media. Existing offline App tests mock browser media and network.

Run the standard checks from the repository:

```bash
pnpm build
pnpm lint
pnpm test
```

On **2026-11-07**, build and lint passed; **1,515 tests across 66 files** passed.
Both verification scripts passed `node --check`, and the live script's dry run
completed with zero network requests.

## Generated-media browser check

Use Node 25+ and installed Google Chrome. In two terminals:

```bash
pnpm dev --host 127.0.0.1 --port 4173 --strictPort
node scripts/verify-clarity-browser.mjs
```

`CHROME_BIN` overrides the default macOS Chrome path; `CLARITY_BROWSER_URL` can
select another loopback development server. The script launches an isolated
headless profile and requires access to the app's pinned FFmpeg CDN. It generates
a ten-second static image with a 440 Hz tone using the app's shared FFmpeg engine.
Media loading, extraction, playback, caption generation, and encoding are real;
transcription/model replies and the download destination are replaced locally.
No API key or user recording is used.

The script checks an actual seek across the proposed cut, exports during preview,
applies once, exports again, undoes once, and exports again. It decodes all three
MP4s, checks duration and audio signal, checks runtime errors/request counts, and
captures desktop/mobile screenshots plus a frame from the applied export.
Its printed temporary artifact directory contains `report.json`, three MP4s,
and the PNGs. These files are local evidence, not committed test fixtures.

Observed on **2026-11-07**:

| Export | Video duration | Decoded audio duration |
| --- | --- | --- |
| During temporary preview | 10 s | 10 s |
| After Apply | 9 s | 9 s |
| After one Undo | 10 s | 10 s |

Playback emitted a real seek from 2.15 to 3.00 seconds across the selected cut.
All three outputs decoded with a nonzero audio signal. Exactly one mocked analysis
and one mocked transcription occurred, with no browser runtime exceptions.
Screenshots at 1480×1100 and 390×844 were visually inspected, with no horizontal
page overflow; the applied output frame visibly retained its burned caption.
This checks actual encoding and playback mechanics for a generated fixture. A
static image and tone do not establish speech-boundary quality, lip synchronization,
or real-recording overlay/audio-cleanup quality.

## One live model check

```bash
node scripts/verify-clarity-live.mjs --dry-run
# Makes one paid request using ANTHROPIC_API_KEY from the environment or .env:
node scripts/verify-clarity-live.mjs
```

The dry run validates and prints synthetic context without a network request.
The live invocation calls the production relay handler directly with that context,
validates its result through the client contract, and derives cuts without mutating
the original edit. It makes no retries, sends no recording, and logs no key.
It tests the handler/upstream contract, not deployed Netlify HTTP routing.

On **2026-11-07**, one request to the configured `claude-sonnet-4-6` model completed
in about 3.3 seconds. It suggested the repeated explanation and unrelated notebook
tangent. The setup, private-token caveat, main benefit, and final verification step
were retained. The locally calculated duration changed from 21.5 to 14.75 seconds,
above the 12-second target; no follow-up request forced the target.
This is one observed synthetic case, not a general semantic-quality result.

## Still pending

Run the [manual recording checklist](clarity-edit.md#manual-recording-checklist-pending)
on representative spoken demos: judge useful/coherent suggestions, listen around
sentence boundaries, and inspect caption/overlay alignment and audio quality in
the exported files. No real recording or live Whisper transcription was used in
the checks above. No general conclusion about model quality or media compatibility
follows from these fixtures.
