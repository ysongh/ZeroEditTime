// Phase 2 transcript model. Independent of the EDL: the transcript covers the
// full source audio and is not reconciled with removed ranges yet (that is
// Phase 3). All times are seconds into the source, matching the EDL and the
// <video> element's currentTime.

export type Word = { text: string; start: number; end: number }

export type Transcript = { words: Word[] }
