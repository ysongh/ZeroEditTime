// Pure immutable editor operations for still-image overlay assets and layers.
// Object URL lifetime is deliberately handled by App: an asset in undo history
// must remain usable, so removing it from the current state is not necessarily
// a permanent removal yet.

import { normalizeImageOverlay } from './normalize'
import type { ImageOverlay, OverlayAsset } from './types'

export interface OverlayEditorState {
  overlayAssets: OverlayAsset[]
  imageOverlays: ImageOverlay[]
  selectedOverlayId: string | null
}

export type ImageOverlayPatch = Partial<Omit<ImageOverlay, 'id'>>

export type OverlayEditorAction =
  | { type: 'add-overlay-asset'; asset: OverlayAsset }
  | { type: 'remove-overlay-asset'; assetId: string }
  | { type: 'add-image-overlay'; overlay: ImageOverlay }
  | { type: 'update-image-overlay'; id: string; patch: ImageOverlayPatch }
  | { type: 'remove-image-overlay'; id: string }
  | {
      type: 'duplicate-image-overlay'
      id: string
      newId: string
      sourceDurationMs?: number
    }
  | { type: 'select-image-overlay'; id: string | null }
  | { type: 'bring-overlay-forward'; id: string }
  | { type: 'send-overlay-backward'; id: string }
  | { type: 'set-overlay-layer-position'; id: string; position: number }

const DUPLICATE_POSITION_OFFSET = 0.02
const DUPLICATE_TIME_OFFSET_MS = 100

/** Backward-compatible defaults for documents with no overlay fields. */
export function createOverlayEditorState(
  initial?: Partial<OverlayEditorState>,
): OverlayEditorState {
  const overlayAssets = initial?.overlayAssets ?? []
  const imageOverlays = initial?.imageOverlays ?? []
  const requestedSelection = initial?.selectedOverlayId ?? null
  const selectedOverlayId =
    requestedSelection !== null &&
    imageOverlays.some((overlay) => overlay.id === requestedSelection)
      ? requestedSelection
      : null

  return {
    overlayAssets: [...overlayAssets],
    imageOverlays: [...imageOverlays],
    selectedOverlayId,
  }
}

export function addOverlayAsset(
  state: OverlayEditorState,
  asset: OverlayAsset,
): OverlayEditorState {
  if (state.overlayAssets.some((existing) => existing.id === asset.id)) {
    return state
  }
  return {
    ...state,
    overlayAssets: [...state.overlayAssets, { ...asset }],
  }
}

/**
 * Remove an asset and every overlay that references it. URL revocation happens
 * only when App determines the URL is absent from current state AND history.
 */
export function removeOverlayAsset(
  state: OverlayEditorState,
  assetId: string,
): OverlayEditorState {
  const overlayAssets = state.overlayAssets.filter(
    (asset) => asset.id !== assetId,
  )
  const imageOverlays = state.imageOverlays.filter(
    (overlay) => overlay.assetId !== assetId,
  )
  if (
    overlayAssets.length === state.overlayAssets.length &&
    imageOverlays.length === state.imageOverlays.length
  ) {
    return state
  }

  const selectionStillExists =
    state.selectedOverlayId !== null &&
    imageOverlays.some((overlay) => overlay.id === state.selectedOverlayId)
  return {
    overlayAssets,
    imageOverlays,
    selectedOverlayId: selectionStillExists ? state.selectedOverlayId : null,
  }
}

export function addImageOverlay(
  state: OverlayEditorState,
  overlay: ImageOverlay,
): OverlayEditorState {
  if (
    state.imageOverlays.some((existing) => existing.id === overlay.id) ||
    !state.overlayAssets.some((asset) => asset.id === overlay.assetId)
  ) {
    return state
  }

  const normalized = normalizeImageOverlay(overlay)
  if (normalized === null) {
    return state
  }
  return {
    ...state,
    imageOverlays: [...state.imageOverlays, normalized],
  }
}

export function updateImageOverlay(
  state: OverlayEditorState,
  id: string,
  patch: ImageOverlayPatch,
): OverlayEditorState {
  const index = state.imageOverlays.findIndex((overlay) => overlay.id === id)
  if (index === -1) {
    return state
  }

  const current = state.imageOverlays[index]
  const candidate = normalizeImageOverlay({ ...current, ...patch, id })
  if (
    candidate === null ||
    !state.overlayAssets.some((asset) => asset.id === candidate.assetId) ||
    overlaysEqual(current, candidate)
  ) {
    return state
  }

  const imageOverlays = state.imageOverlays.slice()
  imageOverlays[index] = candidate
  return { ...state, imageOverlays }
}

export function removeImageOverlay(
  state: OverlayEditorState,
  id: string,
): OverlayEditorState {
  const imageOverlays = state.imageOverlays.filter(
    (overlay) => overlay.id !== id,
  )
  if (imageOverlays.length === state.imageOverlays.length) {
    return state
  }
  return {
    ...state,
    imageOverlays,
    selectedOverlayId:
      state.selectedOverlayId === id ? null : state.selectedOverlayId,
  }
}

/**
 * Duplicate with a caller-provided unique ID so this operation stays
 * deterministic and testable. The copy moves slightly within the frame; a
 * full-frame overlay that cannot move is shifted 100 ms instead.
 */
export function duplicateImageOverlay(
  state: OverlayEditorState,
  id: string,
  newId: string,
  sourceDurationMs?: number,
): OverlayEditorState {
  const source = state.imageOverlays.find((overlay) => overlay.id === id)
  if (
    source === undefined ||
    newId === '' ||
    state.imageOverlays.some((overlay) => overlay.id === newId)
  ) {
    return state
  }

  const x = offsetCoordinate(source.x, source.width)
  const y = offsetCoordinate(source.y, source.height)
  const needsTimeOffset = x === source.x && y === source.y
  const timeOffset = needsTimeOffset
    ? duplicateTimeOffset(source, sourceDurationMs)
    : 0
  const duplicate = normalizeImageOverlay({
    ...source,
    id: newId,
    startSourceMs: source.startSourceMs + timeOffset,
    endSourceMs: source.endSourceMs + timeOffset,
    x,
    y,
  })
  if (duplicate === null) {
    return state
  }

  return {
    ...state,
    imageOverlays: [...state.imageOverlays, duplicate],
    selectedOverlayId: duplicate.id,
  }
}

export function selectImageOverlay(
  state: OverlayEditorState,
  id: string | null,
): OverlayEditorState {
  const selectedOverlayId =
    id !== null && state.imageOverlays.some((overlay) => overlay.id === id)
      ? id
      : null
  return selectedOverlayId === state.selectedOverlayId
    ? state
    : { ...state, selectedOverlayId }
}

export function bringOverlayForward(
  state: OverlayEditorState,
  id: string,
): OverlayEditorState {
  return moveOverlayOneLayer(state, id, 1)
}

export function sendOverlayBackward(
  state: OverlayEditorState,
  id: string,
): OverlayEditorState {
  return moveOverlayOneLayer(state, id, -1)
}

/**
 * Move an overlay to a 1-based back-to-front stack position. A real move
 * rewrites every layer to a sequential rank so tied or fractional z-indexes
 * cannot make the resulting order ambiguous.
 */
export function setOverlayLayerPosition(
  state: OverlayEditorState,
  id: string,
  position: number,
): OverlayEditorState {
  if (!Number.isFinite(position) || !Number.isInteger(position)) {
    return state
  }

  const ordered = [...state.imageOverlays].sort(compareOverlayLayerOrder)
  const currentIndex = ordered.findIndex((overlay) => overlay.id === id)
  if (currentIndex === -1) {
    return state
  }

  const destinationIndex = Math.min(
    ordered.length - 1,
    Math.max(0, position - 1),
  )
  if (destinationIndex === currentIndex) {
    return state
  }

  const [target] = ordered.splice(currentIndex, 1)
  ordered.splice(destinationIndex, 0, target)
  const ranks = new Map(
    ordered.map((overlay, index) => [overlay.id, index] as const),
  )
  const imageOverlays = state.imageOverlays.map((overlay) => {
    const zIndex = ranks.get(overlay.id)
    if (zIndex === undefined) {
      return overlay
    }
    return zIndex === overlay.zIndex ? overlay : { ...overlay, zIndex }
  })

  return { ...state, imageOverlays }
}

/** Apply a typed overlay action against the state supplied at reduce time. */
export function overlayEditorReducer(
  state: OverlayEditorState,
  action: OverlayEditorAction,
): OverlayEditorState {
  switch (action.type) {
    case 'add-overlay-asset':
      return addOverlayAsset(state, action.asset)
    case 'remove-overlay-asset':
      return removeOverlayAsset(state, action.assetId)
    case 'add-image-overlay':
      return addImageOverlay(state, action.overlay)
    case 'update-image-overlay':
      return updateImageOverlay(state, action.id, action.patch)
    case 'remove-image-overlay':
      return removeImageOverlay(state, action.id)
    case 'duplicate-image-overlay':
      return duplicateImageOverlay(
        state,
        action.id,
        action.newId,
        action.sourceDurationMs,
      )
    case 'select-image-overlay':
      return selectImageOverlay(state, action.id)
    case 'bring-overlay-forward':
      return bringOverlayForward(state, action.id)
    case 'send-overlay-backward':
      return sendOverlayBackward(state, action.id)
    case 'set-overlay-layer-position':
      return setOverlayLayerPosition(state, action.id, action.position)
  }
}

/**
 * Return the distinct app-owned object URLs reachable from one or more asset
 * lists. App passes current assets plus every undo snapshot, preventing shared
 * or undoable URLs from being revoked prematurely.
 */
export function collectOverlayObjectUrls(
  assetLists: readonly (readonly OverlayAsset[])[],
): Set<string> {
  const urls = new Set<string>()
  for (const assets of assetLists) {
    for (const asset of assets) {
      if (asset.src.startsWith('blob:')) {
        urls.add(asset.src)
      }
    }
  }
  return urls
}

function overlaysEqual(a: ImageOverlay, b: ImageOverlay): boolean {
  return (
    a.id === b.id &&
    a.assetId === b.assetId &&
    a.startSourceMs === b.startSourceMs &&
    a.endSourceMs === b.endSourceMs &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.fit === b.fit &&
    a.opacity === b.opacity &&
    a.zIndex === b.zIndex &&
    a.fadeInMs === b.fadeInMs &&
    a.fadeOutMs === b.fadeOutMs
  )
}

function offsetCoordinate(position: number, size: number): number {
  const max = Math.max(0, 1 - size)
  const forward = Math.min(max, position + DUPLICATE_POSITION_OFFSET)
  if (forward !== position) {
    return forward
  }
  return Math.max(0, position - DUPLICATE_POSITION_OFFSET)
}

function duplicateTimeOffset(
  overlay: Readonly<ImageOverlay>,
  sourceDurationMs: number | undefined,
): number {
  if (
    sourceDurationMs === undefined ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs < 0
  ) {
    return DUPLICATE_TIME_OFFSET_MS
  }
  if (overlay.endSourceMs + DUPLICATE_TIME_OFFSET_MS <= sourceDurationMs) {
    return DUPLICATE_TIME_OFFSET_MS
  }
  return -Math.min(DUPLICATE_TIME_OFFSET_MS, overlay.startSourceMs)
}

function moveOverlayOneLayer(
  state: OverlayEditorState,
  id: string,
  direction: -1 | 1,
): OverlayEditorState {
  const target = state.imageOverlays.find((overlay) => overlay.id === id)
  if (target === undefined) {
    return state
  }

  const levels = [
    ...new Set(state.imageOverlays.map((overlay) => overlay.zIndex)),
  ].sort((a, b) => a - b)
  const levelIndex = levels.indexOf(target.zIndex)
  const peersAtLevel = state.imageOverlays.filter(
    (overlay) => overlay.zIndex === target.zIndex,
  ).length

  let zIndex: number
  if (direction === 1) {
    if (peersAtLevel > 1) {
      const nextLevel = levels[levelIndex + 1]
      zIndex =
        nextLevel === undefined
          ? target.zIndex + 1
          : midpoint(target.zIndex, nextLevel)
    } else {
      const nextLevel = levels[levelIndex + 1]
      if (nextLevel === undefined) {
        return state
      }
      const levelAfterNext = levels[levelIndex + 2]
      zIndex =
        levelAfterNext === undefined
          ? nextLevel + 1
          : midpoint(nextLevel, levelAfterNext)
    }
  } else if (peersAtLevel > 1) {
    const previousLevel = levels[levelIndex - 1]
    zIndex =
      previousLevel === undefined
        ? target.zIndex - 1
        : midpoint(previousLevel, target.zIndex)
  } else {
    const previousLevel = levels[levelIndex - 1]
    if (previousLevel === undefined) {
      return state
    }
    const levelBeforePrevious = levels[levelIndex - 2]
    zIndex =
      levelBeforePrevious === undefined
        ? previousLevel - 1
        : midpoint(levelBeforePrevious, previousLevel)
  }

  const imageOverlays = state.imageOverlays.map((overlay) =>
    overlay.id === id ? { ...overlay, zIndex } : overlay,
  )
  return { ...state, imageOverlays }
}

function midpoint(a: number, b: number): number {
  return a + (b - a) / 2
}

function compareOverlayLayerOrder(a: ImageOverlay, b: ImageOverlay): number {
  const aZIndex = Number.isFinite(a.zIndex) ? a.zIndex : 0
  const bZIndex = Number.isFinite(b.zIndex) ? b.zIndex : 0
  if (aZIndex !== bZIndex) {
    return aZIndex - bZIndex
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
