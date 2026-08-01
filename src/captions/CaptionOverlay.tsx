// The Phase-6 caption preview: one absolutely positioned line over the video,
// approximating the export burn (white bold text on a black text-shadow,
// bottom-centered). A pure view with no state, no canvas, and no timers: the
// active caption derives from the stored SOURCE-time captions and the playhead
// (start <= t < end), exactly like the transcript's active-word highlight.
// Rendered inside the video's position:relative wrapper in App.

import type { Caption } from '../edl/types'

type CaptionOverlayProps = {
  captions: Caption[]
  /** The playhead, in SOURCE seconds (captions are stored in source time). */
  currentTime: number
}

export default function CaptionOverlay({
  captions,
  currentTime,
}: CaptionOverlayProps) {
  const active = captions.find(
    (c) => c.start <= currentTime && currentTime < c.end,
  )
  if (active === undefined) {
    return null
  }

  return (
    // pointerEvents none: the overlay sits where the native controls appear,
    // and must never swallow their clicks.
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '9%',
        zIndex: 2,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          color: '#fff',
          fontWeight: 700,
          fontSize: 'clamp(14px, 2.6vw, 24px)',
          lineHeight: 1.3,
          textAlign: 'center',
          maxWidth: '86%',
          textShadow:
            '0 0 4px #000, 1px 1px 2px #000, -1px 1px 2px #000, ' +
            '1px -1px 2px #000, -1px -1px 2px #000',
        }}
      >
        {active.text}
      </span>
    </div>
  )
}
