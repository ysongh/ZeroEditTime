// The Phase-5 export UI: a single Export button that loads the ffmpeg engine if
// needed, re-encodes the kept segments into one MP4 with a progress indicator,
// then downloads the file. Export READS edl.segments and mutates nothing — the
// EDL stays the single source of truth.
//
// The button lives in the editor header. Its export-time inputs are owned by
// App so they can be edited in other panels: the Phase-8 burn toggle (Captions
// tab; off exports a clean video for the sidecar-SRT workflow) and the Phase-10
// audio-cleanup settings (Audio tab). Both are snapshotted when an export
// starts. Phase 9A Part J projects current image overlays through the EDL and
// hands that data to the non-React export layer for compositing.

import { useState } from 'react'
import type { EDL } from '../edl/types'
import type { ImageOverlay, OverlayAsset } from '../overlays/types'
import { prepareCaptionsForExport } from '../captions/captions'
import { getFfmpeg, loadFfmpeg } from '../ffmpeg/engine'
import Icon from '../ui/Icon'
import { buildImageOverlayRenderPlanForEdl } from './imageOverlays'
import { runExport } from './ffmpeg'
import type { AudioCleanupSettings } from './audioCleanupSettings'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { downloadBlob } from './download'

type ExportButtonProps = {
  edl: EDL
  file: File | null
  overlayAssets: readonly OverlayAsset[]
  imageOverlays: readonly ImageOverlay[]
  audioCleanupSettings: Readonly<AudioCleanupSettings>
  /** Burn the prepared captions into the video (Phase 8 default: on). */
  burnCaptions: boolean
  /** Told when export work starts and ends, so App can lock export settings. */
  onBusyChange?: (busy: boolean) => void
}

// idle → loading (first-time ~31 MB engine fetch) → encoding (progress 0–1).
type Phase = 'idle' | 'loading' | 'encoding'

export default function ExportButton({
  edl,
  file,
  overlayAssets,
  imageOverlays,
  audioCleanupSettings,
  burnCaptions,
  onBusyChange,
}: ExportButtonProps) {
  // The ffmpeg engine is the single shared instance from `../ffmpeg/engine`
  // (loaded at most once per session, shared with audio extraction); we only
  // hold UI state here. `loadFfmpeg` is itself idempotent.
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const hasSegments = edl.segments.length > 0
  const canExport = file !== null && hasSegments && phase === 'idle'

  async function handleExport(): Promise<void> {
    if (file === null || !hasSegments || phase !== 'idle') {
      return
    }
    setError(null)
    setNotice(null)
    onBusyChange?.(true)

    try {
      // Snapshot every export input at the click: later edits cannot leak
      // into an encode that is already running.
      const audioCleanupPlan = buildAudioCleanupPlan(audioCleanupSettings)
      // Output-time captions against the CURRENT EDL; an empty list takes the
      // Phase 5.5-identical no-srtFile path in the export layer.
      const captionsToBurn = burnCaptions
        ? prepareCaptionsForExport(edl.captions, edl)
        : []
      // Source-authored overlays are projected through the CURRENT EDL here,
      // but FFmpeg-specific graph construction stays in the export module.
      const imageOverlayPlan = buildImageOverlayRenderPlanForEdl(
        edl,
        imageOverlays,
        overlayAssets,
      )
      let ffmpeg: ReturnType<typeof getFfmpeg>
      try {
        ffmpeg = getFfmpeg()
      } catch (error) {
        throw new Error(
          'Could not start the export engine. Reload the page and try again.',
          { cause: error },
        )
      }

      if (!ffmpeg.loaded) {
        setPhase('loading')
        try {
          await loadFfmpeg()
        } catch (error) {
          throw new Error(
            'Could not load the export engine. Check your connection and try again.',
            { cause: error },
          )
        }
      }

      setProgress(0)
      setPhase('encoding')
      const onProgress = ({ progress }: { progress: number }): void => {
        setProgress(Math.max(0, Math.min(1, progress)))
      }
      ffmpeg.on('progress', onProgress)
      try {
        const overlayExport =
          imageOverlayPlan.length === 0
            ? undefined
            : {
                renderPlan: imageOverlayPlan,
                assets: overlayAssets,
                frameWidth: edl.source.width ?? Number.NaN,
                frameHeight: edl.source.height ?? Number.NaN,
              }
        // A resolved Blob plus onNote is a degraded success, kept visually
        // distinct from a rejected export's fatal error.
        const blob = await runExport(
          ffmpeg,
          file,
          edl.segments,
          captionsToBurn,
          (note) => setNotice(note),
          overlayExport,
          audioCleanupPlan,
        )
        try {
          downloadBlob(blob, 'zero-edit-time.mp4')
        } catch (error) {
          throw new Error(
            'The video was exported, but the download could not start. Try again.',
            { cause: error },
          )
        }
      } finally {
        ffmpeg.off('progress', onProgress)
      }
    } catch (err) {
      console.error('Export failed:', err)
      // A fatal failure means no usable download was delivered, even if a
      // prior encode attempt had already reported a recoverable fallback.
      setNotice(null)
      setError(
        err instanceof Error
          ? err.message
          : 'Export failed. Reload the page and try again.',
      )
    } finally {
      setPhase('idle')
      setProgress(0)
      onBusyChange?.(false)
    }
  }

  function dismissMessages(): void {
    setError(null)
    setNotice(null)
  }

  const percent = Math.round(progress * 100)
  const showPopover =
    phase === 'loading' || !hasSegments || notice !== null || error !== null

  return (
    <>
      <button
        type="button"
        className="btn btn--primary export-btn"
        onClick={() => void handleExport()}
        disabled={!canExport}
      >
        {phase === 'loading' ? (
          'Loading engine…'
        ) : phase === 'encoding' ? (
          `Exporting ${percent}%`
        ) : (
          <>
            Export MP4
            <Icon name="chevron-right" />
          </>
        )}
      </button>

      {phase !== 'idle' && (
        <div
          className="export-progress"
          style={{ width: phase === 'encoding' ? `${percent}%` : '4%' }}
          aria-hidden="true"
        />
      )}

      {showPopover && (
        <div className="export-popover">
          <div className="export-popover__body">
            {!hasSegments && (
              <p className="error-text">
                Nothing to export — every segment has been cut.
              </p>
            )}
            {phase === 'loading' && (
              <p className="muted">
                Loading the export engine (~31 MB, first time only)…
              </p>
            )}
            {notice !== null && (
              <p role="status" className="notice-text">
                {notice}
              </p>
            )}
            {error !== null && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
          </div>
          {(notice !== null || error !== null) && (
            <button
              type="button"
              className="icon-btn export-popover__close"
              aria-label="Dismiss export message"
              onClick={dismissMessages}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
    </>
  )
}
