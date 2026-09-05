function safeSourceMs(sourceMs: number): number {
  return Number.isFinite(sourceMs) ? Math.max(0, Math.floor(sourceMs)) : 0
}

/** Format an ORIGINAL-SOURCE millisecond position for compact display. */
export function formatRetakeSourceTime(sourceMs: number): string {
  const totalSeconds = Math.floor(safeSourceMs(sourceMs) / 1_000)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = String(totalMinutes % 60).padStart(2, '0')
  const hours = Math.floor(totalMinutes / 60)
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${minutes}:${seconds}`
}

function formatSourceTimeForSpeech(sourceMs: number): string {
  const milliseconds = safeSourceMs(sourceMs)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = (milliseconds % 60_000) / 1_000
  const units: string[] = []

  if (hours > 0) units.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes > 0) units.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  if (seconds > 0 || units.length === 0) {
    units.push(`${seconds} second${seconds === 1 ? '' : 's'}`)
  }
  return units.join(' ')
}

/** Keep source units and millisecond precision explicit for screen readers. */
export function formatRetakeSourceRangeForSpeech(
  startSourceMs: number,
  endSourceMs: number,
): string {
  return `Original source time: from ${formatSourceTimeForSpeech(startSourceMs)} to ${formatSourceTimeForSpeech(endSourceMs)}`
}
