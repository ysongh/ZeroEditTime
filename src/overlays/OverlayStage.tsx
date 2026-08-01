import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  buildImageOverlayPreviewItems,
  previewObjectFit,
} from './preview'
import type { ImageOverlayPreviewItem } from './preview'
import {
  moveOverlayGeometry,
  resizeOverlayGeometry,
  type OverlayGeometry,
  type ResizeHandle,
} from './transform'
import type { ImageOverlay, OverlayAsset } from './types'

const MIN_TRANSFORM_SIZE_PX = 24
const HANDLE_SIZE_PX = 16
const KEYBOARD_RESIZE_STEP_PX = 4
const GEOMETRY_EPSILON = 1e-9

const RESIZE_HANDLES: readonly {
  handle: ResizeHandle
  label: string
  cursor: 'nwse-resize' | 'nesw-resize'
  horizontal: 'left' | 'right'
  vertical: 'top' | 'bottom'
}[] = [
  {
    handle: 'north-west',
    label: 'Resize image overlay from top left',
    cursor: 'nwse-resize',
    horizontal: 'left',
    vertical: 'top',
  },
  {
    handle: 'north-east',
    label: 'Resize image overlay from top right',
    cursor: 'nesw-resize',
    horizontal: 'right',
    vertical: 'top',
  },
  {
    handle: 'south-east',
    label: 'Resize image overlay from bottom right',
    cursor: 'nwse-resize',
    horizontal: 'right',
    vertical: 'bottom',
  },
  {
    handle: 'south-west',
    label: 'Resize image overlay from bottom left',
    cursor: 'nesw-resize',
    horizontal: 'left',
    vertical: 'bottom',
  },
]

type OverlayStageProps = {
  assets: readonly OverlayAsset[]
  overlays: readonly ImageOverlay[]
  currentSourceMs: number
  selectedOverlayId: string | null
  isEditing: boolean
  onSelectOverlay: (id: string) => void
  onClearSelection: () => void
  onCommitGeometry: (id: string, geometry: OverlayGeometry) => void
  onRemoveOverlay: (id: string) => void
  onBeginTransform: () => void
}

type TransformSession = {
  overlayId: string
  item: ImageOverlayPreviewItem
  pointerId: number
  kind: 'move' | 'resize'
  handle?: ResizeHandle
  origin: OverlayGeometry
  startClientX: number
  startClientY: number
  frameWidth: number
  frameHeight: number
  minWidth: number
  minHeight: number
  captureTarget: HTMLElement
}

type TransformDraft = {
  item: ImageOverlayPreviewItem
  geometry: OverlayGeometry
}

function geometryFromOverlay(overlay: Readonly<ImageOverlay>): OverlayGeometry {
  return {
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height,
  }
}

function geometriesEqual(a: OverlayGeometry, b: OverlayGeometry): boolean {
  return (
    Math.abs(a.x - b.x) <= GEOMETRY_EPSILON &&
    Math.abs(a.y - b.y) <= GEOMETRY_EPSILON &&
    Math.abs(a.width - b.width) <= GEOMETRY_EPSILON &&
    Math.abs(a.height - b.height) <= GEOMETRY_EPSILON
  )
}

function comparePreviewItems(
  a: ImageOverlayPreviewItem,
  b: ImageOverlayPreviewItem,
): number {
  return (
    a.overlay.zIndex - b.overlay.zIndex ||
    (a.overlay.id < b.overlay.id ? -1 : a.overlay.id > b.overlay.id ? 1 : 0)
  )
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"]') !==
      null
  )
}

function releasePointerCapture(session: TransformSession): void {
  try {
    if (session.captureTarget.hasPointerCapture(session.pointerId)) {
      session.captureTarget.releasePointerCapture(session.pointerId)
    }
  } catch {
    // A source-time seek can detach a captured overlay before cleanup runs.
  }
}

function geometryAtPointer(
  session: TransformSession,
  clientX: number,
  clientY: number,
  unlockAspectRatio: boolean,
): OverlayGeometry {
  const deltaX = (clientX - session.startClientX) / session.frameWidth
  const deltaY = (clientY - session.startClientY) / session.frameHeight

  if (session.kind === 'move') {
    return moveOverlayGeometry(session.origin, deltaX, deltaY)
  }

  return resizeOverlayGeometry(
    session.origin,
    session.handle ?? 'south-east',
    deltaX,
    deltaY,
    {
      preserveAspectRatio: !unlockAspectRatio,
      minWidth: session.minWidth,
      minHeight: session.minHeight,
    },
  )
}

export default function OverlayStage({
  assets,
  overlays,
  currentSourceMs,
  selectedOverlayId,
  isEditing,
  onSelectOverlay,
  onClearSelection,
  onCommitGeometry,
  onRemoveOverlay,
  onBeginTransform,
}: OverlayStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<TransformSession | null>(null)
  const [draft, setDraft] = useState<TransformDraft | null>(null)
  const items = useMemo(
    () =>
      buildImageOverlayPreviewItems(overlays, assets, currentSourceMs),
    [assets, currentSourceMs, overlays],
  )

  const cancelActiveTransform = useCallback((): boolean => {
    const session = transformRef.current
    if (session === null) {
      return false
    }
    transformRef.current = null
    releasePointerCapture(session)
    setDraft(null)
    return true
  }, [])

  useEffect(() => {
    if (!isEditing) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (cancelActiveTransform()) {
          event.preventDefault()
        } else if (!isTextEditingTarget(event.target)) {
          onClearSelection()
          event.preventDefault()
        }
        return
      }

      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selectedOverlayId !== null &&
        !isTextEditingTarget(event.target)
      ) {
        cancelActiveTransform()
        onRemoveOverlay(selectedOverlayId)
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    cancelActiveTransform,
    isEditing,
    onClearSelection,
    onRemoveOverlay,
    selectedOverlayId,
  ])

  useEffect(() => {
    return () => {
      const session = transformRef.current
      transformRef.current = null
      if (session !== null) {
        releasePointerCapture(session)
      }
    }
  }, [])

  function displayedGeometry(overlay: Readonly<ImageOverlay>): OverlayGeometry {
    return isEditing && draft?.item.overlay.id === overlay.id
      ? draft.geometry
      : geometryFromOverlay(overlay)
  }

  function resizeWithKeyboard(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    overlayId: string,
    geometry: OverlayGeometry,
    handle: ResizeHandle,
  ) {
    const frame = stageRef.current?.getBoundingClientRect()
    if (frame === undefined || frame.width <= 0 || frame.height <= 0) {
      return
    }

    const step = event.altKey ? 1 : KEYBOARD_RESIZE_STEP_PX
    let deltaX = 0
    let deltaY = 0
    switch (event.key) {
      case 'ArrowLeft':
        deltaX = -step / frame.width
        break
      case 'ArrowRight':
        deltaX = step / frame.width
        break
      case 'ArrowUp':
        deltaY = -step / frame.height
        break
      case 'ArrowDown':
        deltaY = step / frame.height
        break
      default:
        return
    }

    event.preventDefault()
    event.stopPropagation()
    onBeginTransform()
    const resized = resizeOverlayGeometry(
      geometry,
      handle,
      deltaX,
      deltaY,
      {
        preserveAspectRatio: !event.shiftKey,
        minWidth: Math.min(1, MIN_TRANSFORM_SIZE_PX / frame.width),
        minHeight: Math.min(1, MIN_TRANSFORM_SIZE_PX / frame.height),
      },
    )
    if (!geometriesEqual(geometry, resized)) {
      onCommitGeometry(overlayId, resized)
    }
  }

  function beginTransform(
    event: ReactPointerEvent<HTMLElement>,
    item: ImageOverlayPreviewItem,
    geometry: OverlayGeometry,
    kind: TransformSession['kind'],
    handle?: ResizeHandle,
  ) {
    event.stopPropagation()
    if (
      !isEditing ||
      event.button !== 0 ||
      transformRef.current !== null
    ) {
      return
    }

    const frame = stageRef.current?.getBoundingClientRect()
    if (frame === undefined || frame.width <= 0 || frame.height <= 0) {
      return
    }

    event.preventDefault()
    onSelectOverlay(item.overlay.id)
    onBeginTransform()

    const captureTarget = event.currentTarget
    captureTarget.focus({ preventScroll: true })
    captureTarget.setPointerCapture(event.pointerId)
    const session: TransformSession = {
      overlayId: item.overlay.id,
      item,
      pointerId: event.pointerId,
      kind,
      handle,
      origin: { ...geometry },
      startClientX: event.clientX,
      startClientY: event.clientY,
      frameWidth: frame.width,
      frameHeight: frame.height,
      minWidth: Math.min(1, MIN_TRANSFORM_SIZE_PX / frame.width),
      minHeight: Math.min(1, MIN_TRANSFORM_SIZE_PX / frame.height),
      captureTarget,
    }
    transformRef.current = session
    setDraft({ item, geometry: { ...geometry } })
  }

  function continueTransform(event: ReactPointerEvent<HTMLElement>) {
    const session = transformRef.current
    if (session === null || session.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setDraft({
      item: session.item,
      geometry: geometryAtPointer(
        session,
        event.clientX,
        event.clientY,
        event.shiftKey,
      ),
    })
  }

  function finishTransform(event: ReactPointerEvent<HTMLElement>) {
    const session = transformRef.current
    if (session === null || session.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const geometry = geometryAtPointer(
      session,
      event.clientX,
      event.clientY,
      event.shiftKey,
    )
    transformRef.current = null
    releasePointerCapture(session)
    setDraft(null)

    if (!geometriesEqual(session.origin, geometry)) {
      onCommitGeometry(session.overlayId, geometry)
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    const session = transformRef.current
    if (session !== null && session.pointerId === event.pointerId) {
      event.stopPropagation()
      cancelActiveTransform()
    }
  }

  function handleLostPointerCapture(event: ReactPointerEvent<HTMLElement>) {
    const session = transformRef.current
    if (
      session !== null &&
      session.pointerId === event.pointerId &&
      session.captureTarget === event.currentTarget
    ) {
      cancelActiveTransform()
    }
  }

  const renderedItems =
    draft !== null &&
    !items.some((item) => item.overlay.id === draft.item.overlay.id)
      ? [...items, draft.item].sort(comparePreviewItems)
      : items
  const activeSelectedId = draft?.item.overlay.id ?? selectedOverlayId
  const selectedItem = isEditing
    ? renderedItems.find((item) => item.overlay.id === activeSelectedId)
    : undefined
  const selectedGeometry =
    selectedItem === undefined
      ? undefined
      : displayedGeometry(selectedItem.overlay)

  return (
    <>
      {/* This fixed stacking context keeps every domain z-index below captions. */}
      <div
        ref={stageRef}
        aria-hidden={!isEditing}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 1,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {renderedItems.map((item, index) => {
          const geometry = displayedGeometry(item.overlay)
          return (
            <button
              key={item.overlay.id}
              type="button"
              aria-label={`Select and move ${item.asset.name} overlay`}
              aria-pressed={item.overlay.id === activeSelectedId}
              tabIndex={isEditing ? 0 : -1}
              onPointerDown={(event) => {
                event.stopPropagation()
                beginTransform(
                  event,
                  item,
                  geometry,
                  'move',
                )
              }}
              onPointerMove={continueTransform}
              onPointerUp={finishTransform}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handleLostPointerCapture}
              onClick={() => {
                if (isEditing) {
                  onSelectOverlay(item.overlay.id)
                }
              }}
              style={{
                position: 'absolute',
                left: `${geometry.x * 100}%`,
                top: `${geometry.y * 100}%`,
                width: `${geometry.width * 100}%`,
                height: `${geometry.height * 100}%`,
                zIndex: index + 1,
                display: 'block',
                margin: 0,
                padding: 0,
                overflow: 'hidden',
                border: 0,
                borderRadius: 0,
                background: 'transparent',
                opacity: item.opacity,
                cursor:
                  isEditing && item.overlay.id === activeSelectedId
                    ? 'move'
                    : isEditing
                      ? 'pointer'
                      : 'default',
                pointerEvents: isEditing ? 'auto' : 'none',
                touchAction: isEditing ? 'none' : 'auto',
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
          )
        })}
      </div>

      {selectedItem !== undefined && selectedGeometry !== undefined && (
        <div
          role="group"
          aria-label={`Move and resize ${selectedItem.asset.name} overlay`}
          tabIndex={0}
          onPointerDown={(event) =>
            beginTransform(
              event,
              selectedItem,
              selectedGeometry,
              'move',
            )
          }
          onPointerMove={continueTransform}
          onPointerUp={finishTransform}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          style={{
            position: 'absolute',
            left: `${selectedGeometry.x * 100}%`,
            top: `${selectedGeometry.y * 100}%`,
            width: `${selectedGeometry.width * 100}%`,
            height: `${selectedGeometry.height * 100}%`,
            zIndex: 3,
            boxSizing: 'border-box',
            border: '2px solid #60a5fa',
            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.8)',
            cursor: 'move',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          {RESIZE_HANDLES.map((config) => (
            <button
              key={config.handle}
              type="button"
              aria-label={config.label}
              aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
              title={`${config.label} (drag or use arrow keys; hold Shift for free resize)`}
              onPointerDown={(event) =>
                beginTransform(
                  event,
                  selectedItem,
                  selectedGeometry,
                  'resize',
                  config.handle,
                )
              }
              onPointerMove={continueTransform}
              onPointerUp={finishTransform}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handleLostPointerCapture}
              onKeyDown={(event) =>
                resizeWithKeyboard(
                  event,
                  selectedItem.overlay.id,
                  selectedGeometry,
                  config.handle,
                )
              }
              style={{
                position: 'absolute',
                [config.horizontal]: 0,
                [config.vertical]: 0,
                zIndex: 1,
                width: HANDLE_SIZE_PX,
                height: HANDLE_SIZE_PX,
                boxSizing: 'border-box',
                margin: 0,
                padding: 0,
                border: '2px solid #2563eb',
                borderRadius: 2,
                background: '#fff',
                cursor: config.cursor,
                touchAction: 'none',
              }}
            />
          ))}
        </div>
      )}
    </>
  )
}
