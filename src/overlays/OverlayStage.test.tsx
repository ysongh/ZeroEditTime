import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import CaptionOverlay from '../captions/CaptionOverlay'
import OverlayStage from './OverlayStage'
import type { ImageOverlay, OverlayAsset } from './types'

const ACTIVE_ASSET: OverlayAsset = {
  id: 'logo-asset',
  kind: 'image',
  name: 'logo.png',
  mimeType: 'image/png',
  width: 800,
  height: 400,
  src: 'blob:logo',
}

const INACTIVE_ASSET: OverlayAsset = {
  id: 'late-asset',
  kind: 'image',
  name: 'late.png',
  mimeType: 'image/png',
  width: 400,
  height: 400,
  src: 'blob:late',
}

const ACTIVE_OVERLAY: ImageOverlay = {
  id: 'active-overlay',
  assetId: ACTIVE_ASSET.id,
  startSourceMs: 1_000,
  endSourceMs: 5_000,
  x: 0.1,
  y: 0.2,
  width: 0.4,
  height: 0.3,
  fit: 'contain',
  opacity: 0.8,
  zIndex: 0,
  fadeInMs: 1_000,
  fadeOutMs: 1_000,
}

const INACTIVE_OVERLAY: ImageOverlay = {
  ...ACTIVE_OVERLAY,
  id: 'inactive-overlay',
  assetId: INACTIVE_ASSET.id,
  startSourceMs: 6_000,
  endSourceMs: 8_000,
  fadeInMs: 0,
  fadeOutMs: 0,
}

describe('OverlayStage rendering', () => {
  it('renders computed fade opacity below captions and omits inactive overlays', () => {
    const markup = renderToStaticMarkup(
      <div>
        <OverlayStage
          assets={[ACTIVE_ASSET, INACTIVE_ASSET]}
          overlays={[ACTIVE_OVERLAY, INACTIVE_OVERLAY]}
          currentSourceMs={1_500}
          selectedOverlayId={null}
          isEditing={false}
          onSelectOverlay={vi.fn()}
          onClearSelection={vi.fn()}
          onCommitGeometry={vi.fn()}
          onRemoveOverlay={vi.fn()}
          onBeginTransform={vi.fn()}
        />
        <CaptionOverlay
          captions={[
            {
              id: 'caption',
              text: 'Caption above image',
              start: 1,
              end: 2,
            },
          ]}
          currentTime={1.5}
        />
      </div>,
    )

    // At 500 ms into a 1 s fade-in, base opacity 0.8 becomes 0.4.
    expect(markup).toContain('opacity:0.4')
    expect(markup).toContain('src="blob:logo"')
    expect(markup).not.toContain('src="blob:late"')

    // The fixed overlay stacking context remains below the caption layer.
    expect(markup).toMatch(/aria-hidden="true" style="[^"]*z-index:1/)
    expect(markup).toMatch(/bottom:9%;z-index:2/)
    expect(markup).toContain('Caption above image')
  })
})
