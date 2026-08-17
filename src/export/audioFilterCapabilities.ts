export type AudioFilterName =
  | 'afftdn'
  | 'acompressor'
  | 'loudnorm'
  | 'alimiter'
  | 'acrossfade'

export type AudioFilterSupport = 'unknown' | 'supported' | 'unsupported'

export interface AudioFilterCapabilities {
  afftdn: AudioFilterSupport
  acompressor: AudioFilterSupport
  loudnorm: AudioFilterSupport
  alimiter: AudioFilterSupport
  acrossfade: AudioFilterSupport
}

const UNKNOWN_CAPABILITIES: Readonly<AudioFilterCapabilities> = {
  afftdn: 'unknown',
  acompressor: 'unknown',
  loudnorm: 'unknown',
  alimiter: 'unknown',
  acrossfade: 'unknown',
}

// The app has one lazily created FFmpeg instance, while the WeakMap also keeps
// mocked engines and future replacement instances isolated and collectible.
// Merely importing or reading this module never constructs or loads FFmpeg.
// `acrossfade` is a candidate for future join strategies; the current qsin
// design emits `afade`, so it deliberately remains unknown rather than being
// inferred from unrelated encode success.
const capabilitiesByInstance = new WeakMap<object, AudioFilterCapabilities>()

/** Return an immutable snapshot; unknown filters are safe to attempt on demand. */
export function getAudioFilterCapabilities(
  ffmpeg: object,
): Readonly<AudioFilterCapabilities> {
  const capabilities = capabilitiesByInstance.get(ffmpeg)
  return { ...(capabilities ?? UNKNOWN_CAPABILITIES) }
}

/** Unknown means untested, so a requested real encode should try it once. */
export function canAttemptAudioFilter(
  capabilities: Readonly<AudioFilterCapabilities>,
  filter: AudioFilterName,
): boolean {
  return capabilities[filter] !== 'unsupported'
}

/** Cache what a real encode proved about this exact loaded FFmpeg instance. */
export function recordAudioFilterSupport(
  ffmpeg: object,
  filter: AudioFilterName,
  supported: boolean,
): void {
  const current = capabilitiesByInstance.get(ffmpeg) ?? {
    ...UNKNOWN_CAPABILITIES,
  }
  capabilitiesByInstance.set(ffmpeg, {
    ...current,
    [filter]: supported ? 'supported' : 'unsupported',
  })
}
