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
  const match = markup.match(
    new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`),
  )
  expect(match).not.toBeNull()
  return match?.[0] ?? ''
}

describe('AudioCleanupControls', () => {
  it('renders the recommended editor-facing controls and defaults', () => {
    const markup = renderControls()

    expect(markup).toContain('<legend>Audio cleanup</legend>')
    expect(markup).toContain('Improve voice audio')
    expect(controlTag(markup, 'audio-cleanup-enabled')).toContain('checked=""')
    expect(markup).toContain('Noise reduction')
    expect(markup).toContain('<option value="off">Off</option>')
    expect(markup).toContain(
      '<option value="light" selected="">Light</option>',
    )
    expect(markup).toContain('<option value="strong">Strong</option>')
    expect(markup).toContain('Level voice volume')
    expect(controlTag(markup, 'audio-cleanup-voice-leveling')).toContain(
      'checked=""',
    )
    expect(markup).toContain('Smooth edit joins')
    expect(controlTag(markup, 'audio-cleanup-smooth-joins')).toContain(
      'checked=""',
    )
    expect(markup).toContain('Loudness target')
    expect(markup).toContain('<option value="-14">-14 LUFS</option>')
    expect(markup).toContain(
      '<option value="-16" selected="">-16 LUFS</option>',
    )
    expect(markup).toContain('<option value="-18">-18 LUFS</option>')
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
    for (const id of [
      'audio-cleanup-noise',
      'audio-cleanup-voice-leveling',
      'audio-cleanup-smooth-joins',
      'audio-cleanup-loudness',
      'audio-cleanup-peak',
    ]) {
      expect(controlTag(markup, id)).toContain('disabled=""')
    }
    expect(markup).toContain(
      '<option value="strong" selected="">Strong</option>',
    )
    expect(markup).toContain(
      '<option value="-18" selected="">-18 LUFS</option>',
    )
    expect(controlTag(markup, 'audio-cleanup-peak')).toContain('value="-2"')
  })

  it('disables every setting while export work is in progress', () => {
    const markup = renderControls(DEFAULT_AUDIO_CLEANUP_SETTINGS, true)

    for (const id of [
      'audio-cleanup-enabled',
      'audio-cleanup-noise',
      'audio-cleanup-voice-leveling',
      'audio-cleanup-smooth-joins',
      'audio-cleanup-loudness',
      'audio-cleanup-peak',
    ]) {
      expect(controlTag(markup, id)).toContain('disabled=""')
    }
  })
})
