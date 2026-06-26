import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'
import Timeline from './Timeline'
import TranscriptView from './transcript/Transcript'
import AgentBar from './agent/AgentBar'
import ExportButton from './export/ExportButton'
import { transcribe } from './transcript/api'
import { extractAudio } from './transcript/extractAudio'
import type { EDL } from './edl/types'
import type { Transcript } from './transcript/types'
import {
  applyRemovedRange,
  createEdl,
  nextSourceTime,
  splitSegmentAt,
  totalKeptDuration,
} from './edl/edl'

function fmt(seconds: number): string {
  return seconds.toFixed(2)
}

function App() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [edl, setEdl] = useState<EDL | null>(null)
  const [history, setHistory] = useState<EDL[]>([])
  const [playhead, setPlayhead] = useState(0)
  const [inPoint, setInPoint] = useState<number | null>(null)
  const [outPoint, setOutPoint] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  // The Transcribe action runs in two visible phases: 'preparing' extracts the
  // audio client-side (engine load + ffmpeg.wasm), then 'transcribing' uploads it.
  const [transcribePhase, setTranscribePhase] =
    useState<'idle' | 'preparing' | 'transcribing'>('idle')
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Revoke the last object URL when it changes or on unmount, to avoid leaks.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [])

  function clearSelection() {
    setInPoint(null)
    setOutPoint(null)
  }

  // The one entry point for every EDL mutation — timeline ops AND (Phase 3)
  // transcript deletes all funnel through here. It pushes the current EDL onto
  // the history before applying the next, so a single `undo` restores the
  // preview, the timeline, and the struck-through words together (all derived
  // from the one EDL). A no-op (`applyRemovedRange`/`splitSegmentAt` returning
  // the same EDL) is not recorded.
  function commitEdl(next: EDL) {
    if (edl === null || next === edl) {
      return
    }
    setHistory((past) => [...past, edl])
    setEdl(next)
  }

  function undo() {
    if (history.length === 0) {
      return
    }
    setEdl(history[history.length - 1])
    setHistory((past) => past.slice(0, -1))
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    if (selected === undefined) {
      return
    }

    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
    }

    const url = URL.createObjectURL(selected)
    objectUrlRef.current = url
    setFile(selected)
    setVideoUrl(url)
    setEdl(null)
    setHistory([])
    setPlayhead(0)
    setTranscript(null)
    setTranscribeError(null)
    clearSelection()
  }

  // Initialize the EDL from the loaded source as a single full-length segment.
  function handleLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    setEdl(
      createEdl({
        id: crypto.randomUUID(),
        url: videoUrl ?? video.currentSrc,
        duration: video.duration,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      }),
    )
  }

  // EDL-driven playback: the <video> plays in source time; on each timeupdate we
  // skip from the end of one kept segment to the start of the next, and stop
  // after the last kept segment. We only steer during playback so the user can
  // still scrub freely while paused. `nextSourceTime` encodes the skip rule.
  function handleTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    const t = video.currentTime

    if (edl === null || video.paused) {
      setPlayhead(t)
      return
    }

    const next = nextSourceTime(edl, t)
    if (next === null) {
      video.pause()
      setPlayhead(t)
      return
    }
    if (next > t + 1e-3) {
      video.currentTime = next
      setPlayhead(next)
      return
    }
    setPlayhead(t)
  }

  // On play, jump into a kept range: restart from the first segment if we're
  // past the end, or skip forward if we're sitting inside a removed gap.
  function handlePlay(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    if (edl === null || edl.segments.length === 0) {
      return
    }
    const next = nextSourceTime(edl, video.currentTime)
    if (next === null) {
      const start = edl.segments[0].start
      video.currentTime = start
      setPlayhead(start)
    } else if (next > video.currentTime + 1e-3) {
      video.currentTime = next
      setPlayhead(next)
    }
  }

  function handleSeek(sourceTime: number) {
    if (videoRef.current !== null) {
      videoRef.current.currentTime = sourceTime
    }
    setPlayhead(sourceTime)
  }

  async function handleTranscribe() {
    if (file === null || transcribePhase !== 'idle') {
      return
    }
    setTranscribeError(null)
    try {
      // Extract a tiny mono 16 kHz audio file client-side first, so a real clip
      // clears the proxy's body wall; only then upload it for transcription.
      setTranscribePhase('preparing')
      const audio = await extractAudio(file)
      setTranscribePhase('transcribing')
      setTranscript(await transcribe(audio))
    } catch (err) {
      setTranscribeError(
        err instanceof Error ? err.message : 'Transcription failed.',
      )
    } finally {
      setTranscribePhase('idle')
    }
  }

  const hasSelection =
    inPoint !== null && outPoint !== null && inPoint !== outPoint

  function deleteSelection() {
    if (edl === null || inPoint === null || outPoint === null) {
      return
    }
    const start = Math.min(inPoint, outPoint)
    const end = Math.max(inPoint, outPoint)
    commitEdl(applyRemovedRange(edl, start, end))
    clearSelection()
  }

  function trimToSelection() {
    if (edl === null || inPoint === null || outPoint === null) {
      return
    }
    const start = Math.min(inPoint, outPoint)
    const end = Math.max(inPoint, outPoint)
    // Keep only [start, end]: remove the head and the tail around it.
    const trimmed = applyRemovedRange(
      applyRemovedRange(edl, 0, start),
      end,
      edl.source.duration,
    )
    commitEdl(trimmed)
    clearSelection()
  }

  // Transcript-delete entry point: a selected word/sentence span arrives as a
  // source range and removes it from the EDL via the same primitive as timeline
  // edits. We refuse a delete that would leave nothing kept, so the preview
  // never goes empty (recovery from any other delete is via Undo).
  function deleteSourceRange(start: number, end: number) {
    if (edl === null) {
      return
    }
    const next = applyRemovedRange(edl, start, end)
    if (next.segments.length === 0) {
      return
    }
    commitEdl(next)
  }

  function splitAtPlayhead() {
    if (edl === null) {
      return
    }
    commitEdl(splitSegmentAt(edl, playhead))
  }

  function resetEdl() {
    if (edl === null) {
      return
    }
    commitEdl(createEdl(edl.source))
    clearSelection()
  }

  return (
    <>
      <h1>ZeroEditTime</h1>

      <input type="file" accept="video/*" onChange={handleFileChange} />

      {videoUrl !== null && (
        <div style={{ marginTop: 16 }}>
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handlePlay}
            style={{ maxWidth: '100%', maxHeight: '60vh' }}
          />

          {edl !== null && (
            <div style={{ marginTop: 16, padding: '0 16px' }}>
              <Timeline
                edl={edl}
                playhead={playhead}
                inPoint={inPoint}
                outPoint={outPoint}
                onSeek={handleSeek}
              />

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  justifyContent: 'center',
                  marginTop: 12,
                }}
              >
                <button type="button" onClick={() => setInPoint(playhead)}>
                  Set In
                </button>
                <button type="button" onClick={() => setOutPoint(playhead)}>
                  Set Out
                </button>
                <button type="button" onClick={deleteSelection} disabled={!hasSelection}>
                  Delete range
                </button>
                <button type="button" onClick={trimToSelection} disabled={!hasSelection}>
                  Trim to selection
                </button>
                <button type="button" onClick={splitAtPlayhead}>
                  Split at playhead
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={inPoint === null && outPoint === null}
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  onClick={undo}
                  disabled={history.length === 0}
                >
                  Undo
                </button>
                <button type="button" onClick={resetEdl}>
                  Reset
                </button>
              </div>

              <div style={{ marginTop: 12, fontSize: 15 }}>
                <p>
                  In: {inPoint === null ? '—' : `${fmt(inPoint)}s`} · Out:{' '}
                  {outPoint === null ? '—' : `${fmt(outPoint)}s`} · Playhead:{' '}
                  {fmt(playhead)}s
                </p>
                <p>
                  Source: {fmt(edl.source.duration)}s · Kept:{' '}
                  {fmt(totalKeptDuration(edl))}s · {edl.segments.length} segment
                  {edl.segments.length === 1 ? '' : 's'}
                </p>
                <ol
                  style={{
                    textAlign: 'left',
                    display: 'inline-block',
                    margin: '8px 0 0',
                    paddingLeft: 20,
                  }}
                >
                  {edl.segments.map((seg) => (
                    <li key={seg.id}>
                      {fmt(seg.start)}s – {fmt(seg.end)}s
                    </li>
                  ))}
                </ol>
              </div>

              <div style={{ marginTop: 16 }}>
                <ExportButton edl={edl} file={file} />
              </div>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              onClick={handleTranscribe}
              disabled={file === null || transcribePhase !== 'idle'}
            >
              {transcribePhase === 'preparing'
                ? 'Preparing audio…'
                : transcribePhase === 'transcribing'
                  ? 'Transcribing…'
                  : 'Transcribe'}
            </button>

            {transcribeError !== null && (
              <p style={{ color: 'crimson', marginTop: 8 }}>{transcribeError}</p>
            )}

            {transcript !== null && edl !== null && (
              <>
                <AgentBar
                  edl={edl}
                  transcript={transcript}
                  onCommit={commitEdl}
                />
                <TranscriptView
                  transcript={transcript}
                  edl={edl}
                  currentTime={playhead}
                  onSeek={handleSeek}
                  onDeleteRange={deleteSourceRange}
                />
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default App
