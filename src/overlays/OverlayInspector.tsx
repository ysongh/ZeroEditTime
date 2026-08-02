import { useId, useRef, useState } from 'react'
import type {
  ChangeEvent,
  CSSProperties,
  KeyboardEvent,
} from 'react'
import type { ImageOverlayPatch } from './editorState'
import {
  fillFrameGeometry,
  formatSourceTimestamp,
  getOverlayLayerPosition,
  parseClampedSourceTimestamp,
  parseOpacityPercent,
  resetOverlayPosition,
} from './inspector'
import type { ImageOverlay, OverlayAsset, OverlayFit } from './types'

export interface OverlayInspectorProps {
  overlay: ImageOverlay
  asset?: OverlayAsset
  overlays: readonly ImageOverlay[]
  sourceDurationMs: number
  onUpdateOverlay: (id: string, patch: ImageOverlayPatch) => void
  onSetLayerPosition: (id: string, position: number) => void
  onDuplicateOverlay: (id: string) => void
  onBringForward: (id: string) => void
  onSendBackward: (id: string) => void
  onRemoveOverlay: (id: string) => void
}

interface FieldDraft {
  ownerId: string
  value: string
  error: string | null
}

interface DraftTextFieldProps {
  ownerId: string
  label: string
  authoritativeValue: string
  hint: string
  inputMode?: 'decimal' | 'numeric'
  suffix?: string
  onCommit: (value: string) => string | null
}

const panelStyle: CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: '1px solid var(--border)',
  borderRadius: 8,
  textAlign: 'left',
}

const groupStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  border: 0,
  minWidth: 0,
}

const fieldsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 12,
  marginTop: 12,
}

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
  fontSize: 14,
  color: 'var(--text-h)',
}

const inputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '6px 8px',
  font: 'inherit',
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  color: 'var(--text)',
}

const errorStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  color: 'crimson',
}

function DraftTextField({
  ownerId,
  label,
  authoritativeValue,
  hint,
  inputMode,
  suffix,
  onCommit,
}: DraftTextFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState<FieldDraft | null>(null)
  const cancelBlurRef = useRef(false)
  const activeDraft = draft?.ownerId === ownerId ? draft : null
  const error = activeDraft?.error ?? null

  function commitDraft() {
    if (cancelBlurRef.current) {
      cancelBlurRef.current = false
      return
    }
    if (activeDraft === null) {
      return
    }

    const validationError = onCommit(activeDraft.value)
    if (validationError === null) {
      setDraft(null)
      return
    }
    setDraft({ ...activeDraft, error: validationError })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelBlurRef.current = true
      setDraft(null)
      event.currentTarget.blur()
    }
  }

  const describedBy =
    error === null ? `${id}-hint` : `${id}-hint ${id}-error`

  return (
    <label htmlFor={id} style={labelStyle}>
      <span>{label}</span>
      <span
        style={{
          display: 'grid',
          gridTemplateColumns: suffix === undefined ? '1fr' : '1fr auto',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <input
          id={id}
          type="text"
          inputMode={inputMode}
          value={activeDraft?.value ?? authoritativeValue}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => {
            cancelBlurRef.current = false
            setDraft({
              ownerId,
              value: event.currentTarget.value,
              error: null,
            })
          }}
          onBlur={commitDraft}
          onKeyDown={handleKeyDown}
          style={inputStyle}
        />
        {suffix !== undefined && (
          <span aria-hidden="true" style={{ color: 'var(--text)' }}>
            {suffix}
          </span>
        )}
      </span>
      <span id={`${id}-hint`} style={hintStyle}>
        {hint}
      </span>
      {error !== null && (
        <span id={`${id}-error`} role="alert" style={errorStyle}>
          {error}
        </span>
      )}
    </label>
  )
}

function timestampError(value: string): string {
  return value.trim() === ''
    ? 'Enter a time.'
    : 'Use seconds or a timestamp like 0:01.500.'
}

function formatOpacityPercent(opacity: number): string {
  return String(Number((opacity * 100).toFixed(3)))
}

function readFit(event: ChangeEvent<HTMLSelectElement>): OverlayFit {
  switch (event.currentTarget.value) {
    case 'cover':
      return 'cover'
    case 'stretch':
      return 'stretch'
    default:
      return 'contain'
  }
}

export default function OverlayInspector({
  overlay,
  asset,
  overlays,
  sourceDurationMs,
  onUpdateOverlay,
  onSetLayerPosition,
  onDuplicateOverlay,
  onBringForward,
  onSendBackward,
  onRemoveOverlay,
}: OverlayInspectorProps) {
  const headingId = useId()
  const layer = getOverlayLayerPosition(overlays, overlay.id)
  const overlayDurationMs = overlay.endSourceMs - overlay.startSourceMs

  function update(patch: ImageOverlayPatch) {
    onUpdateOverlay(overlay.id, patch)
  }

  return (
    <section style={panelStyle} aria-labelledby={headingId}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 id={headingId} style={{ margin: 0 }}>
            Image overlay
          </h2>
          <p
            title={asset?.name}
            style={{
              marginTop: 4,
              fontSize: 13,
              opacity: 0.75,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {asset === undefined
              ? 'Image unavailable'
              : `${asset.name} · ${asset.width}×${asset.height}`}
          </p>
        </div>
        {asset !== undefined && (
          <img
            src={asset.src}
            alt=""
            style={{
              display: 'block',
              width: 72,
              height: 48,
              objectFit: 'contain',
              background: 'var(--code-bg)',
              borderRadius: 4,
            }}
          />
        )}
      </div>

      <fieldset style={groupStyle}>
        <legend
          style={{
            padding: 0,
            marginTop: 14,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-h)',
          }}
        >
          Timing
        </legend>
        <div style={fieldsStyle}>
          <DraftTextField
            key={`${overlay.id}-start-${overlay.startSourceMs}-${overlay.endSourceMs}-${sourceDurationMs}`}
            ownerId={overlay.id}
            label="Start"
            authoritativeValue={formatSourceTimestamp(
              overlay.startSourceMs,
            )}
            hint="Source-video time"
            inputMode="decimal"
            onCommit={(value) => {
              const parsed = parseClampedSourceTimestamp(
                value,
                sourceDurationMs,
              )
              if (parsed === null) {
                return timestampError(value)
              }
              if (parsed >= overlay.endSourceMs) {
                return 'Start must be before end.'
              }
              if (parsed !== overlay.startSourceMs) {
                update({ startSourceMs: parsed })
              }
              return null
            }}
          />
          <DraftTextField
            key={`${overlay.id}-end-${overlay.startSourceMs}-${overlay.endSourceMs}-${sourceDurationMs}`}
            ownerId={overlay.id}
            label="End"
            authoritativeValue={formatSourceTimestamp(overlay.endSourceMs)}
            hint="Source-video time"
            inputMode="decimal"
            onCommit={(value) => {
              const parsed = parseClampedSourceTimestamp(
                value,
                sourceDurationMs,
              )
              if (parsed === null) {
                return timestampError(value)
              }
              if (parsed <= overlay.startSourceMs) {
                return 'End must be after start.'
              }
              if (parsed !== overlay.endSourceMs) {
                update({ endSourceMs: parsed })
              }
              return null
            }}
          />
          <DraftTextField
            key={`${overlay.id}-fade-in-${overlay.fadeInMs}-${overlayDurationMs}`}
            ownerId={overlay.id}
            label="Fade in"
            authoritativeValue={formatSourceTimestamp(overlay.fadeInMs)}
            hint="Duration, up to the overlay length"
            inputMode="decimal"
            onCommit={(value) => {
              const parsed = parseClampedSourceTimestamp(
                value,
                overlayDurationMs,
              )
              if (parsed === null) {
                return timestampError(value)
              }
              if (parsed !== overlay.fadeInMs) {
                update({ fadeInMs: parsed })
              }
              return null
            }}
          />
          <DraftTextField
            key={`${overlay.id}-fade-out-${overlay.fadeOutMs}-${overlayDurationMs}`}
            ownerId={overlay.id}
            label="Fade out"
            authoritativeValue={formatSourceTimestamp(overlay.fadeOutMs)}
            hint="Duration, up to the overlay length"
            inputMode="decimal"
            onCommit={(value) => {
              const parsed = parseClampedSourceTimestamp(
                value,
                overlayDurationMs,
              )
              if (parsed === null) {
                return timestampError(value)
              }
              if (parsed !== overlay.fadeOutMs) {
                update({ fadeOutMs: parsed })
              }
              return null
            }}
          />
        </div>
      </fieldset>

      <fieldset style={groupStyle}>
        <legend
          style={{
            padding: 0,
            marginTop: 16,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-h)',
          }}
        >
          Appearance
        </legend>
        <div style={fieldsStyle}>
          <label style={labelStyle}>
            <span>Fit</span>
            <select
              value={overlay.fit}
              onChange={(event) => update({ fit: readFit(event) })}
              style={inputStyle}
            >
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="stretch">Stretch</option>
            </select>
            <span style={hintStyle}>How the image fills its box</span>
          </label>
          <DraftTextField
            key={`${overlay.id}-opacity-${overlay.opacity}`}
            ownerId={overlay.id}
            label="Opacity"
            authoritativeValue={formatOpacityPercent(overlay.opacity)}
            hint="0 is transparent; 100 is solid"
            inputMode="decimal"
            suffix="%"
            onCommit={(value) => {
              const parsed = parseOpacityPercent(value)
              if (parsed === null) {
                return 'Enter an opacity percentage, such as 75.'
              }
              if (parsed !== overlay.opacity) {
                update({ opacity: parsed })
              }
              return null
            }}
          />
          <label style={labelStyle}>
            <span>Layer order</span>
            <select
              value={layer?.position ?? 1}
              disabled={layer === null || layer.total <= 1}
              aria-label="Layer order, back to front"
              onChange={(event) =>
                onSetLayerPosition(
                  overlay.id,
                  Number(event.currentTarget.value),
                )
              }
              style={inputStyle}
            >
              {Array.from(
                { length: layer?.total ?? 1 },
                (_, index) => index + 1,
              ).map((position) => (
                <option key={position} value={position}>
                  {position} of {layer?.total ?? 1}
                  {position === 1
                    ? ' (back)'
                    : position === layer?.total
                      ? ' (front)'
                      : ''}
                </option>
              ))}
            </select>
            <span style={hintStyle}>Back to front</span>
          </label>
        </div>
      </fieldset>

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginTop: 14,
        }}
      >
        <button
          type="button"
          disabled={layer?.canBringForward !== true}
          onClick={() => onBringForward(overlay.id)}
        >
          Bring forward
        </button>
        <button
          type="button"
          disabled={layer?.canSendBackward !== true}
          onClick={() => onSendBackward(overlay.id)}
        >
          Send backward
        </button>
        <button
          type="button"
          onClick={() => update(fillFrameGeometry())}
        >
          Fill frame
        </button>
        <button
          type="button"
          onClick={() =>
            update(
              resetOverlayPosition({
                x: overlay.x,
                y: overlay.y,
                width: overlay.width,
                height: overlay.height,
              }),
            )
          }
        >
          Reset position
        </button>
        <button
          type="button"
          onClick={() => onDuplicateOverlay(overlay.id)}
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={() => onRemoveOverlay(overlay.id)}
        >
          Delete
        </button>
      </div>
    </section>
  )
}
