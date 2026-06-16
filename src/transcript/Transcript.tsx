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
import type { Transcript } from './types'
import { groupSentences } from './sentences'

type TranscriptProps = {
  transcript: Transcript
  /** The single source of truth; struck-through state derives from it. */
  edl: EDL
  /** The video's current source time, in seconds. */
  currentTime: number
  onSeek: (sourceTime: number) => void
  /** Remove the source range [start, end] from the EDL (a word/sentence span). */
  onDeleteRange: (start: number, end: number) => void
}

/** Anchor/focus word indices of a contiguous selection; null when nothing is selected. */
type Selection = { anchor: number; focus: number }

export default function TranscriptView({
  transcript,
  edl,
  currentTime,
  onSeek,
  onDeleteRange,
}: TranscriptProps) {
  const { words } = transcript
  const [selection, setSelection] = useState<Selection | null>(null)
  const [hoveredSentence, setHoveredSentence] = useState<number | null>(null)

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

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <button type="button" onClick={deleteSelection} disabled={selection === null}>
          Delete selection
        </button>
        <button
          type="button"
          onClick={() => setSelection(null)}
          disabled={selection === null}
        >
          Clear
        </button>
        <span style={{ fontSize: 13, opacity: 0.7 }}>
          Click a word to select; Shift-click to extend. Hover a sentence to delete it.
        </span>
      </div>

      <div
        style={{
          textAlign: 'left',
          lineHeight: 1.9,
          maxHeight: '30vh',
          overflowY: 'auto',
          padding: '8px 12px',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        {sentences.map((sentence, s) => (
          <span
            key={s}
            onMouseEnter={() => setHoveredSentence(s)}
            onMouseLeave={() => setHoveredSentence(null)}
          >
            {words
              .slice(sentence.startIndex, sentence.endIndex + 1)
              .map((word, offset) => {
                const i = sentence.startIndex + offset
                const struck = !isSourceTimeKept(edl, (word.start + word.end) / 2)
                const isActive = i === activeIndex
                const isSelected = i >= selLo && i <= selHi
                return (
                  <span
                    key={i}
                    onClick={(event) => handleWordClick(i, event)}
                    title={`${word.start.toFixed(2)}s`}
                    style={{
                      cursor: 'pointer',
                      padding: '1px 3px',
                      borderRadius: 3,
                      textDecoration: struck ? 'line-through' : 'none',
                      opacity: struck ? 0.45 : 1,
                      background: isActive
                        ? 'var(--accent)'
                        : isSelected
                          ? 'rgba(120, 160, 255, 0.35)'
                          : 'transparent',
                      color: isActive ? 'var(--accent-fg, #ffffff)' : 'inherit',
                    }}
                  >
                    {word.text}{' '}
                  </span>
                )
              })}
            {hoveredSentence === s && (
              <button
                type="button"
                onClick={() => deleteSpan(sentence.startIndex, sentence.endIndex)}
                title="Delete this sentence"
                style={{
                  cursor: 'pointer',
                  fontSize: 11,
                  lineHeight: 1,
                  padding: '1px 5px',
                  marginRight: 4,
                  verticalAlign: 'middle',
                }}
              >
                ✕ sentence
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
