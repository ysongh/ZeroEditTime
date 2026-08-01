import { useMemo } from 'react'
import {
  buildImageOverlayPreviewItems,
  previewObjectFit,
} from './preview'
import type { ImageOverlay, OverlayAsset } from './types'

type OverlayStageProps = {
  assets: readonly OverlayAsset[]
  overlays: readonly ImageOverlay[]
  currentSourceMs: number
  selectedOverlayId: string | null
  isEditing: boolean
  onSelectOverlay: (id: string) => void
}

export default function OverlayStage({
  assets,
  overlays,
  currentSourceMs,
  selectedOverlayId,
  isEditing,
  onSelectOverlay,
}: OverlayStageProps) {
  const items = useMemo(
    () =>
      buildImageOverlayPreviewItems(overlays, assets, currentSourceMs),
    [assets, currentSourceMs, overlays],
  )
  const selectedItem = isEditing
    ? items.find((item) => item.overlay.id === selectedOverlayId)
    : undefined

  return (
    <>
      {/* This fixed stacking context keeps every domain z-index below captions. */}
      <div
        aria-hidden={!isEditing}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.overlay.id}
            type="button"
            aria-label={`Select ${item.asset.name} overlay`}
            aria-pressed={item.overlay.id === selectedOverlayId}
            tabIndex={isEditing ? 0 : -1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (isEditing) {
                onSelectOverlay(item.overlay.id)
              }
            }}
            style={{
              position: 'absolute',
              left: `${item.overlay.x * 100}%`,
              top: `${item.overlay.y * 100}%`,
              width: `${item.overlay.width * 100}%`,
              height: `${item.overlay.height * 100}%`,
              zIndex: index + 1,
              display: 'block',
              margin: 0,
              padding: 0,
              overflow: 'hidden',
              border: 0,
              borderRadius: 0,
              background: 'transparent',
              opacity: item.opacity,
              cursor: isEditing ? 'pointer' : 'default',
              pointerEvents: isEditing ? 'auto' : 'none',
              userSelect: 'none',
            }}
          >
            <img
              src={item.asset.src}
              alt=""
              draggable={false}
              style={{
                display: 'block',
                width: '100%',
                height: '100%',
                objectFit: previewObjectFit(item.overlay.fit),
                objectPosition: 'center',
                pointerEvents: 'none',
              }}
            />
          </button>
        ))}
      </div>

      {/* Part F exposes selection only; transform handles begin in Part G. */}
      {selectedItem !== undefined && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${selectedItem.overlay.x * 100}%`,
            top: `${selectedItem.overlay.y * 100}%`,
            width: `${selectedItem.overlay.width * 100}%`,
            height: `${selectedItem.overlay.height * 100}%`,
            zIndex: 3,
            boxSizing: 'border-box',
            border: '2px solid #60a5fa',
            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.8)',
            pointerEvents: 'none',
          }}
        />
      )}
    </>
  )
}
