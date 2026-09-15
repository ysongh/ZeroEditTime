# Phase 11 retake-recommendation manual verification

Use real spoken recordings to check whether the advice is useful, conservative,
and tied to the correct original-source section. False positives matter: a
section that normal editing can repair should not require another recording.

This checklist has not been executed. Blank fields and unchecked items are not
passes. The [Part W test matrix](phase-11-test-coverage.md) records offline,
mocked coverage; it does not establish live-model accuracy, real playback,
clipboard access, or screen-reader behavior.

## Result key

- **PASS** — performed and met every listed criterion.
- **FAIL** — performed, but at least one criterion failed; include missed retakes
  and unnecessary recommendations.
- **BLOCKED** — attempted but could not assess it, for example because
  transcription or the model service was unavailable.
- **NOT RUN** — not attempted.
- **N/A** — a conditional feature is not implemented; explain why. Do not use
  this for an implemented feature that missed a case.

## Setup and evidence

1. From the repository root, run `pnpm exec netlify dev` and open its printed
   URL. Plain `pnpm dev` does not serve the transcription/AI functions. Follow
   the [local end-to-end setup](../README.md#local-end-to-end):
   `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` belong in the uncommitted server-side
   `.env`, never browser code or a verification report.
2. Use recordings you have permission to send for transcription and AI review.
   Transcription uploads extracted audio; retake analysis sends bounded
   transcript context, not the raw recording. These services require network
   access and may incur API charges. The first audio-extraction engine load also
   needs access to the existing FFmpeg CDN.
3. Load one recording, wait for its duration, and click **Transcribe**. Wait for
   transcription to finish before running export, since they share an engine.
   Listen to the source and compare the transcript before judging retakes.
4. Run **Check for retakes** in the **Retakes** panel, not an editing command in
   the Agent bar. Record the initial result before dismissing or resolving cards.
   Use a fresh page session and reload/retranscribe the fixture for an independent
   run; unchanged successful decisions may be reused within the same session.
5. Keep the actual transcript wording, relevant word timings, source ranges,
   on-screen outcomes, and your listening observations with each result. Browser
   Network details for `/api/transcribe` and retake-mode `/api/agent` requests can
   help explain a miss. Do not publish raw HAR files, credentials, or unrelated
   private transcript text. There is no in-app candidate-debug inspector.

- Date/time, tester, and commit:
- Browser/version and operating system:
- Playback device and optional screen reader/version:
- Fixture filenames, source durations, and recording conditions:
- Service/configuration notes (no secrets):

### Interpret results correctly

The current local screen requires at least one strong signal within a sentence:
at least three filler occurrences at a density of at least 30%, an internal pause longer
than two seconds with at least five timestamped words, or at least two detected
stumble spans. It does not detect an incomplete thought from punctuation alone.
See [heuristics.ts](../src/retakes/heuristics.ts).

Transcription may remove spoken fillers/restarts or change sentence boundaries.
Record that discrepancy rather than silently replacing the transcript with a
synthetic fixture. If an expected retake is missed, keep the end-to-end result
FAIL and note whether the evidence was lost during transcription, excluded by
screening, or sent to the model and rejected. If the cause cannot be established,
say unknown. Do not count a screening miss as proof of a negative model decision.

The model sees only selected sections and bounded nearby context. **No retakes
recommended** can also mean local screening produced no candidates; it does not
mean AI reviewed every sentence or listened to the recording. A partial outcome
or **Couldn’t check for retakes.** is not a clean result. Record the failed-section
count or error and assess available advice separately.

## Run ledger

Record filenames, observations, and results here; repeat rows for additional runs.
Seeking and script checks require actual recommendations. If none can be obtained,
mark those attempted checks BLOCKED, not PASS.

| Case | Fixture / source range | Result | Observations / issue |
| --- | --- | --- | --- |
| Clean recording | | NOT RUN | |
| Clean second take | | NOT RUN | |
| No clean take | | NOT RUN | |
| Incomplete thought | | NOT RUN | |
| Filler-heavy: repairable / awkward | | NOT RUN | |
| Audio-quality detection | | N/A | No audio-quality measurements feed candidate detection. |
| Seeking before / after cuts | | NOT RUN | |
| Suggested scripts | | NOT RUN | |
| Card workflow / keyboard spot check | | NOT RUN | |

## Clean recording

Record a clean 30–60 second explanation in your usual speaking style. Include
ordinary conversational pauses and an occasional filler; do not deliberately
create repeated failures.

- [ ] Run **Check for retakes**. Expect zero recommendations, or very few with a
      specific, independently justified need for re-recording.
- [ ] No recommendation targets an ordinary pause, isolated filler, accent,
      dialect, or natural speaking style.
- [ ] For any recommendation, listen to its exact section and explain why normal
      editing would not suffice. Log unjustified advice as a false positive.

## Clean second take

Record the following, keeping the retry close to the abandoned attempt:

```text
The app lets you...
actually let me do that again.

The app lets you automatically remove filler words.
```

- [ ] The usable second take prevents an unnecessary recommendation to record
      this thought again. If advice appears, record both takes' timings and the
      transcript/context actually available to analysis.
- [ ] Listen to the complete second take; its meaning must genuinely replace the
      failed one. An unrelated nearby sentence is not a clean replacement.

Local suppression proves only conservative cleaned-wording matches or certain
repairable restart chains. Semantic alternatives depend on the model's bounded
context. A zero-result run may have made no model call; note that distinction
instead of claiming the model recognized the retry.

## No clean take

State the intended topic clearly, then record several incomplete versions of one
sentence without ever finishing it. For example, establish that you are explaining
automatic filler-word removal, then repeatedly abandon that explanation. Retain
the actual source and transcript; do not append a usable final take.

- [ ] A recommendation identifies the failed section without flagging unrelated
      surrounding speech.
- [ ] Its reason explains why deleting the failed starts would still leave no
      usable explanation, rather than just counting repetitions.
- [ ] A useful suggested script expresses the already-established meaning in a
      complete, natural sentence. Assess it using **Suggested scripts** below.

If the intended completion was never established, an omitted script is safer than
invented content. Record the script criterion as unverified/BLOCKED and make a
separate clearly grounded recording to assess it; do not call the whole case PASS.

## Incomplete thought

Start explaining a concrete point, stop halfway through its sentence, and move
to a different topic without completing the original point.

- [ ] Expect a recommendation for the abandoned thought, with a reason grounded
      in what is actually missing.
- [ ] The unrelated next topic is not treated as a successful alternate take.

A semantic-only abandonment without a strong local signal may currently be
missed. Keep this as a real end-to-end test: record such a miss as FAIL with the
screening limitation, not N/A or a pass. An additional recording with an audible
internal hesitation or repeated failures can exercise the screened path, but
must not replace the original failed case in the ledger.

## Filler-heavy section

Record two versions: a complete, coherent thought with many removable fillers,
and an unfinished or awkward thought that remains unusable after filler removal.
Check that the actual transcript retains the fillers before drawing conclusions.

- [ ] The repairable version does not receive unnecessary retake advice.
- [ ] The awkward version receives advice only when removing fillers would still
      leave a problem. The reason describes that remaining problem.
- [ ] Compare the source with the result of the existing filler-removal command
      if needed; ordinary filler cleanup remains an editing task. Restore the
      comparison cuts with Undo before evaluating another variant.

## Audio issue (conditional)

Currently **N/A**: there is no measured audio-quality or transcript-confidence
input to the local screen. Phase 10 settings are not evidence that a section is
noisy, clipped, or unintelligible. Do not claim that retake analysis listens to
audio or diagnoses noise from the transcript.

If audio-quality candidate detection is added later, record matched clean,
mild-noise, and substantially noisy/clipped speech. Use safe listening levels and
the [Phase 10 listening checklist](phase-10-manual-verification.md) to compare
exported cleanup; the in-app source preview is not cleaned audio.

- [ ] Mild noise alone does not trigger a retake.
- [ ] Strong noise/clipping prompts a recommendation only where available cleanup
      is unlikely to make the speech usable. Record cleanup settings, output
      filenames, fallback notes, and the remaining audible issue.

If current transcript-based advice asserts an unsupported audio diagnosis while
testing another case, record that as a failure, not as audio-detection coverage.

## Seeking

For every actual recommendation, record the original-source bounds. The visible
clock is compact; hover its card timestamp for source seconds with milliseconds.

- [ ] Before cuts, click the card's **Play**. It starts at the affected original
      section, plays the intended speech, then pauses at the section end. Record
      any wrong start, missing words, or audible overrun.
- [ ] Pause, then click its **Retakes** timeline marker. It selects and seeks to
      the source start without starting playback. This is a seek action, not the
      card's bounded Play action.
- [ ] Delete an earlier source range using the existing editor, keeping at least
      one segment. Without rerunning analysis, verify the card bounds and marker
      position still use the original source, not the shorter output clock.
- [ ] Cut through the recommended section while retaining other footage. The
      card's **Play** still auditions the original section, including cut speech;
      it does not skip that evidence or restore it to the EDL.
- [ ] After the bounded preview finishes, ordinary playback follows the EDL again.
      A marker seek alone does not bypass EDL skipping during subsequent ordinary
      playback. Undo the test cuts and repeat the source navigation.

## Suggested scripts

For every **Suggested retake**, compare the suggestion with the source, transcript,
and available surrounding context, then read it aloud.

- [ ] It preserves intended meaning and important qualifications; it does not
      invent product capabilities, numbers, facts, or promises.
- [ ] It is a complete, natural spoken replacement, not unnecessarily verbose
      instructions or a critique of the speaker.
- [ ] **Copy script** pastes the exact script into a local scratch document,
      without the display-only surrounding quotes. **Copied.** reflects an actual
      successful copy. If permission fails, expect retryable error feedback.
- [ ] A card without a script has no empty suggestion block or Copy button. Scripts
      are optional when context cannot support a faithful completion; omission
      does not validate script quality.

## Card workflow and keyboard spot check

Use advice whose original result has already been recorded.

- [ ] **Dismiss** removes its card and marker. **Mark as re-recorded** does the
      same for another card; it only marks advisory status and does not record,
      upload, or insert replacement media.
- [ ] Closing all advice shows **0 open recommendations.**, not a new claim that
      analysis found the recording clean. Neither action creates an edit to undo.
- [ ] Tab through panel actions and markers; activate with Enter/Space. Focus is
      visible, severity is readable text, and selection has a non-color cue.
      Removing the focused card moves focus to a remaining card or panel control.
- [ ] With the chosen screen reader, confirm action names include the title and
      source range, and status/copy feedback is announced. If no screen reader is
      available, mark this check NOT RUN rather than inferring accessibility.

## Completion

- Overall result: NOT RUN
- Failed/blocked/unrun cases:
- False positives and missed retakes, with source ranges:
- Actual transcript excerpt/timings and expected vs. observed advice:
- Reproduction steps, sanitized error/status text, and follow-up issue/owner:

- [ ] Every applicable case has a recorded result, with supporting real-recording
      evidence. The conditional audio case has its applicability recorded.
- [ ] Failures and limitations remain visible; mocked tests are not substituted
      for listening, browser behavior, or live-model quality.
- [ ] Any later code fix is followed by `pnpm test`, `pnpm build`, `pnpm lint`,
      and a repeat of the affected manual case.

This is Part X's verification guide only. It does not complete Part Y's
performance/cost review or Part Z's backward-compatibility review.
