// Phase-8 caption export choices, shown in the Captions tab. Burning is opt-out:
// on (default) burns the captions into the video; off exports a clean video for
// the video-plus-sidecar-SRT workflow. "Download SRT" serializes the same
// prepared OUTPUT-time captions the burn would use, so the .srt always lines up
// with the exported .mp4.

import type { ChangeEvent } from 'react'
import type { EDL } from '../edl/types'
import { buildSrt, prepareCaptionsForExport } from '../captions/captions'
import { downloadBlob } from './download'

type CaptionExportControlsProps = {
  edl: EDL
  burnCaptions: boolean
  onBurnCaptionsChange: (burn: boolean) => void
}

export default function CaptionExportControls({
  edl,
  burnCaptions,
  onBurnCaptionsChange,
}: CaptionExportControlsProps) {
  if (edl.captions.length === 0) {
    return null
  }

  // Output-time captions against the CURRENT EDL — a cheap pure derivation, so
  // Download SRT disables as soon as every caption's speech has been cut.
  const prepared = prepareCaptionsForExport(edl.captions, edl)

  function handleBurnChange(event: ChangeEvent<HTMLInputElement>): void {
    onBurnCaptionsChange(event.target.checked)
  }

  // Upload the pair to YouTube/LinkedIn as video + closed captions.
  function handleDownloadSrt(): void {
    if (prepared.length === 0) {
      return
    }
    downloadBlob(
      new Blob([buildSrt(prepared)], { type: 'text/plain' }),
      'zero-edit-time.srt',
    )
  }

  return (
    <div>
      <div className="setting-row">
        <label className="setting-row__text" htmlFor="caption-burn">
          <span className="setting-row__title">Burn captions into video</span>
          <span className="setting-row__hint">
            Also shows them on the preview
          </span>
        </label>
        <input
          id="caption-burn"
          className="switch"
          type="checkbox"
          role="switch"
          checked={burnCaptions}
          onChange={handleBurnChange}
        />
      </div>
      <div className="setting-row">
        <div className="setting-row__text">
          <span className="setting-row__title">Subtitle file</span>
          <span className="setting-row__hint">
            Timed to the exported MP4
          </span>
        </div>
        <button
          type="button"
          className="btn btn--outline"
          onClick={handleDownloadSrt}
          disabled={prepared.length === 0}
        >
          Download SRT
        </button>
      </div>
      {prepared.length === 0 && (
        <p className="panel-note">
          Every caption&apos;s speech has been cut — nothing to burn or
          download.
        </p>
      )}
    </div>
  )
}
