// Interactive transcript — one of two views onto the single EDL (the timeline is
// the other). It does NOT hold its own "deleted words" state: a word renders
// struck-through iff its MIDPOINT is not kept by the current EDL, recomputed
// every render via `isSourceTimeKept`. So a timeline cut strikes the matching
// words for free, and Undo un-strikes them — no bespoke sync.
//
// Editing maps a word/sentence span to a source range and calls `onDeleteRange`,
// which funnels through the App's single EDL commit path. Selection is purely
// local UI: index-based, never derived from native DOM text selection.

import { useState } from 'react'
import type { MouseEvent } from 'react'
import type { EDL } from '../edl/types'
import { isSourceTimeKept } from '../edl/edl'
import Icon from '../ui/Icon'
import { formatClock, formatSeconds, formatShortClock } from '../ui/time'
import type { Transcript } from './types'
import { groupSentences } from './sentences'

/** An advisory source range (original-source ms), e.g. an open retake. */
type FlaggedRange = { startSourceMs: number; endSourceMs: number }

type TranscriptProps = {
  transcript: Transcript
  /** The single source of truth; struck-through state derives from it. */
  edl: EDL
  /** The video's current source time, in seconds. */
  currentTime: number
  onSeek: (sourceTime: number) => void
  /** Remove the source range [start, end] from the EDL (a word/sentence span). */
  onDeleteRange: (start: number, end: number) => void
  /** Words inside these ranges get a dotted underline. Display only. */
  flaggedRanges?: readonly FlaggedRange[]
}

/** Anchor/focus word indices of a contiguous selection; null when nothing is selected. */
type Selection = { anchor: number; focus: number }

function wordClassName(
  struck: boolean,
  active: boolean,
  selected: boolean,
  flagged: boolean,
): string {
  let name = 'word'
  if (flagged && !struck) name += ' word--flagged'
  if (active) name += ' word--active'
  if (struck) name += ' word--cut'
  if (selected) name += ' word--selected'
  return name
}

export default function TranscriptView({
  transcript,
  edl,
  currentTime,
  onSeek,
  onDeleteRange,
  flaggedRanges = [],
}: TranscriptProps) {
  const { words } = transcript
  const [selection, setSelection] = useState<Selection | null>(null)

  const sentences = groupSentences(words)
  const activeIndex = words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  )

  const selLo = selection ? Math.min(selection.anchor, selection.focus) : -1
  const selHi = selection ? Math.max(selection.anchor, selection.focus) : -1

  // Plain click selects (and seeks to) one word; Shift-click extends the span
  // from the existing anchor to the clicked word without moving the playhead.
  function handleWordClick(i: number, event: MouseEvent<HTMLSpanElement>) {
    if (event.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: i })
      return
    }
    setSelection({ anchor: i, focus: i })
    onSeek(words[i].start)
  }

  // A span [lo..hi] deletes exactly [words[lo].start, words[hi].end] — the spoken
  // span only, no surrounding silence (that is a later phase).
  function deleteSpan(lo: number, hi: number) {
    onDeleteRange(words[lo].start, words[hi].end)
    setSelection(null)
  }

  function deleteSelection() {
    if (selection) {
      deleteSpan(selLo, selHi)
    }
  }

  function isFlagged(midpointSeconds: number): boolean {
    const ms = midpointSeconds * 1_000
    return flaggedRanges.some(
      (range) => ms >= range.startSourceMs && ms < range.endSourceMs,
    )
  }

  const selectedCount = selection === null ? 0 : selHi - selLo + 1

  return (
    <div className="transcript">
      <p className="transcript__hint">
        Click a word to select · Shift-click to extend · Hover a sentence to cut it
      </p>

      {sentences.map((sentence, s) => {
        const sentenceStart = words[sentence.startIndex].start
        const stamp = formatShortClock(sentenceStart)
        const sentenceWords = words
          .slice(sentence.startIndex, sentence.endIndex + 1)
          .map((word, offset) => {
            const midpoint = (word.start + word.end) / 2
            return {
              word,
              index: sentence.startIndex + offset,
              midpoint,
              struck: !isSourceTimeKept(edl, midpoint),
            }
          })
        const allStruck = sentenceWords.every((entry) => entry.struck)
        const tokens = sentenceWords.map(({ word, index, midpoint, struck }) => (
          <span
            key={index}
            className={wordClassName(
              struck,
              index === activeIndex,
              index >= selLo && index <= selHi,
              isFlagged(midpoint),
            )}
            // Shift-click extends the word selection; keep the browser from
            // also extending a native text selection across the words.
            onMouseDown={(event) => {
              if (event.shiftKey) event.preventDefault()
            }}
            onClick={(event) => handleWordClick(index, event)}
            title={formatClock(word.start)}
          >
            {word.text}
          </span>
        ))

        return (
          <div key={s} className="transcript__row">
            <div className="transcript__gutter">
              <button
                type="button"
                className={
                  allStruck
                    ? 'transcript__time'
                    : 'transcript__time transcript__time--cuttable'
                }
                onClick={() => onSeek(sentenceStart)}
                title="Jump here"
                aria-label={`Jump to ${stamp}`}
              >
                {stamp}
              </button>
              {!allStruck && (
                <button
                  type="button"
                  className="transcript__cut"
                  onClick={() =>
                    deleteSpan(sentence.startIndex, sentence.endIndex)
                  }
                  title="Cut this sentence"
                  aria-label={`Cut the sentence at ${stamp}`}
                >
                  <Icon name="scissors" size={12} strokeWidth={2} />
                  Cut
                </button>
              )}
            </div>
            <div className="transcript__words">{tokens}</div>
          </div>
        )
      })}

      {selection === null ? (
        <div className="transcript__end" />
      ) : (
        <div className="selection-bar">
          <div className="selection-bar__info">
            <span className="selection-bar__count">
              {selectedCount} {selectedCount === 1 ? 'word' : 'words'} selected
            </span>
            <span className="selection-bar__span">
              {formatClock(words[selLo].start)} – {formatClock(words[selHi].end)}
              {' · '}
              {formatSeconds(words[selHi].end - words[selLo].start)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => setSelection(null)}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={deleteSelection}
          >
            Cut Selection
          </button>
        </div>
      )}
    </div>
  )
}
