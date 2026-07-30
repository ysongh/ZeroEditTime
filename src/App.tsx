import { useEffect, useReducer, useRef, useState } from 'react'
import type { ChangeEvent, SyntheticEvent } from 'react'
import Timeline from './Timeline'
import TranscriptView from './transcript/Transcript'
import AgentBar from './agent/AgentBar'
import ExportButton from './export/ExportButton'
import CaptionOverlay from './captions/CaptionOverlay'
import CaptionList from './captions/CaptionList'
import MediaPanel from './overlays/MediaPanel'
import { buildCaptions, updateCaptionText } from './captions/captions'
import { transcribe } from './transcript/api'
import { extractAudio } from './transcript/extractAudio'
import { loadFfmpeg } from './ffmpeg/engine'
import type { EDL } from './edl/types'
import type { Transcript } from './transcript/types'
import type { ImageOverlay, OverlayAsset } from './overlays/types'
import {
  collectOverlayObjectUrls,
  createOverlayEditorState,
  overlayEditorReducer,
  type OverlayEditorAction,
  type OverlayEditorState,
} from './overlays/editorState'
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

type EditorSnapshot = {
  edl: EDL | null
  overlayAssets: OverlayAsset[]
  imageOverlays: ImageOverlay[]
}

type EditorState = {
  edl: EDL | null
  overlays: OverlayEditorState
  history: EditorSnapshot[]
}

type EditorAction =
  | { type: 'replace-edl'; edl: EDL }
  | { type: 'commit-edl'; edl: EDL }
  | { type: 'commit-overlays'; action: OverlayEditorAction }
  | { type: 'undo' }
  | { type: 'reset-document' }

function createEditorState(): EditorState {
  return {
    edl: null,
    overlays: createOverlayEditorState(),
    history: [],
  }
}

function snapshotEditor(state: EditorState): EditorSnapshot {
  return {
    edl: state.edl,
    overlayAssets: state.overlays.overlayAssets,
    imageOverlays: state.overlays.imageOverlays,
  }
}

/**
 * One atomic state machine for EDL + persistent overlay content. React dispatch
 * always reduces against the latest state, so an async EDL-only agent commit
 * cannot restore overlay arrays captured before the request started.
 */
function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'replace-edl':
      return { ...state, edl: action.edl }
    case 'commit-edl':
      if (action.edl === state.edl) {
        return state
      }
      return {
        ...state,
        edl: action.edl,
        history: [...state.history, snapshotEditor(state)],
      }
    case 'commit-overlays': {
      const overlays = overlayEditorReducer(state.overlays, action.action)
      const contentChanged =
        overlays.overlayAssets !== state.overlays.overlayAssets ||
        overlays.imageOverlays !== state.overlays.imageOverlays
      const selectionChanged =
        overlays.selectedOverlayId !== state.overlays.selectedOverlayId
      if (!contentChanged) {
        return selectionChanged ? { ...state, overlays } : state
      }
      return {
        ...state,
        overlays,
        history: [...state.history, snapshotEditor(state)],
      }
    }
    case 'undo': {
      const previous = state.history.at(-1)
      if (previous === undefined) {
        return state
      }
      const selectedOverlayId =
        state.overlays.selectedOverlayId !== null &&
        previous.imageOverlays.some(
          (overlay) => overlay.id === state.overlays.selectedOverlayId,
        )
          ? state.overlays.selectedOverlayId
          : null
      return {
        edl: previous.edl,
        overlays: {
          overlayAssets: previous.overlayAssets,
          imageOverlays: previous.imageOverlays,
          selectedOverlayId,
        },
        history: state.history.slice(0, -1),
      }
    }
    case 'reset-document':
      return createEditorState()
  }
}

function App() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [editor, dispatchEditor] = useReducer(
    editorReducer,
    undefined,
    createEditorState,
  )
  const { edl, overlays: overlayEditor, history } = editor
  // One history for all persistent editor content. Selection stays ephemeral,
  // but every snapshot captures EDL + overlay assets/layers so Undo follows the
  // user's actual cross-feature edit order instead of creating a second stack.
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
  // Tracks whether captions carry hand edits since the last generation, so the
  // manual "Generate captions" button can warn before overwriting them. It lives
  // in React state (not the EDL — the Caption type is untouched): set when an
  // inline edit commits, cleared whenever generate_captions output is committed.
  const [captionsEdited, setCaptionsEdited] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const overlayObjectUrlsRef = useRef<Set<string>>(new Set())
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Revoke the video URL and every still-image object URL on disposal.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
      for (const url of overlayObjectUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
    }
  }, [])

  // An image URL remains live while reachable from current editor content OR
  // an Undo snapshot. This lets asset removal stay undoable and prevents early
  // revocation when two assets share one URL. A URL is revoked as soon as it
  // becomes unreachable (undoing its addition, clearing history, or replacing
  // the source document).
  useEffect(() => {
    const reachable = collectOverlayObjectUrls([
      overlayEditor.overlayAssets,
      ...history.map((snapshot) => snapshot.overlayAssets),
    ])
    for (const url of overlayObjectUrlsRef.current) {
      if (!reachable.has(url)) {
        URL.revokeObjectURL(url)
      }
    }
    overlayObjectUrlsRef.current = reachable
  }, [overlayEditor.overlayAssets, history])

  function clearSelection() {
    setInPoint(null)
    setOutPoint(null)
  }

  // The one entry point for every EDL mutation — timeline ops, transcript
  // deletes, caption edits, and agent runs all still funnel through here. The
  // reducer snapshots the latest overlay content atomically.
  function commitEdl(next: EDL) {
    if (edl === null) {
      return
    }
    dispatchEditor({ type: 'commit-edl', edl: next })
  }

  function undo() {
    dispatchEditor({ type: 'undo' })
  }

  function addOverlayAsset(asset: OverlayAsset) {
    // Register synchronously so an immediate unmount still sees and revokes the
    // newly-created URL before the state-driven reachability effect runs.
    if (asset.src.startsWith('blob:')) {
      overlayObjectUrlsRef.current.add(asset.src)
    }
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'add-overlay-asset', asset },
    })
  }

  function addImageOverlay(overlay: ImageOverlay) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'add-image-overlay', overlay },
    })
    // Selection is ephemeral, so this queued action does not add a second Undo
    // entry; the reducer applies it after the content action above.
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'select-image-overlay', id: overlay.id },
    })
  }

  function removeOverlayAsset(assetId: string) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'remove-overlay-asset', assetId },
    })
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
    dispatchEditor({ type: 'reset-document' })
    setPlayhead(0)
    setTranscript(null)
    setTranscribeError(null)
    setCaptionsEdited(false)
    clearSelection()

    // Warm the ~31 MB ffmpeg.wasm core in the background while the user reviews the
    // video, so Transcribe/Export are likely ready by the time they click. Strictly
    // fire-and-forget: the awaited loadFfmpeg in extraction/export is the real guard,
    // so a preload failure here must never surface or break the UI.
    void loadFfmpeg().catch(() => {})
  }

  // Initialize the EDL from the loaded source as a single full-length segment.
  function handleLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget
    dispatchEditor({
      type: 'replace-edl',
      edl: createEdl({
        id: crypto.randomUUID(),
        url: videoUrl ?? video.currentSrc,
        duration: video.duration,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      }),
    })
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

  // Build captions from the CURRENT transcript + EDL and commit them like any
  // other edit: one history entry, so Undo removes them and regenerating after
  // more cuts replaces the old set (buildCaptions only reads kept words).
  // Regeneration REPLACES any hand-edited text, so warn first when edits exist;
  // committing fresh captions clears the edited flag.
  function generateCaptions() {
    if (edl === null || transcript === null) {
      return
    }
    if (
      captionsEdited &&
      !window.confirm(
        'Regenerating will replace your hand-edited captions. Continue?',
      )
    ) {
      return
    }
    commitEdl({ ...edl, captions: buildCaptions(transcript, edl) })
    setCaptionsEdited(false)
  }

  // Inline caption-text edit (Phase 8). `updateCaptionText` returns the SAME EDL
  // for a no-op (unknown id / empty / unchanged), which `commitEdl` also skips,
  // so nothing commits and no undo entry appears; a real change commits once and
  // marks the captions hand-edited (so a later regenerate warns first).
  function editCaptionText(id: string, text: string) {
    if (edl === null) {
      return
    }
    const next = updateCaptionText(edl, id, text)
    if (next === edl) {
      return
    }
    commitEdl(next)
    setCaptionsEdited(true)
  }

  // Agent commits run through here so a run that regenerated captions clears the
  // hand-edited flag (matching the manual button); other runs leave it as-is
  // (cuts preserve caption text, so hand edits survive).
  function handleAgentCommit(next: EDL, regeneratedCaptions: boolean) {
    commitEdl(next)
    if (regeneratedCaptions) {
      setCaptionsEdited(false)
    }
  }

  return (
    <>
      <h1>ZeroEditTime</h1>

      <input type="file" accept="video/*" onChange={handleFileChange} />

      {videoUrl !== null && (
        <div style={{ marginTop: 16 }}>
          {/* inline-block keeps the wrapper shrink-wrapped to the video (so it
              stays centered and the overlay aligns with the frame's edges);
              display:block on the video drops the inline descender gap that
              would otherwise offset the overlay's bottom. */}
          <div
            style={{
              position: 'relative',
              display: 'inline-block',
              maxWidth: '100%',
            }}
          >
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPlay={handlePlay}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh' }}
            />
            {edl !== null && (
              <CaptionOverlay captions={edl.captions} currentTime={playhead} />
            )}
          </div>

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

              <MediaPanel
                key={edl.source.id}
                assets={overlayEditor.overlayAssets}
                overlays={overlayEditor.imageOverlays}
                currentSourceMs={playhead * 1000}
                sourceDurationMs={edl.source.duration * 1000}
                videoWidth={edl.source.width}
                videoHeight={edl.source.height}
                onAddAsset={addOverlayAsset}
                onAddOverlay={addImageOverlay}
                onRemoveAsset={removeOverlayAsset}
              />

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
                  onCommit={handleAgentCommit}
                />
                <div style={{ marginTop: 12 }}>
                  <button type="button" onClick={generateCaptions}>
                    Generate captions
                  </button>
                  {edl.captions.length > 0 && (
                    <span style={{ marginLeft: 8, fontSize: 14, color: '#666' }}>
                      {edl.captions.length} caption
                      {edl.captions.length === 1 ? '' : 's'} — previewed over the
                      video, burned into the export
                    </span>
                  )}
                </div>
                {edl.captions.length > 0 && (
                  <CaptionList
                    captions={edl.captions}
                    currentTime={playhead}
                    onSeek={handleSeek}
                    onEditText={editCaptionText}
                  />
                )}
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
