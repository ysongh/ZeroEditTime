import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import Icon from '../ui/Icon'
import IconBadge from '../ui/IconBadge'
import {
  createImageOverlayFromPreset,
  nextImageOverlayZIndex,
  type ImageOverlayPreset,
} from './defaultOverlay'
import {
  IMAGE_FILE_ACCEPT,
  readImageDimensions,
  validateImageFile,
} from './imageFiles'
import type { ImageOverlay, OverlayAsset } from './types'

type MediaPanelProps = {
  assets: OverlayAsset[]
  overlays: ImageOverlay[]
  currentSourceMs: number
  sourceDurationMs: number
  videoWidth?: number
  videoHeight?: number
  onAddAsset: (asset: OverlayAsset) => void
  onAddOverlay: (overlay: ImageOverlay) => void
  onRemoveAsset: (assetId: string) => void
}

const PRESETS: ReadonlyArray<{ preset: ImageOverlayPreset; label: string; name: string }> = [
  { preset: 'default', label: 'Playhead', name: 'at the playhead' },
  { preset: 'cutaway', label: 'Cutaway', name: 'as a cutaway' },
  { preset: 'picture-in-picture', label: 'PiP', name: 'as picture-in-picture' },
  { preset: 'logo', label: 'Logo', name: 'as a logo' },
]

export default function MediaPanel({
  assets,
  overlays,
  currentSourceMs,
  sourceDurationMs,
  videoWidth,
  videoHeight,
  onAddAsset,
  onAddOverlay,
  onRemoveAsset,
}: MediaPanelProps) {
  const [isReading, setIsReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const selected = input.files?.[0]
    input.value = ''
    if (selected !== undefined) {
      void addFile(selected)
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsDragging(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped !== undefined) {
      void addFile(dropped)
    }
  }

  async function addFile(selected: File) {
    if (isReading) {
      return
    }

    setError(null)
    const validationError = validateImageFile(selected)
    if (validationError !== null) {
      setError(validationError)
      return
    }

    setIsReading(true)
    try {
      const { width, height } = await readImageDimensions(selected)
      if (!mountedRef.current) {
        return
      }

      const src = URL.createObjectURL(selected)
      try {
        onAddAsset({
          id: crypto.randomUUID(),
          kind: 'image',
          name: selected.name || 'Untitled image',
          mimeType: selected.type.toLowerCase(),
          width,
          height,
          src,
        })
      } catch (cause) {
        URL.revokeObjectURL(src)
        throw cause
      }
    } catch (cause) {
      if (mountedRef.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not add the selected image.',
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsReading(false)
      }
    }
  }

  function addWithPreset(
    asset: OverlayAsset,
    preset: ImageOverlayPreset,
  ) {
    setError(null)
    const overlay = createImageOverlayFromPreset(
      {
        id: crypto.randomUUID(),
        asset,
        currentSourceMs,
        sourceDurationMs,
        videoWidth,
        videoHeight,
        zIndex: nextImageOverlayZIndex(overlays),
      },
      preset,
    )
    if (overlay === null) {
      setError('Seek before the end of the video, then add the image again.')
      return
    }
    onAddOverlay(overlay)
  }

  function removeAsset(asset: OverlayAsset) {
    setError(null)
    const usageCount = overlays.filter(
      (overlay) => overlay.assetId === asset.id,
    ).length
    if (
      usageCount > 0 &&
      !window.confirm(
        `Removing "${asset.name}" will also remove ${usageCount} image overlay${
          usageCount === 1 ? '' : 's'
        }. Continue?`,
      )
    ) {
      return
    }
    onRemoveAsset(asset.id)
  }

  return (
    <section className="media-panel" aria-labelledby="media-panel-heading">
      <h2 id="media-panel-heading" className="sr-only">
        Images
      </h2>
      <label
        className={[
          'upload-zone',
          isDragging ? 'upload-zone--active' : '',
          isReading ? 'upload-zone--busy' : '',
        ].join(' ').trim()}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <IconBadge icon="image-plus" size={44} />
        <span className="upload-zone__text">
          <span className="upload-zone__title">
            {isReading ? 'Reading image…' : 'Upload Image'}
          </span>
          <span className="upload-zone__hint">
            PNG, JPEG, or WebP. Images stay in this browser.
          </span>
        </span>
        <input
          type="file"
          className="sr-only"
          accept={IMAGE_FILE_ACCEPT}
          disabled={isReading}
          onChange={handleUpload}
        />
      </label>

      {error !== null && (
        <p role="alert" className="error-text" style={{ fontSize: 13 }}>
          {error}
        </p>
      )}

      {assets.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, textAlign: 'center' }}>
          No images uploaded yet.
        </p>
      ) : (
        <ul className="media-grid">
          {assets.map((asset) => {
            const usageCount = overlays.filter(
              (overlay) => overlay.assetId === asset.id,
            ).length
            return (
              <li key={asset.id} className="media-card">
                <img src={asset.src} alt={`Preview of ${asset.name}`} />
                <span className="media-card__name" title={asset.name}>
                  {asset.name}
                </span>
                <span className="media-card__meta">
                  {asset.width}×{asset.height} · Used {usageCount}{' '}
                  {usageCount === 1 ? 'time' : 'times'}
                </span>
                <div className="media-card__add">
                  <span className="label-text">Add</span>
                  {PRESETS.map(({ preset, label, name }) => (
                    <button
                      key={preset}
                      type="button"
                      className="chip-btn"
                      aria-label={`Add ${asset.name} ${name}`}
                      onClick={() => addWithPreset(asset, preset)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="media-card__remove"
                  aria-label={`Remove ${asset.name}`}
                  title="Remove image"
                  onClick={() => removeAsset(asset)}
                >
                  <Icon name="x" size={13} strokeWidth={2} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
