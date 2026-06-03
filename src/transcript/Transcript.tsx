// Interactive transcript, rendered one-way from the Transcript model. Clicking a
// word seeks the video to that word's source time; the word currently under the
// playhead is highlighted. `currentTime` is the video's SOURCE time (the App's
// playhead) — we compare against it directly and never convert to EDL time, so
// the highlight stays correct even when Phase 1's controller skips a removed
// range (the playhead jumps to the new source time and the right word lights up).

import type { Transcript } from './types'

type TranscriptProps = {
  transcript: Transcript
  /** The video's current source time, in seconds. */
  currentTime: number
  onSeek: (sourceTime: number) => void
}

export default function TranscriptView({
  transcript,
  currentTime,
  onSeek,
}: TranscriptProps) {
  const activeIndex = transcript.words.findIndex(
    (w) => currentTime >= w.start && currentTime < w.end,
  )

  return (
    <div
      style={{
        marginTop: 16,
        textAlign: 'left',
        lineHeight: 1.9,
        maxHeight: '30vh',
        overflowY: 'auto',
        padding: '8px 12px',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      {transcript.words.map((word, i) => (
        <span
          key={i}
          onClick={() => onSeek(word.start)}
          title={`${word.start.toFixed(2)}s`}
          style={{
            cursor: 'pointer',
            padding: '1px 3px',
            borderRadius: 3,
            background: i === activeIndex ? 'var(--accent)' : 'transparent',
            color: i === activeIndex ? 'var(--accent-fg, #ffffff)' : 'inherit',
          }}
        >
          {word.text}{' '}
        </span>
      ))}
    </div>
  )
}
