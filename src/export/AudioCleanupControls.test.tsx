import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AudioCleanupControls from './AudioCleanupControls'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  type AudioCleanupSettings,
} from './audioCleanupSettings'

function renderControls(
  settings: Readonly<AudioCleanupSettings> = DEFAULT_AUDIO_CLEANUP_SETTINGS,
  disabled = false,
): string {
  return renderToStaticMarkup(
    <AudioCleanupControls
      settings={settings}
      disabled={disabled}
      onChange={vi.fn()}
    />,
  )
}

function controlTag(markup: string, id: string): string {
  const match = markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

const DETAIL_CONTROL_IDS = [
  'audio-cleanup-noise-off',
  'audio-cleanup-noise-light',
  'audio-cleanup-noise-strong',
  'audio-cleanup-voice-leveling',
  'audio-cleanup-smooth-joins',
  'audio-cleanup-loudness-14',
  'audio-cleanup-loudness-16',
  'audio-cleanup-loudness-18',
  'audio-cleanup-peak',
] as const

describe('AudioCleanupControls', () => {
  it('renders the recommended editor-facing controls and defaults', () => {
    const markup = renderControls()

    expect(markup).toContain('<legend class="sr-only">Audio cleanup</legend>')
    expect(markup).toContain('Improve voice audio')
    expect(controlTag(markup, 'audio-cleanup-enabled')).toContain('checked=""')
    expect(controlTag(markup, 'audio-cleanup-enabled')).toContain(
      'role="switch"',
    )
    expect(markup).toContain('Noise reduction')
    expect(controlTag(markup, 'audio-cleanup-noise-off')).not.toContain('checked')
    expect(controlTag(markup, 'audio-cleanup-noise-light')).toContain('checked=""')
    expect(controlTag(markup, 'audio-cleanup-noise-strong')).not.toContain(
      'checked',
    )
    expect(markup).toContain('Level voice volume')
    expect(controlTag(markup, 'audio-cleanup-voice-leveling')).toContain(
      'checked=""',
    )
    expect(markup).toContain('Smooth edit joins')
    expect(controlTag(markup, 'audio-cleanup-smooth-joins')).toContain(
      'checked=""',
    )
    expect(markup).toContain('Loudness target')
    expect(controlTag(markup, 'audio-cleanup-loudness-14')).toContain(
      'aria-label="-14 LUFS"',
    )
    expect(controlTag(markup, 'audio-cleanup-loudness-16')).toContain(
      'checked=""',
    )
    expect(controlTag(markup, 'audio-cleanup-loudness-18')).not.toContain(
      'checked',
    )
    expect(markup).toContain('Podcasts and voice')
    expect(markup).toContain('Peak limit')
    expect(controlTag(markup, 'audio-cleanup-peak')).toEqual(
      expect.stringContaining('min="-6"'),
    )
    expect(controlTag(markup, 'audio-cleanup-peak')).toEqual(
      expect.stringContaining('max="0"'),
    )
    expect(controlTag(markup, 'audio-cleanup-peak')).toEqual(
      expect.stringContaining('step="0.5"'),
    )
    expect(controlTag(markup, 'audio-cleanup-peak')).toEqual(
      expect.stringContaining('value="-1"'),
    )
  })

  it('offers peak-limit steppers only while a step stays in range', () => {
    const stepper = (markup: string, label: string): string =>
      markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? ''
    const middle = renderControls()
    const atMax = renderControls({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      truePeakLimitDb: 0,
    })
    const atMin = renderControls({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      truePeakLimitDb: -6,
    })

    expect(stepper(middle, 'Lower peak limit')).not.toContain('disabled')
    expect(stepper(middle, 'Raise peak limit')).not.toContain('disabled')
    expect(stepper(atMax, 'Raise peak limit')).toContain('disabled=""')
    expect(stepper(atMin, 'Lower peak limit')).toContain('disabled=""')
  })

  it('does not expose low-level FFmpeg or processor parameters', () => {
    const markup = renderControls().toLowerCase()

    for (const internal of [
      'afftdn',
      'acompressor',
      'alimiter',
      'attack',
      'release',
      'fft',
      'noise floor',
      'ratio',
    ]) {
      expect(markup).not.toContain(internal)
    }
  })

  it('warns that strong denoising can alter voice quality', () => {
    const lightMarkup = renderControls()
    const strongMarkup = renderControls({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
    })

    expect(lightMarkup).not.toContain('may alter voice quality')
    expect(strongMarkup).toContain(
      '<p class="audio-cleanup-warning" role="note">Strong noise reduction may alter voice quality.</p>',
    )
  })

  it('keeps the master switch available while disabling detail controls', () => {
    const markup = renderControls({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      enabled: false,
      noiseReduction: 'strong',
      voiceLeveling: false,
      loudnessTargetLufs: -18,
      truePeakLimitDb: -2,
      smoothJoins: false,
    })

    expect(controlTag(markup, 'audio-cleanup-enabled')).not.toContain('disabled')
    for (const id of DETAIL_CONTROL_IDS) {
      expect(controlTag(markup, id)).toContain('disabled=""')
    }
    expect(controlTag(markup, 'audio-cleanup-noise-strong')).toContain(
      'checked=""',
    )
    expect(controlTag(markup, 'audio-cleanup-loudness-18')).toContain(
      'checked=""',
    )
    expect(controlTag(markup, 'audio-cleanup-peak')).toContain('value="-2"')
  })

  it('disables every setting while export work is in progress', () => {
    const markup = renderControls(DEFAULT_AUDIO_CLEANUP_SETTINGS, true)

    for (const id of ['audio-cleanup-enabled', ...DETAIL_CONTROL_IDS]) {
      expect(controlTag(markup, id)).toContain('disabled=""')
    }
  })
})
