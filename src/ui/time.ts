// Display formatting for source/output seconds. Pure; no React.

function safeSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0
}

/** Precise clock: `m:ss.cc` (or `h:mm:ss.cc` from one hour). */
export function formatClock(seconds: number): string {
  const centis = Math.round(safeSeconds(seconds) * 100)
  const hours = Math.floor(centis / 360_000)
  const minutes = Math.floor((centis % 360_000) / 6_000)
  const rest = (centis % 6_000) / 100
  const secondsText = rest.toFixed(2).padStart(5, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
    : `${minutes}:${secondsText}`
}

/** Compact clock for rulers and row stamps: `m:ss` (or `h:mm:ss`). */
export function formatShortClock(seconds: number): string {
  const total = Math.floor(safeSeconds(seconds) + 1e-6)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secondsText = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
    : `${minutes}:${secondsText}`
}

/** A duration in seconds with two decimals, e.g. `1.25s`. */
export function formatSeconds(seconds: number): string {
  return `${safeSeconds(seconds).toFixed(2)}s`
}
