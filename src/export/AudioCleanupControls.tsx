import { useState } from 'react'
import type { ChangeEvent, FocusEvent } from 'react'
import {
  MAX_TRUE_PEAK_LIMIT_DB,
  MIN_TRUE_PEAK_LIMIT_DB,
  normalizeAudioCleanupSettings,
  type AudioCleanupSettings,
} from './audioCleanupSettings'

type AudioCleanupControlsProps = {
  settings: Readonly<AudioCleanupSettings>
  disabled: boolean
  onChange: (settings: AudioCleanupSettings) => void
}

/**
 * Compact export-time intent controls. Filter parameters stay in the export
 * layer; this UI exposes only choices a video editor needs to understand.
 */
export default function AudioCleanupControls({
  settings,
  disabled,
  onChange,
}: AudioCleanupControlsProps) {
  const detailDisabled = disabled || !settings.enabled
  const [peakDraft, setPeakDraft] = useState(() => ({
    settingValue: settings.truePeakLimitDb,
    inputValue: String(settings.truePeakLimitDb),
  }))
  const peakInputValue =
    peakDraft.settingValue === settings.truePeakLimitDb
      ? peakDraft.inputValue
      : String(settings.truePeakLimitDb)

  function updateSetting<Key extends keyof AudioCleanupSettings>(
    key: Key,
    value: AudioCleanupSettings[Key],
  ): void {
    onChange(
      normalizeAudioCleanupSettings({
        ...settings,
        [key]: value,
      }),
    )
  }

  function handleNoiseReductionChange(
    event: ChangeEvent<HTMLSelectElement>,
  ): void {
    const value = event.currentTarget.value
    if (value === 'off' || value === 'light' || value === 'strong') {
      updateSetting('noiseReduction', value)
    }
  }

  function handlePeakLimitCommit(event: FocusEvent<HTMLInputElement>): void {
    const normalized = normalizeAudioCleanupSettings({
      ...settings,
      truePeakLimitDb: event.currentTarget.valueAsNumber,
    })
    setPeakDraft({
      settingValue: normalized.truePeakLimitDb,
      inputValue: String(normalized.truePeakLimitDb),
    })
    onChange(normalized)
  }

  return (
    <fieldset className="audio-cleanup-controls">
      <legend>Audio cleanup</legend>

      <label className="audio-cleanup-checkbox audio-cleanup-master">
        <input
          id="audio-cleanup-enabled"
          type="checkbox"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) =>
            updateSetting('enabled', event.currentTarget.checked)
          }
        />
        <span>Improve voice audio</span>
      </label>

      <div className="audio-cleanup-details">
        <label className="audio-cleanup-row" htmlFor="audio-cleanup-noise">
          <span>Noise reduction</span>
          <select
            id="audio-cleanup-noise"
            value={settings.noiseReduction}
            disabled={detailDisabled}
            onChange={handleNoiseReductionChange}
          >
            <option value="off">Off</option>
            <option value="light">Light</option>
            <option value="strong">Strong</option>
          </select>
        </label>

        {settings.enabled && settings.noiseReduction === 'strong' && (
          <p className="audio-cleanup-warning" role="note">
            Strong noise reduction may alter voice quality.
          </p>
        )}

        <label className="audio-cleanup-checkbox">
          <input
            id="audio-cleanup-voice-leveling"
            type="checkbox"
            checked={settings.voiceLeveling}
            disabled={detailDisabled}
            onChange={(event) =>
              updateSetting('voiceLeveling', event.currentTarget.checked)
            }
          />
          <span>Level voice volume</span>
        </label>

        <label className="audio-cleanup-checkbox">
          <input
            id="audio-cleanup-smooth-joins"
            type="checkbox"
            checked={settings.smoothJoins}
            disabled={detailDisabled}
            onChange={(event) =>
              updateSetting('smoothJoins', event.currentTarget.checked)
            }
          />
          <span>Smooth edit joins</span>
        </label>

        <label className="audio-cleanup-row" htmlFor="audio-cleanup-loudness">
          <span>Loudness target</span>
          <select
            id="audio-cleanup-loudness"
            value={settings.loudnessTargetLufs}
            disabled={detailDisabled}
            onChange={(event) =>
              updateSetting(
                'loudnessTargetLufs',
                Number(event.currentTarget.value),
              )
            }
          >
            <option value={-14}>-14 LUFS</option>
            <option value={-16}>-16 LUFS</option>
            <option value={-18}>-18 LUFS</option>
          </select>
        </label>

        <label className="audio-cleanup-row" htmlFor="audio-cleanup-peak">
          <span>Peak limit</span>
          <span className="audio-cleanup-number">
            <input
              id="audio-cleanup-peak"
              type="number"
              min={MIN_TRUE_PEAK_LIMIT_DB}
              max={MAX_TRUE_PEAK_LIMIT_DB}
              step={0.5}
              value={peakInputValue}
              disabled={detailDisabled}
              onChange={(event) =>
                setPeakDraft({
                  settingValue: settings.truePeakLimitDb,
                  inputValue: event.currentTarget.value,
                })
              }
              onBlur={handlePeakLimitCommit}
            />
            <span aria-hidden="true">dB</span>
          </span>
        </label>
      </div>
    </fieldset>
  )
}
