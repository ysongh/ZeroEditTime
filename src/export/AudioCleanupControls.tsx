import { useState } from 'react'
import type { FocusEvent } from 'react'
import Icon from '../ui/Icon'
import {
  MAX_TRUE_PEAK_LIMIT_DB,
  MIN_TRUE_PEAK_LIMIT_DB,
  TRUE_PEAK_LIMIT_STEP_DB,
  normalizeAudioCleanupSettings,
  stepTruePeakLimit,
  type AudioCleanupSettings,
  type NoiseReductionLevel,
} from './audioCleanupSettings'

type AudioCleanupControlsProps = {
  settings: Readonly<AudioCleanupSettings>
  disabled: boolean
  onChange: (settings: AudioCleanupSettings) => void
}

const NOISE_OPTIONS: ReadonlyArray<{ value: NoiseReductionLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'strong', label: 'Strong' },
]

const LOUDNESS_OPTIONS: ReadonlyArray<{ value: number; note: string }> = [
  { value: -14, note: 'Streaming platforms' },
  { value: -16, note: 'Podcasts and voice' },
  { value: -18, note: 'More headroom' },
]

/** Typographic minus for display; inputs keep ASCII values. */
function signed(value: number): string {
  return String(value).replace('-', '−')
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
  const loudnessNote = LOUDNESS_OPTIONS.find(
    (option) => option.value === settings.loudnessTargetLufs,
  )?.note

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

  function stepPeakLimit(direction: 1 | -1): void {
    onChange(stepTruePeakLimit(settings, direction))
  }

  return (
    <fieldset className="audio-cleanup-controls">
      <legend className="sr-only">Audio cleanup</legend>

      <div className="setting-row">
        <label className="setting-row__text" htmlFor="audio-cleanup-enabled">
          <span className="setting-row__title setting-row__title--strong">
            Improve voice audio
          </span>
          <span className="setting-row__hint">Applied to the exported MP4</span>
        </label>
        <input
          id="audio-cleanup-enabled"
          className="switch"
          type="checkbox"
          role="switch"
          checked={settings.enabled}
          disabled={disabled}
          onChange={(event) =>
            updateSetting('enabled', event.currentTarget.checked)
          }
        />
      </div>

      <div
        className={
          settings.enabled
            ? 'audio-cleanup-details'
            : 'audio-cleanup-details audio-cleanup-details--off'
        }
      >
        <fieldset className="audio-cleanup-field">
          <legend className="audio-cleanup-field__head">
            <span>Noise reduction</span>
          </legend>
          <div className="segmented">
            {NOISE_OPTIONS.map((option) => (
              <label key={option.value} className="segmented__option">
                <input
                  id={`audio-cleanup-noise-${option.value}`}
                  type="radio"
                  name="audio-cleanup-noise"
                  value={option.value}
                  checked={settings.noiseReduction === option.value}
                  disabled={detailDisabled}
                  onChange={() => updateSetting('noiseReduction', option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {settings.enabled && settings.noiseReduction === 'strong' && (
            <p className="audio-cleanup-warning" role="note">
              Strong noise reduction may alter voice quality.
            </p>
          )}
        </fieldset>

        <div className="setting-row">
          <label
            className="setting-row__text"
            htmlFor="audio-cleanup-voice-leveling"
          >
            <span className="setting-row__title">Level voice volume</span>
            <span className="setting-row__hint">
              Evens out loud and quiet moments
            </span>
          </label>
          <input
            id="audio-cleanup-voice-leveling"
            className="switch"
            type="checkbox"
            role="switch"
            checked={settings.voiceLeveling}
            disabled={detailDisabled}
            onChange={(event) =>
              updateSetting('voiceLeveling', event.currentTarget.checked)
            }
          />
        </div>

        <div className="setting-row">
          <label
            className="setting-row__text"
            htmlFor="audio-cleanup-smooth-joins"
          >
            <span className="setting-row__title">Smooth edit joins</span>
            <span className="setting-row__hint">Short fades at every cut</span>
          </label>
          <input
            id="audio-cleanup-smooth-joins"
            className="switch"
            type="checkbox"
            role="switch"
            checked={settings.smoothJoins}
            disabled={detailDisabled}
            onChange={(event) =>
              updateSetting('smoothJoins', event.currentTarget.checked)
            }
          />
        </div>

        <fieldset className="audio-cleanup-field">
          <legend className="audio-cleanup-field__head">
            <span>Loudness target</span>
            {loudnessNote !== undefined && (
              <span className="setting-row__hint">{loudnessNote}</span>
            )}
          </legend>
          <div className="audio-cleanup-loudness">
            <div className="segmented segmented--numeric">
              {LOUDNESS_OPTIONS.map((option) => (
                <label key={option.value} className="segmented__option">
                  <input
                    id={`audio-cleanup-loudness-${Math.abs(option.value)}`}
                    type="radio"
                    name="audio-cleanup-loudness"
                    value={option.value}
                    aria-label={`${option.value} LUFS`}
                    checked={settings.loudnessTargetLufs === option.value}
                    disabled={detailDisabled}
                    onChange={() =>
                      updateSetting('loudnessTargetLufs', option.value)
                    }
                  />
                  <span>{signed(option.value)}</span>
                </label>
              ))}
            </div>
            <span className="label-text" aria-hidden="true">
              LUFS
            </span>
          </div>
        </fieldset>

        <div className="setting-row">
          <label className="setting-row__text" htmlFor="audio-cleanup-peak">
            <span className="setting-row__title">Peak limit</span>
          </label>
          <div className="stepper">
            <button
              type="button"
              className="stepper__btn"
              aria-label="Lower peak limit"
              disabled={
                detailDisabled ||
                settings.truePeakLimitDb <= MIN_TRUE_PEAK_LIMIT_DB
              }
              onClick={() => stepPeakLimit(-1)}
            >
              <Icon name="minus" size={14} strokeWidth={2} />
            </button>
            <span className="stepper__field">
              <input
                id="audio-cleanup-peak"
                type="number"
                min={MIN_TRUE_PEAK_LIMIT_DB}
                max={MAX_TRUE_PEAK_LIMIT_DB}
                step={TRUE_PEAK_LIMIT_STEP_DB}
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
            <button
              type="button"
              className="stepper__btn"
              aria-label="Raise peak limit"
              disabled={
                detailDisabled ||
                settings.truePeakLimitDb >= MAX_TRUE_PEAK_LIMIT_DB
              }
              onClick={() => stepPeakLimit(1)}
            >
              <Icon name="plus" size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </fieldset>
  )
}
