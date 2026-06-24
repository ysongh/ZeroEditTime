// The Phase-5 export UI: a single Export button that loads the ffmpeg engine if
// needed, re-encodes the kept segments into one MP4 with a progress indicator,
// then downloads the file. Export READS edl.segments and mutates nothing — the
// EDL stays the single source of truth.

import { useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import type { EDL } from '../edl/types'
import { loadFfmpeg, runExport } from './ffmpeg'

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
  // One FFmpeg instance for the component's life, created lazily so StrictMode's
  // double render doesn't build two; `loadFfmpeg` is itself idempotent.
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  function getFfmpeg(): FFmpeg {
    if (ffmpegRef.current === null) {
      ffmpegRef.current = new FFmpeg()
    }
    return ffmpegRef.current
  }

  const hasSegments = edl.segments.length > 0
  const canExport = file !== null && hasSegments && phase === 'idle'

  async function handleExport(): Promise<void> {
    if (file === null || !hasSegments || phase !== 'idle') {
      return
    }
    setError(null)
    const ffmpeg = getFfmpeg()

    try {
      if (!ffmpeg.loaded) {
        setPhase('loading')
        await loadFfmpeg(ffmpeg)
      }

      setProgress(0)
      setPhase('encoding')
      const onProgress = ({ progress }: { progress: number }): void => {
        setProgress(Math.max(0, Math.min(1, progress)))
      }
      ffmpeg.on('progress', onProgress)
      try {
        const blob = await runExport(ffmpeg, file, edl.segments)
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
