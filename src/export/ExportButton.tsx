// The Phase-5 export UI: a single Export button that loads the ffmpeg engine if
// needed, re-encodes the kept segments into one MP4 with a progress indicator,
// then downloads the file. Export READS edl.segments and mutates nothing — the
// EDL stays the single source of truth.
//
// Phase 8 adds the caption controls: a "Burn captions into video" toggle
// (default on; off exports a clean video for the sidecar-SRT workflow) and a
// "Download SRT" button that serializes the same prepared output-time captions
// the burn would use — so the .srt always lines up with the exported .mp4.

import { useState } from 'react'
import type { ChangeEvent } from 'react'
import type { EDL } from '../edl/types'
import { buildSrt, prepareCaptionsForExport } from '../captions/captions'
import { getFfmpeg, loadFfmpeg } from '../ffmpeg/engine'
import { runExport } from './ffmpeg'

type ExportButtonProps = {
  edl: EDL
  file: File | null
}

// idle → loading (first-time ~31 MB engine fetch) → encoding (progress 0–1).
type Phase = 'idle' | 'loading' | 'encoding'

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export default function ExportButton({ edl, file }: ExportButtonProps) {
  // The ffmpeg engine is the single shared instance from `../ffmpeg/engine`
  // (loaded at most once per session, shared with audio extraction); we only
  // hold UI state here. `loadFfmpeg` is itself idempotent.
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Phase 8: burning is opt-out. Checked (default) burns the captions into the
  // video as before; unchecked exports a clean video (the no-srtFile graph,
  // byte-identical to Phase 5.5) for the video-plus-sidecar-SRT workflow.
  const [burnCaptions, setBurnCaptions] = useState(true)

  const hasSegments = edl.segments.length > 0
  const canExport = file !== null && hasSegments && phase === 'idle'

  // Output-time captions against the CURRENT EDL — a cheap pure derivation,
  // recomputed per render so both the export and the SRT download always match
  // the latest edit, and so Download SRT can disable when every caption was cut.
  const hasCaptions = edl.captions.length > 0
  const prepared = prepareCaptionsForExport(edl.captions, edl)

  function handleBurnChange(event: ChangeEvent<HTMLInputElement>): void {
    setBurnCaptions(event.target.checked)
  }

  // The SRT is in OUTPUT time by construction, so it lines up with the exported
  // MP4 — upload the pair to YouTube/LinkedIn as video + closed captions.
  function handleDownloadSrt(): void {
    if (prepared.length === 0) {
      return
    }
    downloadBlob(
      new Blob([buildSrt(prepared)], { type: 'text/plain' }),
      'zero-edit-time.srt',
    )
  }

  async function handleExport(): Promise<void> {
    if (file === null || !hasSegments || phase !== 'idle') {
      return
    }
    setError(null)
    const ffmpeg = getFfmpeg()

    try {
      if (!ffmpeg.loaded) {
        setPhase('loading')
        await loadFfmpeg()
      }

      setProgress(0)
      setPhase('encoding')
      const onProgress = ({ progress }: { progress: number }): void => {
        setProgress(Math.max(0, Math.min(1, progress)))
      }
      ffmpeg.on('progress', onProgress)
      try {
        // Burn the prepared (output-time, current-EDL) captions unless the
        // toggle opted out: no prepared captions → runExport stages no font/SRT
        // and buildExportArgs takes the Phase 5.5-identical no-srtFile path.
        const captionsToBurn = burnCaptions ? prepared : []
        // A loudnorm-fallback note (non-fatal) surfaces via the same error line.
        const blob = await runExport(
          ffmpeg,
          file,
          edl.segments,
          captionsToBurn,
          (note) => setError(note),
        )
        downloadBlob(blob, 'zero-edit-time.mp4')
      } finally {
        ffmpeg.off('progress', onProgress)
      }
    } catch (err) {
      console.error('Export failed:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhase('idle')
      setProgress(0)
    }
  }

  const label =
    phase === 'loading'
      ? 'Loading engine…'
      : phase === 'encoding'
        ? `Exporting… ${Math.round(progress * 100)}%`
        : 'Export MP4'

  return (
    <div style={{ marginTop: 16, textAlign: 'center' }}>
      <button type="button" onClick={() => void handleExport()} disabled={!canExport}>
        {label}
      </button>

      {hasCaptions && (
        <div style={{ marginTop: 8, fontSize: 14 }}>
          <label style={{ marginRight: 12 }}>
            <input
              type="checkbox"
              checked={burnCaptions}
              onChange={handleBurnChange}
            />{' '}
            Burn captions into video
          </label>
          <button
            type="button"
            onClick={handleDownloadSrt}
            disabled={prepared.length === 0}
          >
            Download SRT
          </button>
          {prepared.length === 0 && (
            <p style={{ marginTop: 4, fontSize: 13, color: '#666' }}>
              Every caption&apos;s speech has been cut — nothing to burn or
              download.
            </p>
          )}
        </div>
      )}

      {!hasSegments && (
        <p style={{ color: 'crimson', marginTop: 8, fontSize: 14 }}>
          Nothing to export — every segment has been cut.
        </p>
      )}

      {phase === 'loading' && (
        <p style={{ marginTop: 8, fontSize: 14, color: '#666' }}>
          Loading the export engine (~31 MB, first time only)…
        </p>
      )}

      {phase === 'encoding' && (
        <div style={{ marginTop: 8 }}>
          <progress value={progress} max={1} style={{ width: 280 }} />
        </div>
      )}

      {error !== null && (
        <p style={{ color: 'crimson', marginTop: 8, fontSize: 14 }}>{error}</p>
      )}
    </div>
  )
}
