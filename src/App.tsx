import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  SyntheticEvent,
} from 'react'
import Timeline from './Timeline'
import TranscriptView from './transcript/Transcript'
import AgentBar from './agent/AgentBar'
import ExportButton from './export/ExportButton'
import AudioCleanupControls from './export/AudioCleanupControls'
import CaptionExportControls from './export/CaptionExportControls'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  type AudioCleanupSettings,
} from './export/audioCleanupSettings'
import CaptionOverlay from './captions/CaptionOverlay'
import CaptionList from './captions/CaptionList'
import MediaPanel from './overlays/MediaPanel'
import OverlayInspector from './overlays/OverlayInspector'
import OverlayStage from './overlays/OverlayStage'
import OverlayTimelineTrack from './overlays/OverlayTimelineTrack'
import RetakesPanel, {
  type RetakeScriptCopyFeedback,
} from './retakes/RetakesPanel'
import RetakeTimelineTrack from './retakes/RetakeTimelineTrack'
import Icon from './ui/Icon'
import IconBadge from './ui/IconBadge'
import { formatClock, formatSeconds } from './ui/time'
import { editorShortcutFor, type EditorShortcut } from './editorShortcuts'
import { buildCaptions, updateCaptionText } from './captions/captions'
import { transcribe } from './transcript/api'
import { extractAudio } from './transcript/extractAudio'
import { loadFfmpeg } from './ffmpeg/engine'
import { analyzeRetakes } from './retakes/batchAnalysis'
import { removeStaleRetakeRecommendations } from './retakes/freshness'
import type { EDL } from './edl/types'
import type { Transcript } from './transcript/types'
import type { ImageOverlay, OverlayAsset } from './overlays/types'
import {
  createRetakeEditorState,
  retakeEditorReducer,
  type RetakeAnalysisProgress,
  type RetakeEditorAction,
  type RetakeEditorState,
} from './retakes/editorState'
import {
  collectOverlayObjectUrls,
  createOverlayEditorState,
  overlayEditorReducer,
  type ImageOverlayPatch,
  type OverlayEditorAction,
  type OverlayEditorState,
} from './overlays/editorState'
import {
  applyRemovedRange,
  createEdl,
  isSourceTimeKept,
  nextSourceTime,
  splitSegmentAt,
  totalKeptDuration,
} from './edl/edl'

type InspectorTab = 'transcript' | 'captions' | 'retakes' | 'audio' | 'images'

const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'captions', label: 'Captions' },
  { id: 'retakes', label: 'Retakes' },
  { id: 'audio', label: 'Audio' },
  { id: 'images', label: 'Images' },
]

const SEEK_STEP_SECONDS = 5
/** Just past a segment end still reads as "in the edit" for the cut notice. */
const CUT_NOTICE_TOLERANCE_SECONDS = 0.05

type PlayerStyle = CSSProperties & { '--preview-aspect': number }

/** True while the EDL still equals a freshly loaded source (Reset would no-op). */
function isUnedited(edl: EDL): boolean {
  const fresh = createEdl(edl.source)
  return (
    edl.captions.length === 0 &&
    edl.segments.length === fresh.segments.length &&
    edl.segments.every(
      (segment, index) =>
        segment.start === fresh.segments[index].start &&
        segment.end === fresh.segments[index].end,
    )
  )
}

function freshAudioCleanupSettings(): AudioCleanupSettings {
  return { ...DEFAULT_AUDIO_CLEANUP_SETTINGS }
}

type EditorSnapshot = {
  edl: EDL | null
  overlayAssets: OverlayAsset[]
  imageOverlays: ImageOverlay[]
}

type EditorState = {
  edl: EDL | null
  overlays: OverlayEditorState
  retakes: RetakeEditorState
  history: EditorSnapshot[]
}

type RetakeSourcePreview = {
  start: number
  end: number
}

type SuccessfulRetakeAnalysis = {
  transcript: Transcript
  sourceId: string
  sourceDurationMs: number
  recommendationCount: number
}

type ActiveRetakeAnalysis = {
  controller: AbortController
}

type EditorAction =
  | { type: 'replace-edl'; edl: EDL }
  | { type: 'commit-edl'; edl: EDL }
  | { type: 'commit-overlays'; action: OverlayEditorAction }
  | { type: 'update-retakes'; action: RetakeEditorAction }
  | { type: 'undo' }
  | { type: 'reset-document' }

function createEditorState(): EditorState {
  return {
    edl: null,
    overlays: createOverlayEditorState(),
    retakes: createRetakeEditorState(),
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
 * One atomic state machine for editor content plus advisory retake state.
 * React dispatch always reduces against the latest state, so an async EDL-only
 * agent commit cannot restore overlay or retake data captured before it began.
 * Only EDL/overlay content enters the Undo snapshots.
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
    case 'update-retakes': {
      const retakes = retakeEditorReducer(state.retakes, action.action)
      return retakes === state.retakes ? state : { ...state, retakes }
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
        // Retake advice is advisory source-time metadata, not editor content;
        // EDL/overlay Undo deliberately leaves its current workflow state alone.
        retakes: state.retakes,
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
  const { edl, overlays: overlayEditor, retakes, history } = editor
  // One history for all persistent editor content. Selection stays ephemeral,
  // but every snapshot captures EDL + overlay assets/layers so Undo follows the
  // user's actual cross-feature edit order instead of creating a second stack.
  const [playhead, setPlayhead] = useState(0)
  const [inPoint, setInPoint] = useState<number | null>(null)
  const [outPoint, setOutPoint] = useState<number | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  // Engine loading, local extraction, and uploading have separate visible
  // phases so a first-time download does not look like stalled extraction.
  const [transcribePhase, setTranscribePhase] =
    useState<'idle' | 'loading' | 'preparing' | 'transcribing'>('idle')
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  // The synchronous lock also owns every async update. Replacing the source
  // invalidates it before a previous load, extraction, or upload can finish.
  const activeTranscriptionRef = useRef<symbol | null>(null)
  // Tracks whether captions carry hand edits since the last generation, so the
  // manual "Generate captions" button can warn before overwriting them. It lives
  // in React state (not the EDL — the Caption type is untouched): set when an
  // inline edit commits, cleared whenever generate_captions output is committed.
  const [captionsEdited, setCaptionsEdited] = useState(false)
  const [isOverlayEditing, setIsOverlayEditing] = useState(false)
  // Marker selection is transient navigation state. Recommendation workflow
  // status remains in the Part-M advisory reducer; neither belongs to the EDL.
  const [selectedRetakeRecommendationId, setSelectedRetakeRecommendationId] =
    useState<string | null>(null)
  const [retakeScriptCopyFeedback, setRetakeScriptCopyFeedback] =
    useState<RetakeScriptCopyFeedback | null>(null)
  // An empty result has no recommendation-level Part-K fingerprint. Retain the
  // exact successful input locally so "nothing found" is shown only for the
  // source transcript that was actually checked, never merely because every
  // visible recommendation was closed or filtered as stale.
  const [successfulRetakeAnalysis, setSuccessfulRetakeAnalysis] =
    useState<SuccessfulRetakeAnalysis | null>(null)
  // Export-time intent, edited in the Audio and Captions tabs and snapshotted
  // by the header Export button. It is not editor content (no Undo) and has no
  // save/load boundary; a new source starts from the safe defaults again.
  const [audioCleanupSettings, setAudioCleanupSettings] =
    useState<AudioCleanupSettings>(freshAudioCleanupSettings)
  // Phase 8: burning is opt-out. The preview shows captions only when they
  // will be burned, so it matches the export.
  const [burnCaptions, setBurnCaptions] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  // Ephemeral view state: which inspector tab is open, transport status,
  // whether playback jumps removed ranges, and the empty-state drop highlight.
  const [activeTab, setActiveTab] = useState<InspectorTab>('transcript')
  const [isPlaying, setIsPlaying] = useState(false)
  const [skipCuts, setSkipCuts] = useState(true)
  const [isDraggingVideo, setIsDraggingVideo] = useState(false)
  const objectUrlRef = useRef<string | null>(null)
  const overlayObjectUrlsRef = useRef<Set<string>>(new Set())
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  // A retake preview is ephemeral player state in original-source seconds. It
  // must never enter the EDL, output-time projection, editor history, or export.
  const retakeSourcePreviewRef = useRef<RetakeSourcePreview | null>(null)
  const retakeScriptCopyAttemptRef = useRef(0)
  // Object identity is both the synchronous double-start lock and the
  // latest-request token. Invalidating it before aborting makes every late
  // callback from that request harmless, even after a newer run has started.
  const activeRetakeAnalysisRef = useRef<ActiveRetakeAnalysis | null>(null)

  // Revoke the video URL and every still-image object URL on disposal.
  useEffect(() => {
    return () => {
      activeTranscriptionRef.current = null
      retakeSourcePreviewRef.current = null
      retakeScriptCopyAttemptRef.current += 1
      const activeRetakeAnalysis = activeRetakeAnalysisRef.current
      activeRetakeAnalysisRef.current = null
      activeRetakeAnalysis?.controller.abort()
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

  function selectImageOverlay(id: string | null) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'select-image-overlay', id },
    })
    // The overlay inspector lives in the Images tab; reveal it on selection.
    if (id !== null) {
      setActiveTab('images')
    }
  }

  function updateImageOverlay(id: string, patch: ImageOverlayPatch) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'update-image-overlay', id, patch },
    })
  }

  function duplicateImageOverlay(id: string) {
    dispatchEditor({
      type: 'commit-overlays',
      action: {
        type: 'duplicate-image-overlay',
        id,
        newId: crypto.randomUUID(),
        sourceDurationMs:
          edl === null ? undefined : edl.source.duration * 1000,
      },
    })
  }

  function bringImageOverlayForward(id: string) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'bring-overlay-forward', id },
    })
  }

  function sendImageOverlayBackward(id: string) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'send-overlay-backward', id },
    })
  }

  function setImageOverlayLayerPosition(id: string, position: number) {
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'set-overlay-layer-position', id, position },
    })
  }

  function removeImageOverlay(id: string) {
    if (
      overlayEditor.imageOverlays.length === 1 &&
      overlayEditor.imageOverlays[0].id === id
    ) {
      setIsOverlayEditing(false)
    }
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'remove-image-overlay', id },
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
    setIsOverlayEditing(true)
  }

  function removeOverlayAsset(assetId: string) {
    if (
      overlayEditor.imageOverlays.length > 0 &&
      overlayEditor.imageOverlays.every(
        (overlay) => overlay.assetId === assetId,
      )
    ) {
      setIsOverlayEditing(false)
    }
    dispatchEditor({
      type: 'commit-overlays',
      action: { type: 'remove-overlay-asset', assetId },
    })
  }

  function toggleOverlayEditing() {
    if (isOverlayEditing) {
      selectImageOverlay(null)
    }
    setIsOverlayEditing(!isOverlayEditing)
  }

  function cancelActiveRetakeAnalysis() {
    const activeRetakeAnalysis = activeRetakeAnalysisRef.current
    // Invalidate first: abort listeners may settle the old promise promptly,
    // but none of its callbacks may observe themselves as current.
    activeRetakeAnalysisRef.current = null
    activeRetakeAnalysis?.controller.abort()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    if (selected === undefined) {
      return
    }
    loadSourceFile(selected)
  }

  function openVideoPicker() {
    videoInputRef.current?.click()
  }

  function handleVideoDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDraggingVideo(true)
  }

  function handleVideoDragLeave(event: DragEvent<HTMLDivElement>) {
    const next = event.relatedTarget
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
      setIsDraggingVideo(false)
    }
  }

  function handleVideoDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDraggingVideo(false)
    const dropped = event.dataTransfer.files[0]
    // Some platforms report an empty type for valid media; let those through.
    if (
      dropped === undefined ||
      (dropped.type !== '' && !dropped.type.startsWith('video/'))
    ) {
      return
    }
    loadSourceFile(dropped)
  }

  // Source replacement resets the document and every source-scoped view state.
  function loadSourceFile(selected: File) {
    activeTranscriptionRef.current = null
    cancelActiveRetakeAnalysis()
    retakeSourcePreviewRef.current = null
    setSuccessfulRetakeAnalysis(null)
    clearRetakeScriptCopyFeedback()

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
    setTranscribePhase('idle')
    setTranscribeError(null)
    setCaptionsEdited(false)
    setIsOverlayEditing(false)
    setSelectedRetakeRecommendationId(null)
    setAudioCleanupSettings(freshAudioCleanupSettings())
    setBurnCaptions(true)
    setActiveTab('transcript')
    setIsPlaying(false)
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
    retakeSourcePreviewRef.current = null
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
    const retakePreview = retakeSourcePreviewRef.current

    // Retake playback intentionally audits the unedited source, including any
    // range removed from the EDL. Keep this branch ahead of nextSourceTime so
    // the normal edited-preview skip controller cannot hide the affected take.
    if (retakePreview !== null) {
      if (t >= retakePreview.end) {
        retakeSourcePreviewRef.current = null
        video.currentTime = retakePreview.end
        video.pause()
        setPlayhead(retakePreview.end)
        return
      }
      setPlayhead(t)
      return
    }

    if (edl === null || video.paused || !skipCuts) {
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
    if (retakeSourcePreviewRef.current !== null || !skipCuts) {
      return
    }
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
    retakeSourcePreviewRef.current = null
    if (videoRef.current !== null) {
      videoRef.current.currentTime = sourceTime
    }
    setPlayhead(sourceTime)
  }

  // Part P previews one validated recommendation in original source time. The
  // identity check prevents an older rejected play() promise from cancelling a
  // newer preview click; a rejection keeps the completed seek as the allowed
  // fallback and restores ordinary EDL-driven playback.
  async function playRetakeSourceRange(
    startSourceMs: number,
    endSourceMs: number,
  ) {
    if (edl === null) {
      return
    }

    const requestedStart = startSourceMs / 1_000
    const requestedEnd = endSourceMs / 1_000
    if (
      !Number.isFinite(requestedStart) ||
      !Number.isFinite(requestedEnd)
    ) {
      return
    }

    const start = Math.max(
      0,
      Math.min(requestedStart, edl.source.duration),
    )
    const end = Math.max(
      start,
      Math.min(requestedEnd, edl.source.duration),
    )
    if (end <= start) {
      return
    }

    const preview: RetakeSourcePreview = { start, end }
    retakeSourcePreviewRef.current = preview
    const video = videoRef.current
    if (video === null) {
      setPlayhead(start)
      retakeSourcePreviewRef.current = null
      return
    }

    video.currentTime = start
    setPlayhead(start)
    try {
      await video.play()
    } catch {
      if (retakeSourcePreviewRef.current === preview) {
        retakeSourcePreviewRef.current = null
      }
    }
  }

  function cancelRetakeSourcePreview() {
    retakeSourcePreviewRef.current = null
  }

  async function handleTranscribe() {
    if (
      file === null ||
      transcribePhase !== 'idle' ||
      activeTranscriptionRef.current !== null
    ) {
      return
    }
    const request = Symbol('transcription')
    activeTranscriptionRef.current = request
    const isCurrent = () => activeTranscriptionRef.current === request
    setTranscribeError(null)
    try {
      setTranscribePhase('loading')
      await loadFfmpeg()
      if (!isCurrent()) return
      // Extract a tiny mono 16 kHz audio file client-side first, so a real clip
      // clears the proxy's body wall; only then upload it for transcription.
      setTranscribePhase('preparing')
      const audio = await extractAudio(file)
      if (!isCurrent()) return
      setTranscribePhase('transcribing')
      const nextTranscript = await transcribe(audio)
      if (!isCurrent()) return
      cancelActiveRetakeAnalysis()
      clearRetakeScriptCopyFeedback()
      setSuccessfulRetakeAnalysis(null)
      setSelectedRetakeRecommendationId(null)
      dispatchEditor({
        type: 'update-retakes',
        action: { type: 'set-retake-analysis-state', status: 'idle' },
      })
      setTranscript(nextTranscript)
    } catch (err) {
      if (!isCurrent()) return
      setTranscribeError(
        err instanceof Error ? err.message : 'Transcription failed.',
      )
    } finally {
      if (isCurrent()) {
        activeTranscriptionRef.current = null
        setTranscribePhase('idle')
      }
    }
  }

  // Part N is the first actual UI trigger for the inert Parts I-L pipeline.
  // Recommendations remain visible until a successful full/partial
  // replacement. The active object is also the latest-wins token: source or
  // transcript replacement invalidates it before aborting the underlying work.
  async function handleRetakeAnalysis() {
    if (
      transcript === null ||
      edl === null ||
      retakes.retakeAnalysisStatus === 'analyzing' ||
      activeRetakeAnalysisRef.current !== null
    ) {
      return
    }

    const activeRetakeAnalysis: ActiveRetakeAnalysis = {
      controller: new AbortController(),
    }
    activeRetakeAnalysisRef.current = activeRetakeAnalysis
    const analysisTranscript = transcript
    const analysisSourceId = edl.source.id
    const analysisSourceDurationMs = edl.source.duration * 1_000
    setSuccessfulRetakeAnalysis(null)

    dispatchEditor({
      type: 'update-retakes',
      action: { type: 'set-retake-analysis-state', status: 'analyzing' },
    })
    let latestProgress: RetakeAnalysisProgress | undefined

    try {
      const result = await analyzeRetakes(
        analysisTranscript,
        analysisSourceDurationMs,
        {
          signal: activeRetakeAnalysis.controller.signal,
          onProgress: (progress) => {
            if (activeRetakeAnalysisRef.current !== activeRetakeAnalysis) {
              return
            }
            latestProgress = progress
            dispatchEditor({
              type: 'update-retakes',
              action: {
                type: 'set-retake-analysis-state',
                status: 'analyzing',
                progress,
              },
            })
          },
        },
      )
      if (activeRetakeAnalysisRef.current !== activeRetakeAnalysis) {
        return
      }
      dispatchEditor({
        type: 'update-retakes',
        action: {
          type: 'set-retake-recommendations',
          recommendations: result.recommendations,
        },
      })
      setSelectedRetakeRecommendationId(null)
      clearRetakeScriptCopyFeedback()
      const failedCount = result.candidateCount - result.analyzedCount
      setSuccessfulRetakeAnalysis(
        failedCount === 0
          ? {
              transcript: analysisTranscript,
              sourceId: analysisSourceId,
              sourceDurationMs: analysisSourceDurationMs,
              recommendationCount: result.recommendations.length,
            }
          : null,
      )
      dispatchEditor({
        type: 'update-retakes',
        action: {
          type: 'set-retake-analysis-state',
          status: 'complete',
          progress: {
            completed: result.analyzedCount,
            total: result.candidateCount,
            ...(failedCount === 0 ? {} : { failed: failedCount }),
          },
        },
      })
    } catch (cause) {
      if (activeRetakeAnalysisRef.current !== activeRetakeAnalysis) {
        return
      }
      dispatchEditor({
        type: 'update-retakes',
        action: {
          type: 'set-retake-analysis-state',
          status: 'error',
          progress: latestProgress,
          error:
            cause instanceof Error
              ? cause.message
              : 'Retake analysis failed. Try again.',
        },
      })
    } finally {
      if (activeRetakeAnalysisRef.current === activeRetakeAnalysis) {
        activeRetakeAnalysisRef.current = null
      }
    }
  }

  function dismissRetake(id: string) {
    clearRetakeScriptCopyFeedback()
    setSelectedRetakeRecommendationId((selectedId) =>
      selectedId === id ? null : selectedId,
    )
    dispatchEditor({
      type: 'update-retakes',
      action: { type: 'dismiss-retake-recommendation', id },
    })
  }

  function resolveRetake(id: string) {
    clearRetakeScriptCopyFeedback()
    setSelectedRetakeRecommendationId((selectedId) =>
      selectedId === id ? null : selectedId,
    )
    dispatchEditor({
      type: 'update-retakes',
      action: { type: 'resolve-retake-recommendation', id },
    })
  }

  function clearRetakeScriptCopyFeedback() {
    retakeScriptCopyAttemptRef.current += 1
    setRetakeScriptCopyFeedback(null)
  }

  // Copy feedback is ephemeral UI state. A monotonically increasing attempt
  // token prevents an older clipboard result from replacing a newer card's
  // feedback or resurfacing after the recommendation is closed/replaced.
  async function copyRetakeScript(id: string, script: string) {
    const attempt = retakeScriptCopyAttemptRef.current + 1
    retakeScriptCopyAttemptRef.current = attempt
    setRetakeScriptCopyFeedback({
      recommendationId: id,
      status: 'copying',
    })
    try {
      await navigator.clipboard.writeText(script)
      if (retakeScriptCopyAttemptRef.current === attempt) {
        setRetakeScriptCopyFeedback({
          recommendationId: id,
          status: 'copied',
        })
      }
    } catch {
      if (retakeScriptCopyAttemptRef.current === attempt) {
        setRetakeScriptCopyFeedback({
          recommendationId: id,
          status: 'error',
        })
      }
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

  // The <video> has no native controls; this drives it. Its play/pause events
  // keep `isPlaying` honest, and handlePlay still applies the EDL skip rule.
  function togglePlayback() {
    const video = videoRef.current
    if (video === null || edl === null) {
      return
    }
    if (video.paused) {
      // A rejected play() (e.g. interrupted by a seek) leaves the video paused.
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }

  function seekBy(deltaSeconds: number) {
    if (edl === null) {
      return
    }
    handleSeek(
      Math.min(edl.source.duration, Math.max(0, playhead + deltaSeconds)),
    )
  }

  function selectRange(start: number, end: number) {
    setInPoint(start)
    setOutPoint(end)
  }

  // Preview "Captions" pill: generates captions the first time, then turns
  // burning (and with it the preview overlay) on or off.
  function toggleCaptions() {
    if (edl === null || transcript === null) {
      return
    }
    if (edl.captions.length === 0) {
      generateCaptions()
      setBurnCaptions(true)
      return
    }
    setBurnCaptions(!burnCaptions)
  }

  // Arrow keys move between tabs (automatic activation), per the ARIA pattern.
  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const index = INSPECTOR_TABS.findIndex((tab) => tab.id === activeTab)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % INSPECTOR_TABS.length
        break
      case 'ArrowLeft':
        nextIndex = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = INSPECTOR_TABS.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const next = INSPECTOR_TABS[nextIndex].id
    setActiveTab(next)
    document.getElementById(`inspector-tab-${next}`)?.focus()
  }

  /** Run a keyboard shortcut; false leaves the key to the browser. */
  function runShortcut(shortcut: EditorShortcut): boolean {
    if (edl === null) {
      return false
    }
    switch (shortcut) {
      case 'toggle-play':
        togglePlayback()
        return true
      case 'set-in':
        setInPoint(playhead)
        return true
      case 'set-out':
        setOutPoint(playhead)
        return true
      case 'split':
        splitAtPlayhead()
        return true
      case 'delete-range':
        if (!hasSelection) return false
        deleteSelection()
        return true
      case 'clear-marks':
        if (inPoint === null && outPoint === null) return false
        clearSelection()
        return true
      case 'undo':
        if (history.length === 0) return false
        undo()
        return true
      case 'seek-back':
        seekBy(-SEEK_STEP_SECONDS)
        return true
      case 'seek-forward':
        seekBy(SEEK_STEP_SECONDS)
        return true
    }
  }

  const selectedImageOverlay =
    overlayEditor.selectedOverlayId === null
      ? undefined
      : overlayEditor.imageOverlays.find(
          (overlay) => overlay.id === overlayEditor.selectedOverlayId,
        )
  const selectedOverlayAsset =
    selectedImageOverlay === undefined
      ? undefined
      : overlayEditor.overlayAssets.find(
          (asset) => asset.id === selectedImageOverlay.assetId,
        )

  // Freshness rebuilds local candidates and their source evidence. Keep that
  // work off ordinary playback/edit/progress renders: only immutable source
  // transcript or advice changes can affect it, never the EDL or playhead.
  // With no advice yet, there is nothing to validate (or screen implicitly).
  const currentRetakeRecommendations = useMemo(
    () =>
      transcript === null || retakes.retakeRecommendations.length === 0
        ? []
        : removeStaleRetakeRecommendations(
            transcript,
            retakes.retakeRecommendations,
          ),
    [transcript, retakes.retakeRecommendations],
  )
  const openCurrentRetakeRecommendations = useMemo(
    () => currentRetakeRecommendations.filter(
      (recommendation) => recommendation.status === 'open',
    ),
    [currentRetakeRecommendations],
  )
  const hasSuccessfulEmptyRetakeAnalysis =
    transcript !== null &&
    edl !== null &&
    retakes.retakeAnalysisStatus === 'complete' &&
    retakes.retakeRecommendations.length === 0 &&
    successfulRetakeAnalysis !== null &&
    successfulRetakeAnalysis.recommendationCount === 0 &&
    successfulRetakeAnalysis.transcript === transcript &&
    successfulRetakeAnalysis.sourceId === edl.source.id &&
    successfulRetakeAnalysis.sourceDurationMs ===
      edl.source.duration * 1_000
  const visibleSelectedRetakeRecommendationId =
    selectedRetakeRecommendationId !== null &&
    openCurrentRetakeRecommendations.some(
      (recommendation) =>
        recommendation.id === selectedRetakeRecommendationId,
    )
      ? selectedRetakeRecommendationId
      : null
  const visibleRetakeScriptCopyFeedback =
    retakeScriptCopyFeedback !== null &&
    openCurrentRetakeRecommendations.some(
      (recommendation) =>
        recommendation.id ===
        retakeScriptCopyFeedback.recommendationId,
    )
      ? retakeScriptCopyFeedback
      : null

  // Global editing shortcuts (hints are shown on the matching buttons). No
  // dependency list: the listener re-binds each render so it always runs the
  // latest handlers, and it is registered after child listeners so the overlay
  // editors' own Escape/Delete handling (defaultPrevented) wins.
  useEffect(() => {
    if (videoUrl === null) {
      return undefined
    }
    function handleKeyDown(event: KeyboardEvent) {
      const shortcut = editorShortcutFor(event)
      if (shortcut === null) {
        return
      }
      // While editing image overlays, Delete/Escape belong to the overlay stage.
      if (
        isOverlayEditing &&
        (shortcut === 'delete-range' || shortcut === 'clear-marks')
      ) {
        return
      }
      if (runShortcut(shortcut)) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const transcribeLabel =
    transcribePhase === 'loading'
      ? 'Loading audio engine…'
      : transcribePhase === 'preparing'
        ? 'Preparing audio…'
        : transcribePhase === 'transcribing'
          ? 'Transcribing…'
          : transcript === null
            ? 'Transcribe'
            : 'Transcribe Again'
  const canTranscribe = file !== null && transcribePhase === 'idle'

  function transcribeButton(size: 'sm' | 'md') {
    return (
      <button
        type="button"
        className={size === 'md' ? 'btn btn--primary btn--md' : 'btn btn--primary'}
        onClick={handleTranscribe}
        disabled={!canTranscribe}
      >
        {transcribeLabel}
      </button>
    )
  }

  const duration = edl?.source.duration ?? 0
  const frameWidth = edl?.source.width ?? 16
  const frameHeight = edl?.source.height ?? 9
  const playerStyle: PlayerStyle = {
    '--preview-aspect': frameWidth / frameHeight,
  }
  const captionCount = edl?.captions.length ?? 0
  const captionsOnPreview = captionCount > 0 && burnCaptions
  const showCutNotice =
    edl !== null &&
    playhead < duration &&
    !isSourceTimeKept(edl, playhead) &&
    !isSourceTimeKept(edl, playhead - CUT_NOTICE_TOLERANCE_SECONDS)
  const canSplit =
    edl !== null &&
    edl.segments.some((seg) => playhead > seg.start && playhead < seg.end)
  const hasMarks = inPoint !== null || outPoint !== null
  const tabCounts: Record<InspectorTab, number> = {
    transcript: 0,
    captions: 0,
    retakes: openCurrentRetakeRecommendations.length,
    audio: 0,
    images: overlayEditor.overlayAssets.length,
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__lead">
          <h1 className="brand">
            <span>Zero</span>EditTime
          </h1>
          {file !== null && (
            <>
              <div className="divider" />
              <div className="file-meta">
                <Icon name="film" />
                <span className="file-meta__name" title={file.name}>
                  {file.name}
                </span>
                {edl !== null && (
                  <span className="file-meta__duration">
                    {formatClock(duration)}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="replace-btn"
                onClick={openVideoPicker}
                title="Open another video (starts a new edit)"
              >
                Replace
              </button>
            </>
          )}
        </div>

        {videoUrl !== null && (
          <div className="app-header__actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Undo"
              aria-keyshortcuts="Meta+Z Control+Z"
              title="Undo (⌘Z)"
              onClick={undo}
              disabled={history.length === 0}
            >
              <Icon name="undo" />
            </button>
            <button
              type="button"
              className="tool-btn tool-btn--lg"
              title="Revert all edits"
              onClick={resetEdl}
              disabled={edl === null || isUnedited(edl)}
            >
              <Icon name="reset" size={15} />
              Reset
            </button>
            <div className="divider" style={{ margin: '0 6px' }} />
            {edl !== null ? (
              <ExportButton
                edl={edl}
                file={file}
                overlayAssets={overlayEditor.overlayAssets}
                imageOverlays={overlayEditor.imageOverlays}
                audioCleanupSettings={audioCleanupSettings}
                burnCaptions={burnCaptions}
                onBusyChange={setIsExporting}
              />
            ) : (
              <button type="button" className="btn btn--primary export-btn" disabled>
                Export MP4
              </button>
            )}
          </div>
        )}

        <input
          ref={videoInputRef}
          className="visually-hidden-input"
          type="file"
          accept="video/*"
          onChange={handleFileChange}
        />
      </header>

      {videoUrl === null ? (
        <main className="empty-state">
          <div
            className={isDraggingVideo ? 'dropzone dropzone--active' : 'dropzone'}
            onClick={openVideoPicker}
            onDragOver={handleVideoDragOver}
            onDragLeave={handleVideoDragLeave}
            onDrop={handleVideoDrop}
          >
            <IconBadge icon="upload" size={88} />
            <div>
              <h2>Drop a video to start</h2>
              <p>or choose one from your computer</p>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--md"
              onClick={(event) => {
                // The drop zone opens the picker on click too; open it once.
                event.stopPropagation()
                openVideoPicker()
              }}
            >
              <Icon name="plus" size={18} />
              Choose Video
            </button>
          </div>
          <p className="empty-state__features">
            Transcribe · Cut by text · Clean up voice · Export MP4
          </p>
        </main>
      ) : (
        <div className="workspace">
          <main className="stage">
            <div className="player" style={playerStyle}>
              {/* The frame takes the video's own aspect ratio, so the overlay
                  stage and captions align with the picture's edges. */}
              <div
                className={isOverlayEditing ? 'preview preview--editing' : 'preview'}
                style={{ aspectRatio: `${frameWidth} / ${frameHeight}` }}
                onPointerDown={() => {
                  if (isOverlayEditing) {
                    selectImageOverlay(null)
                  }
                }}
                onClick={() => {
                  if (!isOverlayEditing) {
                    togglePlayback()
                  }
                }}
              >
                <video
                  ref={videoRef}
                  src={videoUrl}
                  playsInline
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={(event) => {
                    setIsPlaying(true)
                    handlePlay(event)
                  }}
                  onPause={() => {
                    setIsPlaying(false)
                    cancelRetakeSourcePreview()
                  }}
                  onEnded={() => {
                    setIsPlaying(false)
                    cancelRetakeSourcePreview()
                  }}
                />
                {showCutNotice && (
                  <div className="preview__cut">
                    <strong>Cut from the edit</strong>
                    <span>This part won’t be in the export</span>
                  </div>
                )}
                {edl !== null && (
                  <OverlayStage
                    assets={overlayEditor.overlayAssets}
                    overlays={overlayEditor.imageOverlays}
                    currentSourceMs={playhead * 1000}
                    selectedOverlayId={overlayEditor.selectedOverlayId}
                    isEditing={isOverlayEditing}
                    onSelectOverlay={selectImageOverlay}
                    onClearSelection={() => selectImageOverlay(null)}
                    onCommitGeometry={updateImageOverlay}
                    onRemoveOverlay={removeImageOverlay}
                    onBeginTransform={() => videoRef.current?.pause()}
                  />
                )}
                {edl !== null && burnCaptions && !showCutNotice && (
                  <CaptionOverlay captions={edl.captions} currentTime={playhead} />
                )}
              </div>

              <div className="transport">
                <button
                  type="button"
                  className="play-btn"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  aria-keyshortcuts="Space"
                  title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                  onClick={togglePlayback}
                  disabled={edl === null}
                >
                  <Icon name={isPlaying ? 'pause' : 'play'} size={18} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Back 5 seconds"
                  aria-keyshortcuts="ArrowLeft"
                  title="Back 5 seconds (←)"
                  onClick={() => seekBy(-SEEK_STEP_SECONDS)}
                  disabled={edl === null}
                >
                  <Icon name="chevron-left" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Forward 5 seconds"
                  aria-keyshortcuts="ArrowRight"
                  title="Forward 5 seconds (→)"
                  onClick={() => seekBy(SEEK_STEP_SECONDS)}
                  disabled={edl === null}
                >
                  <Icon name="chevron-right" />
                </button>
                <div className="clock">
                  <span className="clock__now">{formatClock(playhead)}</span>
                  <span className="clock__total">/ {formatClock(duration)}</span>
                </div>
                <div className="spacer" />
                {overlayEditor.imageOverlays.length > 0 && (
                  <button
                    type="button"
                    className="tool-btn tool-btn--toggle"
                    aria-pressed={isOverlayEditing}
                    title="Move, resize, and delete image overlays on the preview"
                    onClick={toggleOverlayEditing}
                  >
                    <Icon name="image-plus" />
                    Edit Images
                  </button>
                )}
                <button
                  type="button"
                  className="tool-btn tool-btn--toggle"
                  aria-pressed={skipCuts}
                  title="Jump over cut parts while previewing"
                  onClick={() => setSkipCuts(!skipCuts)}
                >
                  <span className="toggle-dot" aria-hidden="true" />
                  Skip Cuts
                </button>
                <button
                  type="button"
                  className="tool-btn tool-btn--toggle"
                  aria-pressed={captionsOnPreview}
                  title={
                    transcript === null
                      ? 'Transcribe first to add captions'
                      : captionCount === 0
                        ? 'Generate captions from the transcript'
                        : 'Show and burn captions into the export'
                  }
                  onClick={toggleCaptions}
                  disabled={transcript === null || edl === null}
                >
                  <Icon name="captions" />
                  Captions
                </button>
              </div>
              {isOverlayEditing && (
                <p className="stage-hint">
                  Drag an image to move it. Drag a corner to resize; hold Shift
                  for free resize. Delete removes it; Escape cancels or clears.
                </p>
              )}
            </div>

            {edl !== null && (
              <section className="timeline-card" aria-label="Timeline">
                <div className="timeline-toolbar">
                  <button
                    type="button"
                    className="tool-btn"
                    title="Set In at playhead"
                    aria-keyshortcuts="I"
                    onClick={() => setInPoint(playhead)}
                  >
                    Set In
                    <span className="kbd" aria-hidden="true">I</span>
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    title="Set Out at playhead"
                    aria-keyshortcuts="O"
                    onClick={() => setOutPoint(playhead)}
                  >
                    Set Out
                    <span className="kbd" aria-hidden="true">O</span>
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    title="Split the segment at the playhead"
                    aria-keyshortcuts="S"
                    onClick={splitAtPlayhead}
                    disabled={!canSplit}
                  >
                    Split
                    <span className="kbd" aria-hidden="true">S</span>
                  </button>
                  <div className="toolbar-divider" />
                  <button
                    type="button"
                    className="tool-btn tool-btn--danger"
                    title="Cut the In–Out range"
                    aria-keyshortcuts="Delete Backspace"
                    onClick={deleteSelection}
                    disabled={!hasSelection}
                  >
                    <Icon name="scissors" size={14} />
                    Delete Range
                    <span className="kbd" aria-hidden="true">DEL</span>
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    title="Keep only the In–Out range"
                    onClick={trimToSelection}
                    disabled={!hasSelection}
                  >
                    Trim to Range
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    title="Clear In and Out"
                    aria-keyshortcuts="Escape"
                    onClick={clearSelection}
                    disabled={!hasMarks}
                  >
                    Clear
                    <span className="kbd" aria-hidden="true">ESC</span>
                  </button>
                  <div className="spacer" />
                  <div className="marks">
                    <span>
                      IN{' '}
                      <span className={inPoint === null ? undefined : 'marks__value--set'}>
                        {inPoint === null ? '—' : formatClock(inPoint)}
                      </span>
                    </span>
                    <span>
                      OUT{' '}
                      <span className={outPoint === null ? undefined : 'marks__value--set'}>
                        {outPoint === null ? '—' : formatClock(outPoint)}
                      </span>
                    </span>
                    {hasSelection && (
                      <span className="marks__range">
                        {formatSeconds(Math.abs(outPoint - inPoint))}
                      </span>
                    )}
                  </div>
                </div>

                <Timeline
                  edl={edl}
                  playhead={playhead}
                  inPoint={inPoint}
                  outPoint={outPoint}
                  onSeek={handleSeek}
                  onSelectRange={selectRange}
                  speech={transcript?.words}
                />

                <OverlayTimelineTrack
                  assets={overlayEditor.overlayAssets}
                  overlays={overlayEditor.imageOverlays}
                  selectedOverlayId={overlayEditor.selectedOverlayId}
                  sourceDurationMs={edl.source.duration * 1000}
                  playheadSourceMs={playhead * 1000}
                  onSelectOverlay={selectImageOverlay}
                  onSeekSourceMs={(sourceMs) => handleSeek(sourceMs / 1000)}
                  onCommitTiming={updateImageOverlay}
                  onBeginTimingEdit={() => videoRef.current?.pause()}
                />

                <RetakeTimelineTrack
                  recommendations={openCurrentRetakeRecommendations}
                  selectedRecommendationId={
                    visibleSelectedRetakeRecommendationId
                  }
                  sourceDurationMs={edl.source.duration * 1_000}
                  onSelectRecommendation={setSelectedRetakeRecommendationId}
                  onSeekSourceMs={(sourceMs) =>
                    handleSeek(sourceMs / 1_000)
                  }
                />

                <div className="timeline-footer">
                  <span>
                    Source <strong>{formatClock(edl.source.duration)}</strong>
                  </span>
                  <span>
                    Kept{' '}
                    <strong className="kept">
                      {formatClock(totalKeptDuration(edl))}
                    </strong>
                  </span>
                  <span>
                    {edl.segments.length}{' '}
                    {edl.segments.length === 1 ? 'segment' : 'segments'}
                  </span>
                  <span className="spacer" />
                  <span className="timeline-footer__hint">
                    Drag to scrub · Double-click a segment to select it
                  </span>
                </div>
              </section>
            )}
          </main>

          <aside className="inspector" aria-label="Edit tools">
            {edl !== null && (
              <AgentBar
                key={edl.source.id}
                edl={edl}
                transcript={transcript}
                onCommit={handleAgentCommit}
              />
            )}

            <div
              className="tabs"
              role="tablist"
              aria-label="Editor panels"
              onKeyDown={handleTabKeyDown}
            >
              {INSPECTOR_TABS.map((tab) => {
                const selected = tab.id === activeTab
                const count = tabCounts[tab.id]
                return (
                  <button
                    key={tab.id}
                    id={`inspector-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={selected}
                    aria-controls={`inspector-panel-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                    {count > 0 && (
                      <span
                        className={
                          tab.id === 'retakes'
                            ? 'tab__count tab__count--alert'
                            : 'tab__count'
                        }
                        aria-label={`(${count})`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Every panel stays mounted (inactive ones are hidden) so drafts,
                selections, and live regions survive tab switches. */}
            <div className="inspector__body">
              <div
                role="tabpanel"
                id="inspector-panel-transcript"
                aria-labelledby="inspector-tab-transcript"
                hidden={activeTab !== 'transcript'}
              >
                {transcript === null ? (
                  <div className="panel-empty">
                    <IconBadge icon="lines" size={72} />
                    <div className="panel-empty__text">
                      <h3>Transcribe to edit by text</h3>
                      <p>
                        Every word lines up with the timeline. Cut a word and
                        the video cuts with it.
                      </p>
                    </div>
                    {transcribePhase !== 'idle' && (
                      <div className="indeterminate" aria-hidden="true" />
                    )}
                    {transcribeButton('md')}
                    {transcribePhase === 'loading' && (
                      <p role="status" className="panel-note">
                        The first load downloads about 31 MB. This can take a moment.
                      </p>
                    )}
                    {transcribeError !== null && (
                      <p role="alert" className="panel-note error-text">
                        {transcribeError}
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="panel" style={{ paddingBottom: 0 }}>
                      <div className="caption-actions">
                        <span className="caption-actions__count muted">
                          {transcript.words.length} words
                        </span>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={handleTranscribe}
                          disabled={!canTranscribe}
                        >
                          {transcribeLabel}
                        </button>
                      </div>
                      {transcribePhase === 'loading' && (
                        <p role="status" className="panel-note">
                          The first load downloads about 31 MB. This can take a moment.
                        </p>
                      )}
                      {transcribeError !== null && (
                        <p role="alert" className="panel-note error-text">
                          {transcribeError}
                        </p>
                      )}
                    </div>
                    {edl !== null && (
                      <TranscriptView
                        transcript={transcript}
                        edl={edl}
                        currentTime={playhead}
                        onSeek={handleSeek}
                        onDeleteRange={deleteSourceRange}
                        flaggedRanges={openCurrentRetakeRecommendations}
                      />
                    )}
                  </>
                )}
              </div>

              <div
                role="tabpanel"
                id="inspector-panel-captions"
                aria-labelledby="inspector-tab-captions"
                hidden={activeTab !== 'captions'}
              >
                <div className="panel">
                  {transcript === null || edl === null ? (
                    <div className="panel-intro">
                      <p>Captions are built from the transcript. Transcribe first.</p>
                      {transcribeButton('sm')}
                    </div>
                  ) : (
                    <>
                      <div className="caption-actions">
                        <span className="caption-actions__count">
                          {captionCount === 0
                            ? 'Build captions from the words still in your edit.'
                            : `${captionCount} ${captionCount === 1 ? 'caption' : 'captions'}`}
                        </span>
                        <button
                          type="button"
                          className={captionCount === 0 ? 'btn btn--primary' : 'btn btn--outline'}
                          onClick={generateCaptions}
                        >
                          {captionCount === 0 ? 'Generate Captions' : 'Regenerate Captions'}
                        </button>
                      </div>
                      <CaptionExportControls
                        edl={edl}
                        burnCaptions={burnCaptions}
                        onBurnCaptionsChange={setBurnCaptions}
                      />
                      {captionCount > 0 && (
                        <CaptionList
                          captions={edl.captions}
                          currentTime={playhead}
                          onSeek={handleSeek}
                          onEditText={editCaptionText}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>

              <div
                role="tabpanel"
                id="inspector-panel-retakes"
                aria-labelledby="inspector-tab-retakes"
                hidden={activeTab !== 'retakes'}
              >
                <div className="panel">
                  {transcript !== null && edl !== null ? (
                    <RetakesPanel
                      recommendations={openCurrentRetakeRecommendations}
                      analysisStatus={retakes.retakeAnalysisStatus}
                      analysisProgress={retakes.retakeAnalysisProgress}
                      analysisError={retakes.retakeAnalysisError}
                      hasSuccessfulEmptyAnalysis={
                        hasSuccessfulEmptyRetakeAnalysis
                      }
                      onAnalyze={handleRetakeAnalysis}
                      onPlaySourceRange={playRetakeSourceRange}
                      copyFeedback={visibleRetakeScriptCopyFeedback}
                      onDismiss={dismissRetake}
                      onResolve={resolveRetake}
                      onCopyScript={copyRetakeScript}
                    />
                  ) : (
                    <div className="panel-intro">
                      <p>Retake checks read the transcript. Transcribe first.</p>
                      {transcribeButton('sm')}
                    </div>
                  )}
                </div>
              </div>

              <div
                role="tabpanel"
                id="inspector-panel-audio"
                aria-labelledby="inspector-tab-audio"
                hidden={activeTab !== 'audio'}
              >
                <AudioCleanupControls
                  settings={audioCleanupSettings}
                  disabled={isExporting}
                  onChange={setAudioCleanupSettings}
                />
              </div>

              <div
                role="tabpanel"
                id="inspector-panel-images"
                aria-labelledby="inspector-tab-images"
                hidden={activeTab !== 'images'}
              >
                <div className="panel">
                  {edl !== null &&
                    isOverlayEditing &&
                    selectedImageOverlay !== undefined && (
                      <div className="overlay-inspector-slot form-scope">
                        <OverlayInspector
                          key={selectedImageOverlay.id}
                          overlay={selectedImageOverlay}
                          asset={selectedOverlayAsset}
                          overlays={overlayEditor.imageOverlays}
                          sourceDurationMs={edl.source.duration * 1000}
                          onUpdateOverlay={updateImageOverlay}
                          onSetLayerPosition={setImageOverlayLayerPosition}
                          onDuplicateOverlay={duplicateImageOverlay}
                          onBringForward={bringImageOverlayForward}
                          onSendBackward={sendImageOverlayBackward}
                          onRemoveOverlay={removeImageOverlay}
                        />
                      </div>
                    )}
                  {edl !== null && (
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
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

export default App
