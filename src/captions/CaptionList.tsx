// The Phase-8 caption list — the editing surface for caption TEXT. The footage
// is dev content, and Whisper mishears product/SDK/protocol jargon; the fix
// workflow is to READ the captions like a transcript, spot the wrong term, and
// correct it. So this is a scannable list, not click-on-video: one row per
// caption (source mm:ss + text), the time seeks, the text edits inline, and the
// row at the playhead is highlighted like the transcript's active word — hear
// the mishear, and the highlight is where you look.
//
// The component owns only the ephemeral editing state (which row, the draft).
// Committing goes through `onEditText` → App runs `updateCaptionText` +
// `commitEdl`, so each real edit is exactly one undo step and a no-op edit
// (unchanged / empty) commits nothing. The overlay and the export both derive
// from `edl.captions`, so an edit here shows up in both with no extra wiring.

import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import type { Caption } from '../edl/types'

type CaptionListProps = {
  captions: Caption[]
  /** The video's current source time, in seconds — highlights the active row. */
  currentTime: number
  /** Seek the video to a SOURCE time — the same handler transcript words use. */
  onSeek: (sourceTime: number) => void
  /** Commit an edited caption text (App: updateCaptionText → commitEdl). */
  onEditText: (id: string, text: string) => void
}

function fmtMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function CaptionList({
  captions,
  currentTime,
  onSeek,
  onEditText,
}: CaptionListProps) {
  // Exactly one row is editable at a time: the row whose id is `editingId`.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Escape must close the editor WITHOUT committing, but closing unmounts the
  // input and its blur — the single commit path — can still fire; this ref
  // tells that blur to skip. Reset when editing starts, in case a browser
  // never fired the unmount blur and the flag went stale.
  const cancelledRef = useRef(false)

  function startEditing(caption: Caption) {
    cancelledRef.current = false
    setEditingId(caption.id)
    setDraft(caption.text)
  }

  // Blur is the ONE commit path. Enter blurs the input — still mounted, so
  // focusout fires synchronously and commits once; Escape flags the cancel
  // and closes.
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      cancelledRef.current = true
      setEditingId(null)
    }
  }

  function handleBlur(id: string) {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    setEditingId(null)
    // A no-op draft (unchanged / empty) returns the same EDL upstream, so
    // nothing commits and no undo entry appears.
    onEditText(id, draft)
  }

  function handleDraftChange(event: ChangeEvent<HTMLInputElement>) {
    setDraft(event.target.value)
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 6px' }}>
        Click a time to seek; click text to fix a mishear — Enter saves, Esc
        cancels.
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: '6px 10px',
          maxHeight: '30vh',
          overflowY: 'auto',
          textAlign: 'left',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        {captions.map((caption) => {
          const isActive =
            caption.start <= currentTime && currentTime < caption.end
          return (
            <li
              key={caption.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '2px 0',
              }}
            >
              <button
                type="button"
                onClick={() => onSeek(caption.start)}
                title={`${caption.start.toFixed(2)}s`}
                style={{
                  padding: '0 6px',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtMmSs(caption.start)}
              </button>
              {editingId === caption.id ? (
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={handleDraftChange}
                  onKeyDown={handleKeyDown}
                  onBlur={() => handleBlur(caption.id)}
                  style={{ flex: 1, font: 'inherit', padding: '1px 5px' }}
                />
              ) : (
                <span
                  onClick={() => startEditing(caption)}
                  title="Click to edit"
                  style={{
                    flex: 1,
                    cursor: 'text',
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: isActive ? 'var(--accent)' : 'transparent',
                    color: isActive ? 'var(--accent-fg, #ffffff)' : 'inherit',
                  }}
                >
                  {caption.text}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
