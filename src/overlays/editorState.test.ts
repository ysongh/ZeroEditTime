import { describe, expect, it } from 'vitest'
import {
  addImageOverlay,
  addOverlayAsset,
  bringOverlayForward,
  collectOverlayObjectUrls,
  createOverlayEditorState,
  duplicateImageOverlay,
  overlayEditorReducer,
  removeImageOverlay,
  removeOverlayAsset,
  selectImageOverlay,
  sendOverlayBackward,
  updateImageOverlay,
  type OverlayEditorState,
} from './editorState'
import type { ImageOverlay, OverlayAsset } from './types'

const ASSET: OverlayAsset = {
  id: 'asset-1',
  kind: 'image',
  name: 'slide.png',
  mimeType: 'image/png',
  width: 1600,
  height: 900,
  src: 'blob:slide',
}

const OTHER_ASSET: OverlayAsset = {
  ...ASSET,
  id: 'asset-2',
  name: 'logo.webp',
  mimeType: 'image/webp',
  src: 'blob:logo',
}

const OVERLAY: ImageOverlay = {
  id: 'overlay-1',
  assetId: ASSET.id,
  startSourceMs: 1_000,
  endSourceMs: 4_000,
  x: 0.1,
  y: 0.2,
  width: 0.4,
  height: 0.3,
  fit: 'contain',
  opacity: 1,
  zIndex: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
}

function withOverlay(
  overlay: ImageOverlay = OVERLAY,
  assets: OverlayAsset[] = [ASSET],
): OverlayEditorState {
  return {
    overlayAssets: assets,
    imageOverlays: [overlay],
    selectedOverlayId: null,
  }
}

describe('createOverlayEditorState', () => {
  it('uses backward-compatible empty defaults', () => {
    expect(createOverlayEditorState()).toEqual({
      overlayAssets: [],
      imageOverlays: [],
      selectedOverlayId: null,
    })
  })

  it('copies arrays and clears a selection that no longer exists', () => {
    const overlayAssets = [ASSET]
    const imageOverlays = [OVERLAY]
    const state = createOverlayEditorState({
      overlayAssets,
      imageOverlays,
      selectedOverlayId: 'missing',
    })

    expect(state.selectedOverlayId).toBeNull()
    expect(state.overlayAssets).not.toBe(overlayAssets)
    expect(state.imageOverlays).not.toBe(imageOverlays)
  })
})

describe('overlay asset operations', () => {
  it('adds an asset immutably', () => {
    const state = createOverlayEditorState()
    const next = addOverlayAsset(state, ASSET)

    expect(next).not.toBe(state)
    expect(next.overlayAssets).toEqual([ASSET])
    expect(state.overlayAssets).toEqual([])
    expect(next.overlayAssets[0]).not.toBe(ASSET)
  })

  it('does not add a duplicate asset ID', () => {
    const state = addOverlayAsset(createOverlayEditorState(), ASSET)
    expect(addOverlayAsset(state, { ...ASSET, src: 'blob:replacement' })).toBe(
      state,
    )
  })

  it('removes an asset and all dependent overlays', () => {
    const dependent = OVERLAY
    const secondDependent = {
      ...OVERLAY,
      id: 'overlay-2',
      assetId: ASSET.id,
    }
    const unrelated = {
      ...OVERLAY,
      id: 'overlay-3',
      assetId: OTHER_ASSET.id,
    }
    const state: OverlayEditorState = {
      overlayAssets: [ASSET, OTHER_ASSET],
      imageOverlays: [dependent, secondDependent, unrelated],
      selectedOverlayId: secondDependent.id,
    }

    const next = removeOverlayAsset(state, ASSET.id)

    expect(next.overlayAssets).toEqual([OTHER_ASSET])
    expect(next.imageOverlays).toEqual([unrelated])
    expect(next.selectedOverlayId).toBeNull()
    expect(state.imageOverlays).toHaveLength(3)
  })

  it('is a same-reference no-op for an unknown asset without dependents', () => {
    const state = createOverlayEditorState()
    expect(removeOverlayAsset(state, 'missing')).toBe(state)
  })
})

describe('image overlay operations', () => {
  it('adds a normalized asset-backed overlay', () => {
    const state = addOverlayAsset(createOverlayEditorState(), ASSET)
    const next = addImageOverlay(state, {
      ...OVERLAY,
      x: 0.9,
      width: 0.4,
      opacity: 2,
    })

    expect(next.imageOverlays).toEqual([
      { ...OVERLAY, x: 0.6, width: 0.4, opacity: 1 },
    ])
    expect(state.imageOverlays).toEqual([])
  })

  it('rejects duplicate IDs, missing assets, and invalid timing', () => {
    const state = withOverlay()
    expect(addImageOverlay(state, OVERLAY)).toBe(state)
    expect(
      addImageOverlay(state, {
        ...OVERLAY,
        id: 'missing-asset-overlay',
        assetId: 'missing',
      }),
    ).toBe(state)
    expect(
      addImageOverlay(state, {
        ...OVERLAY,
        id: 'bad-time',
        startSourceMs: 5_000,
        endSourceMs: 5_000,
      }),
    ).toBe(state)
  })

  it('updates one overlay immutably while preserving its ID', () => {
    const other = { ...OVERLAY, id: 'overlay-2', zIndex: 1 }
    const state: OverlayEditorState = {
      overlayAssets: [ASSET],
      imageOverlays: [OVERLAY, other],
      selectedOverlayId: OVERLAY.id,
    }
    const before = structuredClone(state)

    const next = updateImageOverlay(state, OVERLAY.id, {
      x: 0.95,
      width: 0.2,
      opacity: -1,
      fit: 'cover',
    })

    expect(next).not.toBe(state)
    expect(next.imageOverlays[0]).toMatchObject({
      id: OVERLAY.id,
      x: 0.8,
      width: 0.2,
      opacity: 0,
      fit: 'cover',
    })
    expect(next.imageOverlays[1]).toBe(other)
    expect(state).toEqual(before)
  })

  it('rejects unknown, unchanged, invalid-time, and missing-asset updates', () => {
    const state = withOverlay()
    expect(updateImageOverlay(state, 'missing', { opacity: 0.5 })).toBe(state)
    expect(updateImageOverlay(state, OVERLAY.id, { opacity: 1 })).toBe(state)
    expect(
      updateImageOverlay(state, OVERLAY.id, {
        endSourceMs: OVERLAY.startSourceMs,
      }),
    ).toBe(state)
    expect(
      updateImageOverlay(state, OVERLAY.id, { assetId: 'missing' }),
    ).toBe(state)
  })

  it('removes an overlay and clears its selection', () => {
    const state = { ...withOverlay(), selectedOverlayId: OVERLAY.id }
    const next = removeImageOverlay(state, OVERLAY.id)

    expect(next.imageOverlays).toEqual([])
    expect(next.selectedOverlayId).toBeNull()
    expect(state.imageOverlays).toEqual([OVERLAY])
    expect(removeImageOverlay(next, 'missing')).toBe(next)
  })

  it('duplicates with a new ID, visible offset, and no original mutation', () => {
    const state = withOverlay()
    const next = duplicateImageOverlay(state, OVERLAY.id, 'overlay-copy')

    expect(next.imageOverlays).toHaveLength(2)
    expect(next.imageOverlays[0]).toBe(OVERLAY)
    expect(next.imageOverlays[1]).toEqual({
      ...OVERLAY,
      id: 'overlay-copy',
      x: next.imageOverlays[1].x,
      y: 0.22,
    })
    expect(next.imageOverlays[1].x).toBeCloseTo(0.12)
    expect(next.selectedOverlayId).toBe('overlay-copy')
    expect(state.imageOverlays).toEqual([OVERLAY])
  })

  it('temporally offsets a full-frame duplicate that cannot move', () => {
    const fullFrame = {
      ...OVERLAY,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }
    const next = duplicateImageOverlay(
      withOverlay(fullFrame),
      fullFrame.id,
      'full-copy',
    )

    expect(next.imageOverlays[1]).toMatchObject({
      id: 'full-copy',
      x: 0,
      y: 0,
      startSourceMs: 1_100,
      endSourceMs: 4_100,
    })
  })

  it('rejects unknown sources and empty or colliding duplicate IDs', () => {
    const state = withOverlay()
    expect(duplicateImageOverlay(state, 'missing', 'copy')).toBe(state)
    expect(duplicateImageOverlay(state, OVERLAY.id, '')).toBe(state)
    expect(duplicateImageOverlay(state, OVERLAY.id, OVERLAY.id)).toBe(state)
  })

  it('selects only an existing overlay and treats selection as a no-op when equal', () => {
    const state = withOverlay()
    const selected = selectImageOverlay(state, OVERLAY.id)
    expect(selected.selectedOverlayId).toBe(OVERLAY.id)
    expect(selectImageOverlay(selected, OVERLAY.id)).toBe(selected)
    expect(selectImageOverlay(selected, 'missing').selectedOverlayId).toBeNull()
  })
})

describe('overlay layer operations', () => {
  const bottom = { ...OVERLAY, id: 'bottom', zIndex: 0 }
  const middle = { ...OVERLAY, id: 'middle', zIndex: 10 }
  const top = { ...OVERLAY, id: 'top', zIndex: 20 }
  const state: OverlayEditorState = {
    overlayAssets: [ASSET],
    imageOverlays: [top, bottom, middle],
    selectedOverlayId: middle.id,
  }

  it('brings an overlay forward by one layer', () => {
    const next = bringOverlayForward(state, middle.id)
    expect(
      [...next.imageOverlays]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((overlay) => overlay.id),
    ).toEqual(['bottom', 'top', 'middle'])
    expect(state.imageOverlays).toEqual([top, bottom, middle])
  })

  it('sends an overlay backward by one layer', () => {
    const next = sendOverlayBackward(state, middle.id)
    expect(
      [...next.imageOverlays]
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((overlay) => overlay.id),
    ).toEqual(['middle', 'bottom', 'top'])
  })

  it('gives a moved tied layer an unambiguous z-index independent of timing', () => {
    const tied: OverlayEditorState = {
      ...state,
      imageOverlays: [
        { ...top, id: 'a', zIndex: 1, startSourceMs: 2_000 },
        { ...bottom, id: 'b', zIndex: 1, startSourceMs: 1_000 },
        { ...middle, id: 'c', zIndex: 1, startSourceMs: 3_000 },
      ],
    }
    const moved = bringOverlayForward(tied, 'a')
    expect(
      moved.imageOverlays.find((overlay) => overlay.id === 'a')?.zIndex,
    ).toBeGreaterThan(1)
    const sent = sendOverlayBackward(tied, 'a')
    expect(
      sent.imageOverlays.find((overlay) => overlay.id === 'a')?.zIndex,
    ).toBeLessThan(1)
  })

  it('no-ops at unique stack edges and for an unknown overlay', () => {
    expect(sendOverlayBackward(state, bottom.id)).toBe(state)
    expect(bringOverlayForward(state, top.id)).toBe(state)
    expect(bringOverlayForward(state, 'missing')).toBe(state)
  })
})

describe('collectOverlayObjectUrls', () => {
  it('deduplicates shared blob URLs across current state and undo history', () => {
    expect(
      collectOverlayObjectUrls([
        [ASSET, { ...OTHER_ASSET, src: ASSET.src }],
        [OTHER_ASSET],
        [{ ...ASSET, id: 'static', src: '/images/static.png' }],
      ]),
    ).toEqual(new Set(['blob:slide', 'blob:logo']))
  })
})

describe('overlayEditorReducer', () => {
  it('applies typed actions against the latest supplied state', () => {
    const withAsset = overlayEditorReducer(createOverlayEditorState(), {
      type: 'add-overlay-asset',
      asset: ASSET,
    })
    const withLayer = overlayEditorReducer(withAsset, {
      type: 'add-image-overlay',
      overlay: OVERLAY,
    })
    const selected = overlayEditorReducer(withLayer, {
      type: 'select-image-overlay',
      id: OVERLAY.id,
    })

    expect(selected.overlayAssets).toEqual([ASSET])
    expect(selected.imageOverlays).toEqual([OVERLAY])
    expect(selected.selectedOverlayId).toBe(OVERLAY.id)
  })
})
