# AI Clarity Edit — sentence mapping

Part 1 implements the pure local foundation in
[`src/clarity/sentences.ts`](../src/clarity/sentences.ts). It is not wired into
the editor yet: there is no Clarity tab, model request, preview, or Apply action.

`buildClaritySentenceCatalog(transcript, edl)` groups the original transcript
using the existing sentence parser. IDs use original inclusive word-index spans
(`sentence:12:18`), so repeated wording remains distinct and earlier cuts do not
renumber surviving sentences. IDs are scoped to that transcript; they do not
establish freshness across source or transcript replacement. Later proposals must
also capture their source, transcript, kept ranges, and analysis settings.

All local ranges are half-open **original-source seconds**. A removable sentence
has its entire spoken envelope kept and no overlap with any outside word.
Adjacent structural EDL splits count as continuous coverage; any positive cut
inside a sentence, including a cut through silence, protects it. Removal ranges
contain only the sentence envelope, without padding into adjacent speech or
silence. This module calculates ranges but does not apply cuts.

The local catalog retains original wording for display. Use
`buildClaritySentenceContext(catalog)` for the separate context projection:

- Only fully audible word runs carry transcript text.
- Existing cuts separate runs with `cut` markers; partly audible words use
  `partial-word` markers without their original text.
- Fully removed sentences are omitted, even if inner silence remains.
- Protected sentences have no removal range and are marked non-removable.
- Durations include kept silence within each sentence envelope. They are not the
  full edited-video duration, which also includes silence outside sentences.

Malformed text, nonfinite/invalid/out-of-source timings, reversed word order,
or invalid EDL ranges produce an error. Inputs are never silently sorted,
clamped, or mutated. Overlapping words within one sentence use the maximum end
time; overlap across sentence boundaries protects the affected sentences.

The existing punctuation-based parser can split abbreviations and treats an
unpunctuated transcript as one sentence. This step does not change that policy.
Range eligibility does not prove a sentence is unnecessary, establish proposal
freshness, or make a combined removal safe. Semantic analysis, bounded request
validation, protection against removing all speech, and editor integration belong
to the later implementation steps.

Verification for this step uses offline mapping/context tests. Browser playback,
live-model quality, and exported-media checks do not apply to this isolated module
and have not been performed for AI Clarity Edit.
