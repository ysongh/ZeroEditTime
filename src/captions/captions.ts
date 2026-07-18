// Pure caption layer (Phase 6, Part A) — no React, no DOM, no ffmpeg. The
// timebase model in three lines:
//
// - Captions are STORED in SOURCE seconds inside `edl.captions` — consistent
//   with segments, regenerable, and undoable through the same history.
// - They are GENERATED from kept words only (midpoint kept, the same
//   `isSourceTimeKept` predicate that drives transcript strike-through).
// - They are BURNED in OUTPUT time (the exported file's clock = the
//   concatenated kept timeline), mapped via `sourceTimeToEdlTime`.
//
// `prepareCaptionsForExport` defensively re-clips stored captions against the
// CURRENT EDL, so cutting more after generating never produces captions for
// deleted speech.

import type { Caption, EDL } from '../edl/types'
import type { Transcript, Word } from '../transcript/types'
import {
  isSourceTimeKept,
  sourceTimeToEdlTime,
  totalKeptDuration,
} from '../edl/edl'
import { endsSentence } from '../transcript/sentences'

/** A caption line never grows beyond this many words. */
export const MAX_CAPTION_WORDS = 5

/**
 * A pause between kept words longer than this (measured in OUTPUT time) starts
 * a new caption. Output time is the perceptually correct measure: a 3 s source
 * gap across a cut is 0 s in the export (no break), while a kept pause is a
 * real break the viewer hears.
 */
export const CAPTION_GAP_S = 0.8

/**
 * Minimum on-screen duration in the export. A shorter caption is extended,
 * clamped so it never overlaps the next caption or runs past the end.
 */
export const MIN_CAPTION_S = 0.7

/** A caption mapped to OUTPUT time (the exported file's clock), ready to burn. */
export type PreparedCaption = { text: string; start: number; end: number }

/**
 * Deterministic id from the caption's source bounds, mirroring `makeSegment`'s
 * `seg_${start}_${end}` pattern: kept words are ordered and non-overlapping, so
 * `start` is unique within a generation, and regenerating from the same
 * transcript+EDL reproduces the same ids (no counters, no randomness).
 */
function makeCaption(words: Word[]): Caption {
  const start = words[0].start
  const end = words[words.length - 1].end
  const text = words.map((w) => w.text.trim()).join(' ')
  return { id: `cap_${start}_${end}`, text, start, end }
}

/**
 * Chunk the KEPT words of the transcript into captions, in SOURCE time. Words
 * whose midpoint falls in a removed range are skipped entirely. Walking the
 * kept words in order, a new caption starts before word `w` when any of:
 *
 * - the current chunk already holds `MAX_CAPTION_WORDS` words;
 * - the previous word ends a sentence (terminal punctuation);
 * - the OUTPUT-time gap from the previous kept word exceeds `CAPTION_GAP_S`
 *   (so a huge source gap that is entirely cut away does NOT break the line).
 *
 * Empty transcript or nothing kept yields [].
 */
export function buildCaptions(transcript: Transcript, edl: EDL): Caption[] {
  const kept = transcript.words.filter((w) =>
    isSourceTimeKept(edl, (w.start + w.end) / 2),
  )

  const captions: Caption[] = []
  let chunk: Word[] = []

  for (const word of kept) {
    const prev = chunk.at(-1)
    if (prev) {
      const outputGap =
        sourceTimeToEdlTime(edl, word.start) - sourceTimeToEdlTime(edl, prev.end)
      if (
        chunk.length >= MAX_CAPTION_WORDS ||
        endsSentence(prev.text) ||
        outputGap > CAPTION_GAP_S
      ) {
        captions.push(makeCaption(chunk))
        chunk = []
      }
    }
    chunk.push(word)
  }
  if (chunk.length > 0) {
    captions.push(makeCaption(chunk))
  }

  return captions
}

/**
 * Replace one stored caption's text (Phase 8 inline editing). Times, ids,
 * order, and segments are untouched — this edits WHAT a caption says, never
 * when it shows. Internal newlines collapse to spaces (the SRT/burn path is
 * single-line) and the text is trimmed.
 *
 * Returns the SAME `edl` reference — the caller's no-op signal, so no history
 * entry is recorded — when the id is unknown, the trimmed text is empty, or
 * the trimmed text equals the current text.
 */
export function updateCaptionText(edl: EDL, id: string, text: string): EDL {
  const cleaned = text.replace(/\s*\n+\s*/g, ' ').trim()
  if (cleaned === '') {
    return edl
  }
  const index = edl.captions.findIndex((c) => c.id === id)
  if (index === -1 || edl.captions[index].text === cleaned) {
    return edl
  }
  const captions = edl.captions.slice()
  captions[index] = { ...captions[index], text: cleaned }
  return { ...edl, captions }
}

/**
 * Map stored (source-time) captions to OUTPUT time against the CURRENT EDL,
 * ready for the SRT burn:
 *
 * - Intersect each caption with the kept segments; a caption whose speech was
 *   entirely cut is DROPPED, a partially-cut one is clipped to its first/last
 *   kept instants. A caption spanning a cut simply stays on screen across the
 *   join — the output-time mapping collapses the removed middle to nothing.
 * - Enforce `MIN_CAPTION_S` by extending too-short captions, clamped to the
 *   next caption's start (no overlaps) and to the total kept duration.
 *
 * Returned sorted by output start.
 */
export function prepareCaptionsForExport(
  captions: Caption[],
  edl: EDL,
): PreparedCaption[] {
  const prepared: PreparedCaption[] = []

  for (const caption of captions) {
    // Segments are ordered and disjoint, so the overlapping ones are a
    // contiguous run; the first/last bound the kept instants of the caption.
    const overlapping = edl.segments.filter(
      (seg) => seg.start < caption.end && seg.end > caption.start,
    )
    if (overlapping.length === 0) {
      continue
    }
    const clippedStart = Math.max(caption.start, overlapping[0].start)
    const clippedEnd = Math.min(
      caption.end,
      overlapping[overlapping.length - 1].end,
    )
    prepared.push({
      text: caption.text,
      start: sourceTimeToEdlTime(edl, clippedStart),
      end: sourceTimeToEdlTime(edl, clippedEnd),
    })
  }

  prepared.sort((a, b) => a.start - b.start)

  const total = totalKeptDuration(edl)
  for (let i = 0; i < prepared.length; i++) {
    const cap = prepared[i]
    if (cap.end - cap.start < MIN_CAPTION_S) {
      const nextStart = i + 1 < prepared.length ? prepared[i + 1].start : Infinity
      const extended = Math.min(cap.start + MIN_CAPTION_S, nextStart, total)
      // Only ever extend — the clamps must not shrink an already-longer end.
      if (extended > cap.end) {
        cap.end = extended
      }
    }
  }

  return prepared
}

/**
 * Format seconds as an SRT timestamp: "HH:MM:SS,mmm" — COMMA before the
 * milliseconds (SRT, not WebVTT). All fields zero-padded; negatives clamp to 0.
 */
export function formatSrtTime(s: number): string {
  const totalMs = Math.max(0, Math.round(s * 1000))
  const ms = totalMs % 1000
  const totalSeconds = (totalMs - ms) / 1000
  const sec = totalSeconds % 60
  const min = Math.floor(totalSeconds / 60) % 60
  const hr = Math.floor(totalSeconds / 3600)
  const pad = (n: number, width: number) => String(n).padStart(width, '0')
  return `${pad(hr, 2)}:${pad(min, 2)}:${pad(sec, 2)},${pad(ms, 3)}`
}

/**
 * Serialize prepared (output-time) captions as an SRT document: 1-indexed
 * blocks of "N\nSTART --> END\nTEXT\n\n". Caption text is forced single-line —
 * a stray newline would otherwise split one cue's text into two lines.
 */
export function buildSrt(prepared: PreparedCaption[]): string {
  return prepared
    .map((cap, i) => {
      const text = cap.text.replace(/\s*\n+\s*/g, ' ').trim()
      const start = formatSrtTime(cap.start)
      const end = formatSrtTime(cap.end)
      return `${i + 1}\n${start} --> ${end}\n${text}\n\n`
    })
    .join('')
}
