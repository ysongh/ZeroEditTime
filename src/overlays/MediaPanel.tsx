import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
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

const panelStyle: CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: '1px solid var(--border)',
  borderRadius: 8,
  textAlign: 'left',
}

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
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const selected = input.files?.[0]
    input.value = ''
    if (selected === undefined || isReading) {
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
    <section style={panelStyle} aria-labelledby="media-panel-heading">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 id="media-panel-heading" style={{ margin: 0 }}>
            Images
          </h2>
          <p style={{ fontSize: 13, opacity: 0.75 }}>
            PNG, JPEG, or WebP. Images stay in this browser.
          </p>
        </div>
        <label>
          <span
            style={{
              display: 'inline-block',
              padding: '5px 10px',
              border: '1px solid var(--border)',
              borderRadius: 5,
              cursor: isReading ? 'not-allowed' : 'pointer',
              opacity: isReading ? 0.6 : 1,
            }}
          >
            {isReading ? 'Reading image…' : 'Upload image'}
          </span>
          <input
            type="file"
            accept={IMAGE_FILE_ACCEPT}
            disabled={isReading}
            onChange={(event) => void handleUpload(event)}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clipPath: 'inset(50%)',
            }}
          />
        </label>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: 'crimson', marginTop: 8, fontSize: 14 }}>
          {error}
        </p>
      )}

      {assets.length === 0 ? (
        <p style={{ marginTop: 10, fontSize: 14, opacity: 0.75 }}>
          No images uploaded yet.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '12px 0 0',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 10,
          }}
        >
          {assets.map((asset) => {
            const usageCount = overlays.filter(
              (overlay) => overlay.assetId === asset.id,
            ).length
            return (
              <li
                key={asset.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 8,
                  minWidth: 0,
                }}
              >
                <img
                  src={asset.src}
                  alt={`Preview of ${asset.name}`}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: 104,
                    objectFit: 'contain',
                    background: 'var(--code-bg)',
                    borderRadius: 4,
                  }}
                />
                <p
                  title={asset.name}
                  style={{
                    marginTop: 6,
                    fontSize: 14,
                    color: 'var(--text-h)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {asset.name}
                </p>
                <p style={{ fontSize: 12, opacity: 0.7 }}>
                  {asset.width}×{asset.height} · Used {usageCount}{' '}
                  {usageCount === 1 ? 'time' : 'times'}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginTop: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => addWithPreset(asset, 'default')}
                  >
                    Add at playhead
                  </button>
                  <button
                    type="button"
                    onClick={() => addWithPreset(asset, 'cutaway')}
                  >
                    Add as cutaway
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addWithPreset(asset, 'picture-in-picture')
                    }
                  >
                    Add as picture-in-picture
                  </button>
                  <button
                    type="button"
                    onClick={() => addWithPreset(asset, 'logo')}
                  >
                    Add as logo
                  </button>
                  <button type="button" onClick={() => removeAsset(asset)}>
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
