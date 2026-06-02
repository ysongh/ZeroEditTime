// The EDL (Edit Decision List) is the single source of truth for every phase.
// Editing never mutates or re-encodes the source video; all edits are recorded
// here as the ordered set of source time-ranges that play. UI derives from the
// EDL one-way (EDL -> UI), never the reverse.
//
// These types are framework-free on purpose: the EDL math lives in `edl.ts` and
// must stay pure and unit-testable, with no React or DOM dependency.

export type EDL = {
  version: 1
  source: {
    id: string
    url: string
    duration: number
    width?: number
    height?: number
    fps?: number
  }
  /** Ordered; playback concatenates these in order. */
  segments: Segment[]
  /** Not used until a later phase; stays [] this phase. */
  captions: Caption[]
}

/** A kept time-range, in seconds into the source. */
export type Segment = { id: string; start: number; end: number }

/** Reserved for a later phase. */
export type Caption = { id: string; text: string; start: number; end: number }
