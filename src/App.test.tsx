import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import Timeline from './Timeline'
import AgentBar from './agent/AgentBar'
import CaptionList from './captions/CaptionList'
import CaptionOverlay from './captions/CaptionOverlay'
import { buildSrt, prepareCaptionsForExport } from './captions/captions'
import { applyRemovedRange, totalKeptDuration } from './edl/edl'
import type { Caption, EDL } from './edl/types'
import ExportButton from './export/ExportButton'
import AudioCleanupControls from './export/AudioCleanupControls'
import { buildAudioCleanupPlan } from './export/audioCleanupPlan'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  type AudioCleanupSettings,
} from './export/audioCleanupSettings'
import { buildExportArgs } from './export/ffmpeg'
import * as exportRuntime from './export/ffmpeg'
import {
  buildImageOverlayFilterGraph,
  buildImageOverlayRenderPlanForEdl,
} from './export/imageOverlays'
import type { ImageOverlay, OverlayAsset } from './overlays/types'
import type { OverlayEditorState } from './overlays/editorState'
import MediaPanel from './overlays/MediaPanel'
import OverlayInspector from './overlays/OverlayInspector'
import RetakesPanel, {
  type RetakesPanelProps,
} from './retakes/RetakesPanel'
import RetakeTimelineTrack, {
  type RetakeTimelineTrackProps,
} from './retakes/RetakeTimelineTrack'
import type {
  RetakeBatchOptions,
  RetakeBatchResult,
} from './retakes/batchAnalysis'
import { buildRetakeAnalysisContext } from './retakes/context'
import type { RetakeEditorState } from './retakes/editorState'
import {
  buildRetakeTranscriptFingerprint,
  withRetakeTranscriptFingerprint,
} from './retakes/freshness'
import * as retakeFreshness from './retakes/freshness'
import { buildScreenedRetakeCandidates } from './retakes/nearbyTakes'
import * as nearbyTakes from './retakes/nearbyTakes'
import type { RetakeRecommendation } from './retakes/recommendation'
import TranscriptView from './transcript/Transcript'
import type { Transcript } from './transcript/types'

type StateRecord = {
  kind: 'state'
  setter: ReturnType<typeof vi.fn>
  value: unknown
}

type ReducerRecord = {
  kind: 'reducer'
  dispatch: ReturnType<typeof vi.fn<(action: unknown) => void>>
  reducer: (state: unknown, action: unknown) => unknown
  state: unknown
}

type RefRecord = {
  kind: 'ref'
  ref: { current: unknown }
}

type EffectRecord = {
  kind: 'effect'
  dependencies: readonly unknown[] | undefined
  create: () => void | (() => void)
  cleanup: void | (() => void)
  pending: boolean
}

type MemoRecord = {
  kind: 'memo'
  dependencies: readonly unknown[] | undefined
  value: unknown
}

type HookRecord =
  | StateRecord
  | ReducerRecord
  | RefRecord
  | EffectRecord
  | MemoRecord

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as HookRecord[],
  useState: vi.fn(),
  useReducer: vi.fn(),
  useRef: vi.fn(),
  useEffect: vi.fn(),
  useMemo: vi.fn(),
  getFfmpeg: vi.fn(),
  loadFfmpeg: vi.fn(),
  extractAudio: vi.fn(),
  transcribe: vi.fn(),
  analyzeRetakes: vi.fn(),
  addWindowListener: vi.fn(),
  removeWindowListener: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: harness.useState,
    useReducer: harness.useReducer,
    useRef: harness.useRef,
    useEffect: harness.useEffect,
    useMemo: harness.useMemo,
  }
})

vi.mock('./ffmpeg/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffmpeg/engine')>()
  return {
    ...actual,
    getFfmpeg: harness.getFfmpeg,
    loadFfmpeg: harness.loadFfmpeg,
  }
})

vi.mock('./transcript/extractAudio', () => ({
  extractAudio: harness.extractAudio,
}))

vi.mock('./transcript/api', () => ({ transcribe: harness.transcribe }))

vi.mock('./retakes/batchAnalysis', () => ({
  analyzeRetakes: harness.analyzeRetakes,
}))

type NodeProps = { children?: ReactNode }

type ButtonProps = NodeProps & {
  disabled?: boolean
  onClick?: () => void | Promise<void>
}

type FileInputProps = NodeProps & {
  accept?: string
  onChange?: (event: { target: { files?: readonly File[] } }) => void
  type?: string
}

type VideoLike = {
  currentSrc: string
  currentTime: number
  duration: number
  pause: () => void
  paused: boolean
  play: () => Promise<void>
  videoHeight: number
  videoWidth: number
}

type VideoProps = NodeProps & {
  controls?: boolean
  onEnded?: () => void
  onLoadedMetadata?: (event: { currentTarget: VideoLike }) => void
  onPause?: () => void
  onPlay?: (event: { currentTarget: VideoLike }) => void
  onTimeUpdate?: (event: { currentTarget: VideoLike }) => void
  ref?: { current: VideoLike | null }
  src?: string
}

type TimelineProps = NodeProps & { edl: EDL; playhead: number }

type TranscriptProps = NodeProps & {
  edl: EDL
  transcript: Transcript
  onDeleteRange: (start: number, end: number) => void
}

type CaptionListProps = NodeProps & {
  captions: Caption[]
  onEditText: (id: string, text: string) => void
}

type CaptionOverlayProps = NodeProps & { captions: Caption[] }
type ExportButtonProps = NodeProps & {
  edl: EDL
  file: File | null
  overlayAssets: readonly OverlayAsset[]
  imageOverlays: readonly ImageOverlay[]
  audioCleanupSettings: AudioCleanupSettings
  burnCaptions: boolean
  onBusyChange?: (busy: boolean) => void
}

/** The data an export consumes: ExportButton props minus its busy callback. */
function exportInputs(
  props: ExportButtonProps,
): Omit<ExportButtonProps, 'children' | 'onBusyChange'> {
  const inputs = { ...props }
  delete inputs.children
  delete inputs.onBusyChange
  return inputs
}

function findNode(
  node: ReactNode,
  predicate: (element: ReactElement<NodeProps>) => boolean,
  description: string,
): ReactElement<NodeProps> {
  if (!isValidElement(node)) {
    throw new Error(`Could not find ${description}.`)
  }
  const element = node as ReactElement<NodeProps>
  if (predicate(element)) {
    return element
  }
  for (const child of Children.toArray(element.props.children)) {
    if (!isValidElement(child)) {
      continue
    }
    try {
      return findNode(child, predicate, description)
    } catch {
      // Keep walking sibling branches.
    }
  }
  throw new Error(`Could not find ${description}.`)
}

/** Visible text a screen reader would read: skips aria-hidden icons and key hints. */
function accessibleText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!isValidElement(node)) {
    return Children.toArray(node).map(accessibleText).join('')
  }
  const props = node.props as NodeProps & { 'aria-hidden'?: unknown }
  return props['aria-hidden'] === 'true' || props['aria-hidden'] === true
    ? ''
    : accessibleText(props.children)
}

function findButton(node: ReactNode, label: string): ReactElement<ButtonProps> {
  return findNode(
    node,
    (element) => {
      if (element.type !== 'button') return false
      const ariaLabel = (element.props as { 'aria-label'?: string })['aria-label']
      return (ariaLabel ?? accessibleText(element.props.children)) === label
    },
    `button "${label}"`,
  ) as ReactElement<ButtonProps>
}

function findFileInput(node: ReactNode): ReactElement<FileInputProps> {
  return findNode(
    node,
    (element) =>
      element.type === 'input' &&
      (element.props as FileInputProps).type === 'file',
    'video file input',
  ) as ReactElement<FileInputProps>
}

function findVideo(node: ReactNode): ReactElement<VideoProps> {
  return findNode(
    node,
    (element) => element.type === 'video',
    'video preview',
  ) as ReactElement<VideoProps>
}

function findComponent<Props extends object>(
  node: ReactNode,
  type: unknown,
  description: string,
): ReactElement<Props> {
  return findNode(
    node,
    (element) => element.type === type,
    description,
  ) as ReactElement<Props>
}

function renderApp(): ReactElement {
  harness.cursor = 0
  const view = App()
  // Run mounted/dependency-changed effects so explicit-only analysis tests
  // also catch an accidental automatic request from an App effect.
  for (const record of harness.slots) {
    if (record.kind !== 'effect' || !record.pending) continue
    record.pending = false
    record.cleanup?.()
    record.cleanup = record.create()
  }
  return view
}

function sameDependencies(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  return previous !== undefined && next !== undefined &&
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
}

function editorReducerRecord(): ReducerRecord {
  const record = harness.slots.find(
    (slot): slot is ReducerRecord => slot.kind === 'reducer',
  )
  if (record === undefined) {
    throw new Error('Expected the App editor reducer hook.')
  }
  return record
}

function deferredValue<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function ranges(edl: EDL): Array<[number, number]> {
  return edl.segments.map((segment) => [segment.start, segment.end])
}

function selectSource(
  file: File,
  url: string,
  duration = 10,
): ReactElement {
  const createObjectUrl = vi.mocked(URL.createObjectURL)
  createObjectUrl.mockReturnValueOnce(url)
  let view = renderApp()
  findFileInput(view).props.onChange?.({ target: { files: [file] } })
  view = renderApp()
  const media: VideoLike = {
    currentSrc: url,
    currentTime: 0,
    duration,
    pause: vi.fn(),
    paused: true,
    play: vi.fn().mockResolvedValue(undefined),
    videoHeight: 1080,
    videoWidth: 1920,
  }
  findVideo(view).props.onLoadedMetadata?.({ currentTarget: media })
  return renderApp()
}

function failedTakeFixture(): {
  transcript: Transcript
  recommendation: RetakeRecommendation
} {
  const transcript: Transcript = {
    words: [
      'The', 'dashboard', 'lets', 'you', 'um',
      'manage', 'uh', 'all', 'er', 'projects...',
    ].map((text, index) => ({
      text,
      start: 1 + index * 0.4,
      end: 1 + index * 0.4 + 0.3,
    })),
  }
  const [candidate] = buildScreenedRetakeCandidates(transcript)
  const context = buildRetakeAnalysisContext(transcript, candidate)
  if (context === null) throw new Error('Expected retake context.')
  const fingerprint = buildRetakeTranscriptFingerprint(candidate, context)
  if (fingerprint === null) throw new Error('Expected retake proof.')
  const recommendation = withRetakeTranscriptFingerprint({
    id: 'retake_1000_4900_severe-stumble',
    startSourceMs: 1_000,
    endSourceMs: 4_900,
    reason: 'severe-stumble',
    severity: 'recommended',
    title: 'Severe stumble',
    explanation: 'The restart leaves no complete clean take.',
    suggestedScript: 'State the complete thought once.',
    confidence: 0.9,
    status: 'open',
  }, fingerprint)
  if (recommendation === null) throw new Error('Expected stamped advice.')
  return { transcript, recommendation }
}

beforeEach(() => {
  harness.cursor = 0
  harness.slots.length = 0
  harness.getFfmpeg.mockReset()
  harness.loadFfmpeg.mockReset().mockResolvedValue(undefined)
  harness.extractAudio.mockReset()
  harness.transcribe.mockReset()
  harness.analyzeRetakes.mockReset()
  harness.addWindowListener.mockReset()
  harness.removeWindowListener.mockReset()
  harness.useState.mockReset()
  harness.useReducer.mockReset()
  harness.useRef.mockReset()
  harness.useEffect.mockReset()
  harness.useMemo.mockReset()

  harness.useState.mockImplementation((initial: unknown) => {
    const index = harness.cursor++
    let record = harness.slots[index]
    if (record === undefined) {
      const value =
        typeof initial === 'function'
          ? (initial as () => unknown)()
          : initial
      const created: StateRecord = {
        kind: 'state',
        value,
        setter: vi.fn(),
      }
      created.setter.mockImplementation((next: unknown) => {
        created.value =
          typeof next === 'function'
            ? (next as (previous: unknown) => unknown)(created.value)
            : next
      })
      harness.slots[index] = created
      record = created
    }
    if (record.kind !== 'state') {
      throw new Error(`Hook slot ${index} changed kind.`)
    }
    return [record.value, record.setter]
  })

  harness.useReducer.mockImplementation(
    (
      reducer: (state: unknown, action: unknown) => unknown,
      initialArg: unknown,
      initializer?: (arg: unknown) => unknown,
    ) => {
      const index = harness.cursor++
      let record = harness.slots[index]
      if (record === undefined) {
        const created: ReducerRecord = {
          kind: 'reducer',
          state:
            initializer === undefined ? initialArg : initializer(initialArg),
          reducer,
          dispatch: vi.fn<(action: unknown) => void>(),
        }
        created.dispatch.mockImplementation((action: unknown) => {
          created.state = created.reducer(created.state, action)
        })
        harness.slots[index] = created
        record = created
      }
      if (record.kind !== 'reducer') {
        throw new Error(`Hook slot ${index} changed kind.`)
      }
      record.reducer = reducer
      return [record.state, record.dispatch]
    },
  )

  harness.useRef.mockImplementation((initial: unknown) => {
    const index = harness.cursor++
    let record = harness.slots[index]
    if (record === undefined) {
      record = { kind: 'ref', ref: { current: initial } }
      harness.slots[index] = record
    }
    if (record.kind !== 'ref') {
      throw new Error(`Hook slot ${index} changed kind.`)
    }
    return record.ref
  })

  harness.useEffect.mockImplementation(
    (create: EffectRecord['create'], dependencies?: readonly unknown[]) => {
      const index = harness.cursor++
      const record = harness.slots[index]
      if (record === undefined) {
        harness.slots[index] = {
          kind: 'effect', create, dependencies, cleanup: undefined, pending: true,
        }
        return
      }
      if (record.kind !== 'effect') {
        throw new Error(`Hook slot ${index} changed kind.`)
      }
      record.pending = !sameDependencies(record.dependencies, dependencies)
      record.create = create
      record.dependencies = dependencies
    },
  )

  harness.useMemo.mockImplementation(
    (create: () => unknown, dependencies?: readonly unknown[]) => {
      const index = harness.cursor++
      const record = harness.slots[index]
      if (record === undefined) {
        const value = create()
        harness.slots[index] = { kind: 'memo', dependencies, value }
        return value
      }
      if (record.kind !== 'memo') {
        throw new Error(`Hook slot ${index} changed kind.`)
      }
      if (!sameDependencies(record.dependencies, dependencies)) {
        record.value = create()
        record.dependencies = dependencies
      }
      return record.value
    },
  )

  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    '00000000-0000-4000-8000-000000000001',
  )
  // App binds its keyboard shortcuts on window; Node has no window.
  vi.stubGlobal('window', {
    addEventListener: harness.addWindowListener,
    removeEventListener: harness.removeWindowListener,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('App transcription lifecycle', () => {
  const audio = new Blob(['audio'], { type: 'audio/mpeg' })
  const transcript: Transcript = {
    words: [{ text: 'Current source.', start: 0, end: 1 }],
  }

  it('shows loading, preparation, and upload separately and locks before rerender', async () => {
    const loading = deferredValue<void>()
    const extraction = deferredValue<Blob>()
    const upload = deferredValue<Transcript>()
    let view = selectSource({ name: 'source.mp4' } as File, 'blob:source')
    harness.loadFfmpeg.mockReturnValueOnce(loading.promise)
    harness.extractAudio.mockReturnValueOnce(extraction.promise)
    harness.transcribe.mockReturnValueOnce(upload.promise)
    const trigger = findButton(view, 'Transcribe').props.onClick
    const pending = trigger?.()
    await trigger?.()

    expect(harness.loadFfmpeg).toHaveBeenCalledTimes(2) // Preload + one click.
    expect(harness.extractAudio).not.toHaveBeenCalled()
    view = renderApp()
    expect(findButton(view, 'Loading audio engine…').props.disabled).toBe(true)
    expect(findNode(
      view,
      (element) => (element.props as { role?: string }).role === 'status',
      'engine loading status',
    ).props.children).toContain('31 MB')

    loading.resolve()
    await Promise.resolve()
    view = renderApp()
    expect(findButton(view, 'Preparing audio…').props.disabled).toBe(true)
    expect(harness.extractAudio).toHaveBeenCalledOnce()
    expect(harness.transcribe).not.toHaveBeenCalled()

    extraction.resolve(audio)
    await Promise.resolve()
    view = renderApp()
    expect(findButton(view, 'Transcribing…').props.disabled).toBe(true)
    expect(harness.transcribe).toHaveBeenCalledWith(audio)
    upload.resolve(transcript)
    await pending
    view = renderApp()
    expect(findButton(view, 'Transcribe Again').props.disabled).toBe(false)
    expect(findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
      .props.transcript).toBe(transcript)
  })

  it.each(['loading', 'preparing', 'transcribing'] as const)(
    'shows a %s failure and allows a successful retry',
    async (phase) => {
      harness.extractAudio.mockResolvedValue(audio)
      harness.transcribe.mockResolvedValue(transcript)
      let view = selectSource({ name: 'source.mp4' } as File, 'blob:source')
      const failedStep = phase === 'loading'
        ? harness.loadFfmpeg
        : phase === 'preparing' ? harness.extractAudio : harness.transcribe
      failedStep.mockRejectedValueOnce(new Error(`${phase} timed out. Try again.`))

      await findButton(view, 'Transcribe').props.onClick?.()
      view = renderApp()
      expect(findButton(view, 'Transcribe').props.disabled).toBe(false)
      expect(findNode(
        view,
        (element) => (element.props as { role?: string }).role === 'alert',
        'transcription error',
      ).props.children).toBe(`${phase} timed out. Try again.`)
      if (phase === 'loading') expect(harness.extractAudio).not.toHaveBeenCalled()
      if (phase !== 'transcribing') expect(harness.transcribe).not.toHaveBeenCalled()

      await findButton(view, 'Transcribe').props.onClick?.()
      view = renderApp()
      expect(findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
        .props.transcript).toBe(transcript)
      expect(() => findNode(
        view,
        (element) => (element.props as { role?: string }).role === 'alert',
        'transcription error',
      )).toThrow('Could not find')
    },
  )

  it.each([
    ['loading', 'success'], ['loading', 'error'],
    ['preparing', 'success'], ['preparing', 'error'],
    ['transcribing', 'success'], ['transcribing', 'error'],
  ] as const)(
    'ignores stale %s %s after source replacement without unlocking the new request',
    async (phase, outcome) => {
      const stale = deferredValue<unknown>()
      const current = deferredValue<Transcript>()
      harness.extractAudio.mockResolvedValue(audio)
      harness.transcribe.mockResolvedValue(transcript)
      let view = selectSource({ name: 'first.mp4' } as File, 'blob:first')
      const staleStep = phase === 'loading'
        ? harness.loadFfmpeg
        : phase === 'preparing' ? harness.extractAudio : harness.transcribe
      staleStep.mockReturnValueOnce(stale.promise)
      const oldPending = findButton(view, 'Transcribe').props.onClick?.()
      await Promise.resolve()
      await Promise.resolve()

      view = selectSource({ name: 'second.mp4' } as File, 'blob:second')
      expect(findButton(view, 'Transcribe').props.disabled).toBe(false)
      harness.transcribe.mockReturnValueOnce(current.promise)
      const currentTrigger = findButton(view, 'Transcribe').props.onClick
      const currentPending = currentTrigger?.()
      await Promise.resolve()
      await Promise.resolve()
      const uploadCount = harness.transcribe.mock.calls.length
      const extractionCount = harness.extractAudio.mock.calls.length

      if (outcome === 'error') stale.reject(new Error('Old source failed.'))
      else stale.resolve(phase === 'loading' ? undefined : phase === 'preparing'
        ? audio : { words: [{ text: 'Old source.', start: 0, end: 1 }] })
      await oldPending
      await currentTrigger?.()
      view = renderApp()
      expect(findButton(view, 'Transcribing…').props.disabled).toBe(true)
      expect(harness.transcribe).toHaveBeenCalledTimes(uploadCount)
      expect(harness.extractAudio).toHaveBeenCalledTimes(extractionCount)
      expect(() => findNode(
        view,
        (element) => (element.props as { role?: string }).role === 'alert',
        'transcription error',
      )).toThrow('Could not find')

      current.resolve(transcript)
      await currentPending
      view = renderApp()
      expect(findButton(view, 'Transcribe Again').props.disabled).toBe(false)
      expect(findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
        .props.transcript).toBe(transcript)
    },
  )

  it.each([
    ['loading', 'success'], ['loading', 'error'],
    ['preparing', 'success'], ['preparing', 'error'],
    ['transcribing', 'success'], ['transcribing', 'error'],
  ] as const)('ignores %s %s after unmount', async (phase, outcome) => {
    const stale = deferredValue<unknown>()
    harness.extractAudio.mockResolvedValue(audio)
    harness.transcribe.mockResolvedValue(transcript)
    const view = selectSource({ name: 'source.mp4' } as File, 'blob:source')
    const staleStep = phase === 'loading'
      ? harness.loadFfmpeg
      : phase === 'preparing' ? harness.extractAudio : harness.transcribe
    staleStep.mockReturnValueOnce(stale.promise)
    const pending = findButton(view, 'Transcribe').props.onClick?.()
    await Promise.resolve()
    await Promise.resolve()
    for (const record of harness.slots) {
      if (record.kind === 'effect') record.cleanup?.()
    }
    const setters = harness.slots.flatMap((record) =>
      record.kind === 'state' ? [record.setter] : [],
    )
    setters.forEach((setter) => setter.mockClear())
    editorReducerRecord().dispatch.mockClear()
    const uploadCount = harness.transcribe.mock.calls.length
    const extractionCount = harness.extractAudio.mock.calls.length

    if (outcome === 'error') stale.reject(new Error('Late failure.'))
    else stale.resolve(phase === 'loading' ? undefined : phase === 'preparing'
      ? audio : transcript)
    await pending
    setters.forEach((setter) => expect(setter).not.toHaveBeenCalled())
    expect(editorReducerRecord().dispatch).not.toHaveBeenCalled()
    expect(harness.transcribe).toHaveBeenCalledTimes(uploadCount)
    expect(harness.extractAudio).toHaveBeenCalledTimes(extractionCount)
  })
})

describe('App regression wiring', () => {
  it.each(['dismissed', 'resolved'] as const)(
    'keeps %s advice through legacy content-only Undo and a delayed agent commit',
    async (status) => {
      const { transcript, recommendation } = failedTakeFixture()
      harness.extractAudio.mockResolvedValue(new Blob(['audio']))
      harness.transcribe.mockResolvedValue(transcript)
      harness.analyzeRetakes.mockResolvedValue({
        candidateCount: 1, analyzedCount: 1, recommendations: [recommendation],
      })
      let view = selectSource({ name: 'legacy.mp4' } as File, 'blob:legacy')
      await findButton(view, 'Transcribe').props.onClick?.()
      view = renderApp()
      const editor = editorReducerRecord()
      const state = () => editor.state as {
        edl: EDL
        overlays: OverlayEditorState
        history: unknown[]
        retakes: RetakeEditorState
      }
      const originalEdl = state().edl
      expect(originalEdl).not.toHaveProperty('retakeRecommendations')
      expect(state().retakes).toEqual({
        retakeRecommendations: [], retakeAnalysisStatus: 'idle',
      })

      // Every snapshot predates the first analysis and has the existing
      // content-only shape; there is no saved-project/migration API to fake.
      findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
        .props.onDeleteRange(2, 3)
      view = renderApp()
      findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
        .props.onAddAsset({
          id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png',
          width: 640, height: 480, src: 'blob:image',
        })
      view = renderApp()
      findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
        .props.onAddOverlay({
          id: 'overlay', assetId: 'image', startSourceMs: 0, endSourceMs: 7_000,
          x: 0, y: 0, width: 0.5, height: 0.5, fit: 'contain', opacity: 1,
          zIndex: 0, fadeInMs: 0, fadeOutMs: 0,
        })
      view = renderApp()
      expect(state().history).toHaveLength(3)
      for (const snapshot of state().history) {
        expect(Object.keys(snapshot as object).sort())
          .toEqual(['edl', 'imageOverlays', 'overlayAssets'])
      }
      const cutEdl = state().edl
      const legacyHistory = state().history
      const agent = findComponent<ComponentProps<typeof AgentBar>>(view, AgentBar, 'agent bar')
      const agentResult = deferredValue<EDL>()
      const pendingCommit = agentResult.promise.then((next) => agent.props.onCommit(next, false))

      await findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props.onAnalyze()
      view = renderApp()
      const panel = findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
      expect(panel.props.recommendations).toEqual([recommendation])
      if (status === 'dismissed') panel.props.onDismiss(recommendation.id)
      else panel.props.onResolve(recommendation.id)
      view = renderApp()
      const latestRetakes = state().retakes
      expect(latestRetakes).toMatchObject({
        retakeAnalysisStatus: 'complete', retakeRecommendations: [{ status }],
      })
      expect(state().history).toBe(legacyHistory)

      findButton(view, 'Undo').props.onClick?.()
      view = renderApp()
      expect(state().overlays.imageOverlays).toEqual([])
      expect(state().overlays.overlayAssets).toHaveLength(1)
      expect(state().edl).toBe(cutEdl)
      expect(state().retakes).toBe(latestRetakes)
      const latestOverlays = state().overlays

      // This callback was captured while an overlay still existed and advice
      // was idle. Resolving later must commit only its EDL against latest state.
      const agentEdl = applyRemovedRange(agent.props.edl, 6, 7)
      agentResult.resolve(agentEdl)
      await pendingCommit
      view = renderApp()
      expect(state().edl).toBe(agentEdl)
      expect(state().overlays).toBe(latestOverlays)
      expect(state().retakes).toBe(latestRetakes)
      expect(state().history).toHaveLength(3)

      for (const expectedHistoryLength of [2, 1, 0]) {
        findButton(view, 'Undo').props.onClick?.()
        view = renderApp()
        expect(state().history).toHaveLength(expectedHistoryLength)
        expect(state().retakes).toBe(latestRetakes)
      }
      expect(state().edl).toBe(originalEdl)
      expect(state().overlays).toEqual({
        overlayAssets: [], imageOverlays: [], selectedOverlayId: null,
      })
      expect(findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
        .props.transcript).toBe(transcript)
      findButton(view, 'Reset').props.onClick?.()
      expect(state().retakes).toBe(latestRetakes)

      view = selectSource({ name: 'next.mp4' } as File, 'blob:next', 12)
      expect(state().retakes).toEqual({
        retakeRecommendations: [], retakeAnalysisStatus: 'idle',
      })
      expect(state().history).toEqual([])
      expect(ranges(state().edl)).toEqual([[0, 12]])
      expect(() => findComponent(view, RetakesPanel, 'retakes panel'))
        .toThrow('Could not find retakes panel.')
    },
  )

  it('hands identical source, edit, caption, overlay, and cleanup inputs to export with or without advice', async () => {
    const file = new File(['unchanged source bytes'], 'source.mp4', { type: 'video/mp4' })
    const { transcript, recommendation } = failedTakeFixture()
    harness.extractAudio.mockResolvedValue(new Blob(['audio']))
    harness.transcribe.mockResolvedValue(transcript)
    harness.analyzeRetakes.mockResolvedValue({
      candidateCount: 1, analyzedCount: 1, recommendations: [recommendation],
    })
    let view = selectSource(file, 'blob:source')
    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    const editor = editorReducerRecord()
    const originalEdl = findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl
    editor.dispatch({
      type: 'commit-edl',
      edl: applyRemovedRange({
        ...originalEdl,
        captions: [{ id: 'caption', start: 1, end: 5, text: 'Existing caption.' }],
      }, 2, 4),
    })
    findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
      .props.onAddAsset({
        id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png',
        width: 640, height: 480, src: 'blob:image',
      })
    view = renderApp()
    findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
      .props.onAddOverlay({
        id: 'overlay', assetId: 'image', startSourceMs: 0, endSourceMs: 7_000,
        x: 0, y: 0, width: 0.5, height: 0.5, fit: 'contain', opacity: 0.7,
        zIndex: 0, fadeInMs: 100, fadeOutMs: 200,
      })
    view = renderApp()
    const settings: AudioCleanupSettings = {
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong', voiceLeveling: false,
      loudnessTargetLufs: -20, truePeakLimitDb: -3, smoothJoins: false,
    }
    // Cleanup settings are edited in the Audio tab and handed to the header
    // Export button as data.
    findComponent<ComponentProps<typeof AudioCleanupControls>>(
      view, AudioCleanupControls, 'audio cleanup controls',
    ).props.onChange(settings)
    view = renderApp()
    const exportProps = findComponent<ExportButtonProps>(view, ExportButton, 'export button').props
    expect(exportProps.audioCleanupSettings).toEqual(settings)
    const contentBefore = structuredClone(exportInputs(exportProps))
    const transcriptBefore = structuredClone(transcript)
    const engine = { loaded: true, on: vi.fn(), off: vi.fn() }
    harness.getFfmpeg.mockReturnValue(engine)
    // Only the encoder/download boundary is mocked. App props, the real
    // ExportButton callback, and all export-input projections remain live.
    const encode = vi.spyOn(exportRuntime, 'runExport')
      .mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue(anchor), body: { appendChild: vi.fn() },
    })

    async function expectSameExport() {
      view = renderApp()
      const props = findComponent<ExportButtonProps>(view, ExportButton, 'export button').props
      expect(exportInputs(props)).toEqual(contentBefore)
      expect(props.file).toBe(file)
      expect(props.edl).toBe(exportProps.edl)
      expect(totalKeptDuration(props.edl)).toBe(8)
      expect(transcript).toEqual(transcriptBefore)
      expect(findComponent<ComponentProps<typeof AudioCleanupControls>>(
        view, AudioCleanupControls, 'audio cleanup controls',
      ).props.settings).toEqual(settings)
      const exportView = ExportButton(props)
      const nextCall = encode.mock.calls.length + 1
      findButton(exportView, 'Export MP4').props.onClick?.()
      await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledTimes(nextCall))
      expect(encode).toHaveBeenNthCalledWith(
        nextCall, engine, file, exportProps.edl.segments,
        prepareCaptionsForExport(exportProps.edl.captions, exportProps.edl),
        expect.any(Function),
        {
          renderPlan: buildImageOverlayRenderPlanForEdl(
            exportProps.edl, exportProps.imageOverlays, exportProps.overlayAssets,
          ),
          assets: exportProps.overlayAssets, frameWidth: 1920, frameHeight: 1080,
        },
        buildAudioCleanupPlan(settings),
      )
      expect(encode.mock.calls[nextCall - 1][1]).toBe(file)
      expect(encode.mock.calls[nextCall - 1][2]).toBe(exportProps.edl.segments)
      expect(await file.text()).toBe('unchanged source bytes')
    }

    expect(findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props)
      .toMatchObject({ recommendations: [], analysisStatus: 'idle' })
    await expectSameExport()
    await findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props.onAnalyze()
    await expectSameExport()
    let panel = findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
    expect(panel.props.recommendations).toEqual([recommendation])
    panel.props.onDismiss(recommendation.id)
    await expectSameExport()
    expect((editor.state as { retakes: RetakeEditorState }).retakes.retakeRecommendations[0].status)
      .toBe('dismissed')
    editor.dispatch({
      type: 'update-retakes',
      action: { type: 'set-retake-recommendations', recommendations: [recommendation] },
    })
    view = renderApp()
    findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props.onResolve(recommendation.id)
    await expectSameExport()
    expect((editor.state as { retakes: RetakeEditorState }).retakes.retakeRecommendations[0].status)
      .toBe('resolved')
    harness.analyzeRetakes.mockRejectedValueOnce(new Error('Analysis unavailable.'))
    panel = findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
    await panel.props.onAnalyze()
    await expectSameExport()
    expect(findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props)
      .toMatchObject({ analysisStatus: 'error', analysisError: 'Analysis unavailable.' })
    expect(encode).toHaveBeenCalledTimes(5)
  })

  it('keeps local retake screening off normal edits and runs AI only on the explicit check', async () => {
    // Call-through spies observe the actual candidate/fingerprint work, not a
    // stubbed empty result. Effects and memo dependencies run in this harness.
    const { transcript, recommendation } = failedTakeFixture()
    const freshness = vi.spyOn(retakeFreshness, 'removeStaleRetakeRecommendations')
    const screening = vi.spyOn(nearbyTakes, 'buildScreenedRetakeCandidates')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    harness.extractAudio.mockResolvedValue(new Blob(['audio']))
    harness.transcribe.mockResolvedValue(transcript)

    renderApp()
    expect(harness.analyzeRetakes).not.toHaveBeenCalled()
    let view = selectSource({ name: 'source.mp4' } as File, 'blob:source')
    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    // No advice exists yet: even local screening waits for an explicit check.
    expect(freshness).not.toHaveBeenCalled()
    expect(screening).not.toHaveBeenCalled()
    expect(harness.analyzeRetakes).not.toHaveBeenCalled()

    editorReducerRecord().dispatch({
      type: 'update-retakes',
      action: { type: 'set-retake-recommendations', recommendations: [recommendation] },
    })
    view = renderApp()
    const visibleAdvice = findComponent<RetakesPanelProps>(
      view, RetakesPanel, 'retakes panel',
    ).props.recommendations
    expect(visibleAdvice).toEqual([recommendation])
    expect(freshness).toHaveBeenCalledOnce()
    expect(screening).toHaveBeenCalledOnce()

    function expectNoRetakeWork(analysisCalls = 0) {
      view = renderApp()
      expect(findComponent<RetakesPanelProps>(
        view, RetakesPanel, 'retakes panel',
      ).props.recommendations).toBe(visibleAdvice)
      expect(findComponent<RetakeTimelineTrackProps>(
        view, RetakeTimelineTrack, 'retake timeline track',
      ).props.recommendations).toBe(visibleAdvice)
      expect(freshness).toHaveBeenCalledOnce()
      expect(screening).toHaveBeenCalledOnce()
      expect(harness.analyzeRetakes).toHaveBeenCalledTimes(analysisCalls)
      expect(fetchSpy).not.toHaveBeenCalled()
    }

    const media: VideoLike = {
      currentSrc: 'blob:source', currentTime: 0, duration: 10,
      pause: vi.fn(), paused: false, play: vi.fn().mockResolvedValue(undefined),
      videoHeight: 1080, videoWidth: 1920,
    }
    findVideo(view).props.onPlay?.({ currentTarget: media })
    for (let tick = 1; tick <= 30; tick += 1) {
      media.currentTime = tick / 10
      findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
      expectNoRetakeWork()
    }
    findButton(view, 'Set In').props.onClick?.()
    expectNoRetakeWork()
    findButton(view, 'Clear').props.onClick?.()
    expectNoRetakeWork()
    findButton(view, 'Split').props.onClick?.()
    expectNoRetakeWork()
    expect(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl.segments)
      .toHaveLength(2)
    findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
      .props.onDeleteRange(2, 2.5)
    expectNoRetakeWork()
    expect(ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl))
      .toEqual([[0, 2], [2.5, 3], [3, 10]])
    expect(findComponent<TranscriptProps>(view, TranscriptView, 'transcript')
      .props.transcript).toBe(transcript)
    findButton(view, 'Undo').props.onClick?.()
    expectNoRetakeWork()
    findButton(view, 'Generate Captions').props.onClick?.()
    expectNoRetakeWork()
    const captions = findComponent<CaptionListProps>(view, CaptionList, 'caption list')
    captions.props.onEditText(captions.props.captions[0].id, 'Corrected caption')
    expectNoRetakeWork()

    findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
      .props.onAddAsset({
        id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png',
        width: 640, height: 480, src: 'blob:image',
      })
    expectNoRetakeWork()
    findComponent<ComponentProps<typeof MediaPanel>>(view, MediaPanel, 'media panel')
      .props.onAddOverlay({
        id: 'overlay', assetId: 'image', startSourceMs: 0, endSourceMs: 7_000,
        x: 0, y: 0, width: 0.5, height: 0.5, fit: 'contain', opacity: 1,
        zIndex: 0, fadeInMs: 0, fadeOutMs: 0,
      })
    expectNoRetakeWork()
    findComponent<ComponentProps<typeof OverlayInspector>>(
      view, OverlayInspector, 'overlay inspector',
    ).props.onUpdateOverlay('overlay', { opacity: 0.5 })
    expectNoRetakeWork()
    expect(findComponent<ComponentProps<typeof OverlayInspector>>(
      view, OverlayInspector, 'overlay inspector',
    ).props.overlay.opacity).toBe(0.5)
    findComponent<RetakeTimelineTrackProps>(
      view, RetakeTimelineTrack, 'retake timeline track',
    ).props.onSelectRecommendation(recommendation.id)
    expectNoRetakeWork()
    expect(findComponent<RetakeTimelineTrackProps>(
      view, RetakeTimelineTrack, 'retake timeline track',
    ).props.selectedRecommendationId).toBe(recommendation.id)

    // Exercise the real export click with App's actual props; only the encoder
    // and download boundary are mocked. Child hooks use slots after App's.
    harness.getFfmpeg.mockReturnValue({ loaded: true, on: vi.fn(), off: vi.fn() })
    const encode = vi.spyOn(exportRuntime, 'runExport')
      .mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue(anchor),
      body: { appendChild: vi.fn() },
    })
    const exportView = ExportButton(findComponent<ExportButtonProps>(
      view, ExportButton, 'export button',
    ).props)
    findButton(exportView, 'Export MP4').props.onClick?.()
    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(encode).toHaveBeenCalledOnce()
    expectNoRetakeWork()

    const analysis = deferredValue<RetakeBatchResult>()
    let options: RetakeBatchOptions | undefined
    harness.analyzeRetakes.mockImplementation((
      _transcript: Transcript, _duration: number, nextOptions: RetakeBatchOptions,
    ) => {
      options = nextOptions
      nextOptions.onProgress?.({ completed: 0, total: 2 })
      return analysis.promise
    })
    const pending = findComponent<RetakesPanelProps>(
      view, RetakesPanel, 'retakes panel',
    ).props.onAnalyze()
    expectNoRetakeWork(1)
    options?.onProgress?.({ completed: 1, total: 2 })
    expectNoRetakeWork(1)
    expect(findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel').props)
      .toMatchObject({ analysisStatus: 'analyzing', analysisProgress: { completed: 1, total: 2 } })
    analysis.resolve({ candidateCount: 2, analyzedCount: 2, recommendations: [recommendation] })
    await pending
    expectNoRetakeWork(1)
  })

  it('revalidates memoized advice on source transcript or recommendation changes', async () => {
    const { transcript, recommendation } = failedTakeFixture()
    const freshness = vi.spyOn(retakeFreshness, 'removeStaleRetakeRecommendations')
    const screening = vi.spyOn(nearbyTakes, 'buildScreenedRetakeCandidates')
    harness.extractAudio.mockResolvedValue(new Blob(['audio']))
    harness.transcribe.mockResolvedValue(transcript)
    let view = selectSource({ name: 'source.mp4' } as File, 'blob:source')
    await findButton(view, 'Transcribe').props.onClick?.()
    editorReducerRecord().dispatch({
      type: 'update-retakes',
      action: { type: 'set-retake-recommendations', recommendations: [recommendation] },
    })
    view = renderApp()
    const initialAdvice = findComponent<RetakesPanelProps>(
      view, RetakesPanel, 'retakes panel',
    ).props.recommendations
    expect(initialAdvice).toEqual([recommendation])
    expect(freshness).toHaveBeenCalledOnce()

    const editedRecommendation = { ...recommendation, title: 'Check this explanation' }
    editorReducerRecord().dispatch({
      type: 'update-retakes',
      action: { type: 'set-retake-recommendations', recommendations: [editedRecommendation] },
    })
    view = renderApp()
    const updatedAdvice = findComponent<RetakesPanelProps>(
      view, RetakesPanel, 'retakes panel',
    ).props.recommendations
    expect(updatedAdvice).not.toBe(initialAdvice)
    expect(updatedAdvice).toEqual([editedRecommendation])
    expect(freshness).toHaveBeenCalledTimes(2)
    expect(screening).toHaveBeenCalledTimes(2)

    // Same timing and candidate signals but different actual words: cached
    // provenance must be rebuilt, and the old advice must disappear.
    const changedTranscript: Transcript = {
      words: transcript.words.map((word, index) =>
        index === 1 ? { ...word, text: 'workspace' } : { ...word }),
    }
    harness.transcribe.mockResolvedValueOnce(changedTranscript)
    await findButton(view, 'Transcribe Again').props.onClick?.()
    view = renderApp()
    expect(findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
      .props.recommendations).toEqual([])
    expect(freshness).toHaveBeenCalledTimes(3)
    expect(screening).toHaveBeenCalledTimes(3)
    renderApp()
    expect(freshness).toHaveBeenCalledTimes(3)

    // Restoring the exact source evidence invalidates the memo again and
    // restores current advice without requesting another model analysis.
    await findButton(view, 'Transcribe Again').props.onClick?.()
    view = renderApp()
    const panel = findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
    expect(panel.props.recommendations).toEqual([editedRecommendation])
    expect(freshness).toHaveBeenCalledTimes(4)
    panel.props.onDismiss(recommendation.id)
    view = renderApp()
    expect(findComponent<RetakesPanelProps>(view, RetakesPanel, 'retakes panel')
      .props.recommendations).toEqual([])
    expect(freshness).toHaveBeenCalledTimes(5)
    expect(screening).toHaveBeenCalledTimes(5)
    renderApp()
    expect(freshness).toHaveBeenCalledTimes(5)
    expect(harness.analyzeRetakes).not.toHaveBeenCalled()
  })

  it('runs retake analysis only on request and keeps panel actions outside EDL history', async () => {
    const file = { name: 'source.mp4' } as File
    const { transcript, recommendation } = failedTakeFixture()
    const analysis = deferredValue<RetakeBatchResult>()
    let batchOptions: RetakeBatchOptions | undefined
    harness.analyzeRetakes.mockImplementation(
      (
        receivedTranscript: Transcript,
        sourceDurationMs: number,
        options: RetakeBatchOptions,
      ) => {
        expect(receivedTranscript).toBe(transcript)
        expect(sourceDurationMs).toBe(10_000)
        batchOptions = options
        options.onProgress?.({ completed: 0, total: 1 })
        return analysis.promise
      },
    )
    harness.extractAudio.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
    )
    harness.transcribe.mockResolvedValue(transcript)
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      clipboard: { writeText: clipboardWrite },
    })

    let view = selectSource(file, 'blob:source', 10)
    expect(() =>
      findComponent<RetakesPanelProps>(
        view,
        RetakesPanel,
        'retakes panel',
      ),
    ).toThrow('Could not find retakes panel.')
    await findButton(view, 'Transcribe').props.onClick?.()
    expect(harness.analyzeRetakes).not.toHaveBeenCalled()
    const editor = editorReducerRecord()
    type EditorStateView = {
      edl: EDL | null
      history: unknown[]
      retakes: RetakeEditorState
    }
    const state = () => editor.state as EditorStateView
    const initialEdl = state().edl
    if (initialEdl === null) throw new Error('Expected an initialized EDL.')
    editor.dispatch({
      type: 'commit-edl',
      edl: applyRemovedRange({
        ...initialEdl,
        captions: [{ id: 'caption', start: 0, end: 6, text: 'Existing caption.' }],
      }, 0.5, 5),
    })
    editor.dispatch({
      type: 'commit-overlays',
      action: {
        type: 'add-overlay-asset',
        asset: {
          id: 'image', kind: 'image', name: 'image.png', mimeType: 'image/png',
          width: 640, height: 480, src: 'blob:image',
        },
      },
    })
    editor.dispatch({
      type: 'commit-overlays',
      action: {
        type: 'add-image-overlay',
        overlay: {
          id: 'overlay', assetId: 'image', startSourceMs: 0, endSourceMs: 7_000,
          x: 0, y: 0, width: 0.5, height: 0.5, fit: 'contain', opacity: 1,
          zIndex: 0, fadeInMs: 100, fadeOutMs: 200,
        },
      },
    })
    view = renderApp()
    let panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    const edlBefore = state().edl
    const historyBefore = state().history
    if (edlBefore === null) throw new Error('Expected the cut EDL.')
    expect(ranges(edlBefore)).toEqual([
      [0, 0.5],
      [5, 10],
    ])

    // Carry the actual App export props through the real pure caption,
    // overlay, and audio-cleanup builders. Advice overlaps a removed source
    // range; neither its existence nor workflow may alter these outputs.
    const transcriptBefore = structuredClone(transcript)
    const exportPropsBefore = findComponent<ExportButtonProps>(
      view, ExportButton, 'export button',
    ).props
    const exportInputsBefore = structuredClone(exportInputs(exportPropsBefore))
    function exportSnapshot(props: ExportButtonProps) {
      const captions = prepareCaptionsForExport(props.edl.captions, props.edl)
      const overlays = buildImageOverlayRenderPlanForEdl(
        props.edl, props.imageOverlays, props.overlayAssets,
      )
      const imageOverlayGraph = buildImageOverlayFilterGraph(
        overlays, props.overlayAssets,
        { frameWidth: props.edl.source.width!, frameHeight: props.edl.source.height! },
      )
      return {
        duration: totalKeptDuration(props.edl),
        captions,
        srt: buildSrt(captions),
        overlays,
        args: buildExportArgs(props.edl.segments, 'input.mp4', 'output.mp4', {
          srtFile: 'captions.srt',
          imageOverlayGraph,
          audioCleanup: buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
        }),
      }
    }
    const exportBefore = exportSnapshot(exportPropsBefore)
    expect(exportBefore.duration).toBe(5.5)
    expect(exportBefore.captions).toMatchObject([{ start: 0, end: 1.5 }])
    expect(exportBefore.overlays).toMatchObject([
      { outputStartMs: 0, outputEndMs: 500 },
      { outputStartMs: 500, outputEndMs: 2_500 },
    ])
    expect(exportBefore.args.join(' ')).toContain('afftdn=')
    expect(exportBefore.args.join(' ')).toContain('subtitles=')
    function expectRetakesOnly() {
      const currentView = renderApp()
      const props = findComponent<ExportButtonProps>(
        currentView, ExportButton, 'export button',
      ).props
      expect(exportInputs(props)).toEqual(exportInputsBefore)
      expect(props.edl).toBe(edlBefore)
      expect(props.imageOverlays).toBe(exportPropsBefore.imageOverlays)
      expect(exportSnapshot(props)).toEqual(exportBefore)
      expect(transcript).toEqual(transcriptBefore)
      expect(findComponent<TranscriptProps>(
        currentView, TranscriptView, 'transcript',
      ).props.transcript).toBe(transcript)
      expect(state().history).toBe(historyBefore)
    }

    const pending = panel.props.onAnalyze()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(harness.analyzeRetakes).toHaveBeenCalledOnce()
    expect(panel.props).toMatchObject({
      analysisStatus: 'analyzing',
      analysisProgress: { completed: 0, total: 1 },
    })
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    batchOptions?.onProgress?.({ completed: 1, total: 1 })
    analysis.resolve({
      candidateCount: 1,
      analyzedCount: 1,
      recommendations: [recommendation],
    })
    await pending
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props).toMatchObject({
      recommendations: [recommendation],
      analysisStatus: 'complete',
      analysisProgress: { completed: 1, total: 1 },
      hasSuccessfulEmptyAnalysis: false,
    })
    expectRetakesOnly()

    const media: VideoLike = {
      currentSrc: 'blob:source',
      currentTime: 0,
      duration: 10,
      pause: vi.fn(),
      paused: true,
      play: vi.fn(),
      videoHeight: 1080,
      videoWidth: 1920,
    }
    media.play = vi.fn().mockImplementation(async () => {
      media.paused = false
    })
    media.pause = vi.fn().mockImplementation(() => {
      media.paused = true
    })
    const videoRef = findVideo(view).props.ref
    if (videoRef === undefined) throw new Error('Expected the video ref.')
    videoRef.current = media

    let retakeTrack = findComponent<RetakeTimelineTrackProps>(
      view,
      RetakeTimelineTrack,
      'retake timeline track',
    )
    expect(retakeTrack.props).toMatchObject({
      recommendations: [recommendation],
      selectedRecommendationId: null,
      sourceDurationMs: 10_000,
    })
    retakeTrack.props.onSelectRecommendation(recommendation.id)
    retakeTrack.props.onSeekSourceMs(recommendation.startSourceMs)
    view = renderApp()
    retakeTrack = findComponent<RetakeTimelineTrackProps>(
      view,
      RetakeTimelineTrack,
      'retake timeline track',
    )
    expect(retakeTrack.props.selectedRecommendationId).toBe(
      recommendation.id,
    )
    expect(media.currentTime).toBe(1)
    expect(
      findComponent<TimelineProps>(view, Timeline, 'timeline').props.playhead,
    ).toBe(1)
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    await panel.props.onPlaySourceRange(
      recommendation.startSourceMs,
      recommendation.endSourceMs,
    )
    expect(media.currentTime).toBe(1)
    expect(media.play).toHaveBeenCalledOnce()
    findVideo(view).props.onPlay?.({ currentTarget: media })
    expect(media.currentTime).toBe(1)

    media.currentTime = 4.8
    findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
    expect(media.pause).not.toHaveBeenCalled()
    media.currentTime = 4.91
    findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
    expect(media.currentTime).toBe(4.9)
    expect(media.pause).toHaveBeenCalledOnce()

    view = renderApp()
    expect(
      findComponent<TimelineProps>(view, Timeline, 'timeline').props.playhead,
    ).toBe(4.9)
    media.paused = false
    media.currentTime = 2
    findVideo(view).props.onPlay?.({ currentTarget: media })
    expect(media.currentTime).toBe(5)

    const rejectedPlay = vi.fn().mockRejectedValue(
      new Error('Playback was blocked.'),
    )
    media.paused = true
    media.play = rejectedPlay
    await panel.props.onPlaySourceRange(
      recommendation.startSourceMs,
      recommendation.endSourceMs,
    )
    expect(media.currentTime).toBe(1)
    expect(rejectedPlay).toHaveBeenCalledOnce()
    media.paused = false
    findVideo(view).props.onPlay?.({ currentTarget: media })
    expect(media.currentTime).toBe(5)

    const copyPending = panel.props.onCopyScript(
      recommendation.id,
      recommendation.suggestedScript!,
    )
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.copyFeedback).toEqual({
      recommendationId: recommendation.id,
      status: 'copying',
    })
    await copyPending
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.copyFeedback).toEqual({
      recommendationId: recommendation.id,
      status: 'copied',
    })
    expect(clipboardWrite).toHaveBeenCalledWith(
      recommendation.suggestedScript,
    )
    expectRetakesOnly()

    clipboardWrite.mockRejectedValueOnce(new Error('Clipboard denied.'))
    await panel.props.onCopyScript(
      recommendation.id,
      recommendation.suggestedScript!,
    )
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.copyFeedback).toEqual({
      recommendationId: recommendation.id,
      status: 'error',
    })
    expect(state().retakes.retakeAnalysisStatus).toBe('complete')
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    const lateCopy = deferredValue<void>()
    clipboardWrite.mockImplementationOnce(() => lateCopy.promise)
    const lateCopyPending = panel.props.onCopyScript(
      recommendation.id,
      recommendation.suggestedScript!,
    )
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.copyFeedback?.status).toBe('copying')
    panel.props.onResolve(recommendation.id)
    expect(state().retakes.retakeRecommendations[0].status).toBe(
      'resolved',
    )
    lateCopy.resolve(undefined)
    await lateCopyPending
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props).toMatchObject({
      recommendations: [],
      copyFeedback: null,
      hasSuccessfulEmptyAnalysis: false,
    })
    retakeTrack = findComponent<RetakeTimelineTrackProps>(
      view,
      RetakeTimelineTrack,
      'retake timeline track',
    )
    expect(retakeTrack.props).toMatchObject({
      recommendations: [],
      selectedRecommendationId: null,
    })
    expect(media.currentSrc).toBe('blob:source')
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)
    expectRetakesOnly()

    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'set-retake-recommendations',
        recommendations: [recommendation],
      },
    })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    panel.props.onDismiss(recommendation.id)
    expect(state().retakes.retakeRecommendations[0].status).toBe(
      'dismissed',
    )
    expectRetakesOnly()
    view = renderApp()
    retakeTrack = findComponent<RetakeTimelineTrackProps>(
      view,
      RetakeTimelineTrack,
      'retake timeline track',
    )
    expect(retakeTrack.props).toMatchObject({
      recommendations: [],
      selectedRecommendationId: null,
    })
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    harness.analyzeRetakes.mockResolvedValueOnce({
      candidateCount: 2,
      analyzedCount: 1,
      recommendations: [recommendation],
    })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    await panel.props.onAnalyze()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(state().retakes).toMatchObject({
      retakeAnalysisStatus: 'complete',
      retakeAnalysisProgress: { completed: 1, failed: 1, total: 2 },
      retakeRecommendations: [{ status: 'open' }],
    })
    expect(state().retakes).not.toHaveProperty('retakeAnalysisError')
    expect(panel.props).toMatchObject({
      recommendations: [recommendation],
      analysisStatus: 'complete',
      analysisProgress: { completed: 1, failed: 1, total: 2 },
      analysisError: undefined,
      hasSuccessfulEmptyAnalysis: false,
    })
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    harness.analyzeRetakes.mockImplementationOnce(
      async (
        _transcript: Transcript,
        _sourceDurationMs: number,
        options: RetakeBatchOptions,
      ) => {
        options.onProgress?.({ completed: 0, failed: 2, total: 2 })
        throw new Error('Retake request failed.')
      },
    )
    await panel.props.onAnalyze()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(state().retakes).toMatchObject({
      retakeAnalysisStatus: 'error',
      retakeAnalysisProgress: { completed: 0, failed: 2, total: 2 },
      retakeAnalysisError: 'Retake request failed.',
      retakeRecommendations: [{ status: 'open' }],
    })
    expect(panel.props.analysisError).toBe('Retake request failed.')
    expectRetakesOnly()
    expect(panel.props.analysisProgress).toEqual({
      completed: 0,
      failed: 2,
      total: 2,
    })
    expect(panel.props.recommendations).toEqual([recommendation])
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)

    const withoutProof = { ...recommendation }
    delete withoutProof.transcriptFingerprints
    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'set-retake-recommendations',
        recommendations: [withoutProof],
      },
    })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.recommendations).toEqual([])
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(false)
    expect(
      findComponent<RetakeTimelineTrackProps>(
        view,
        RetakeTimelineTrack,
        'retake timeline track',
      ).props.recommendations,
    ).toEqual([])

    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'set-retake-recommendations',
        recommendations: [recommendation],
      },
    })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.recommendations).toHaveLength(1)

    const changedTranscript: Transcript = {
      words: transcript.words.map((word, index) =>
        index === 1 ? { ...word, text: 'workspace' } : { ...word },
      ),
    }
    harness.transcribe.mockResolvedValueOnce(changedTranscript)
    await findButton(view, 'Transcribe Again').props.onClick?.()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.recommendations).toEqual([])
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(false)
    expect(
      findComponent<RetakeTimelineTrackProps>(
        view,
        RetakeTimelineTrack,
        'retake timeline track',
      ).props.recommendations,
    ).toEqual([])
    expect(state().retakes.retakeRecommendations).toHaveLength(1)
  })

  it('shows a successful empty result only for the fully checked current source transcript', async () => {
    const file = { name: 'source.mp4' } as File
    const transcript: Transcript = {
      words: [
        { text: 'A', start: 0, end: 0.4 },
        { text: 'clean', start: 0.5, end: 0.9 },
        { text: 'take.', start: 1, end: 1.4 },
      ],
    }
    const audio = new Blob([new Uint8Array([1])], {
      type: 'audio/mpeg',
    })
    harness.extractAudio.mockResolvedValue(audio)
    harness.transcribe.mockResolvedValue(transcript)
    harness.analyzeRetakes.mockResolvedValue({
      candidateCount: 0,
      analyzedCount: 0,
      recommendations: [],
    })

    let view = selectSource(file, 'blob:source', 10)
    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    let panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(false)

    const editor = editorReducerRecord()
    type EditorStateView = {
      edl: EDL | null
      history: unknown[]
      retakes: RetakeEditorState
    }
    const state = () => editor.state as EditorStateView
    const edlBefore = state().edl
    const historyBefore = state().history

    await panel.props.onAnalyze()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(harness.analyzeRetakes).toHaveBeenCalledWith(
      transcript,
      10_000,
      expect.any(Object),
    )
    expect(panel.props).toMatchObject({
      recommendations: [],
      analysisStatus: 'complete',
      analysisProgress: { completed: 0, total: 0 },
      hasSuccessfulEmptyAnalysis: true,
    })
    expect(state().retakes.retakeRecommendations).toEqual([])
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)
    expect(
      findComponent<RetakeTimelineTrackProps>(
        view,
        RetakeTimelineTrack,
        'retake timeline track',
      ).props.recommendations,
    ).toEqual([])

    if (edlBefore === null) throw new Error('Expected an initialized EDL.')
    editor.dispatch({
      type: 'commit-edl',
      edl: applyRemovedRange(edlBefore, 2, 3),
    })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(true)
    editor.dispatch({ type: 'undo' })
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(true)
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toEqual(historyBefore)

    // A new transcript generation invalidates the claim even if a test double
    // returns the same object: the new transcript has not itself been checked.
    await findButton(view, 'Transcribe Again').props.onClick?.()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props.hasSuccessfulEmptyAnalysis).toBe(false)
    expect(state().retakes).toMatchObject({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toEqual(historyBefore)

    harness.analyzeRetakes.mockResolvedValueOnce({
      candidateCount: 2,
      analyzedCount: 1,
      recommendations: [],
    })
    await panel.props.onAnalyze()
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props).toMatchObject({
      recommendations: [],
      analysisStatus: 'complete',
      analysisProgress: { completed: 1, failed: 1, total: 2 },
      analysisError: undefined,
      hasSuccessfulEmptyAnalysis: false,
    })

    const nextAnalysis = deferredValue<RetakeBatchResult>()
    harness.analyzeRetakes.mockClear()
    harness.analyzeRetakes.mockReturnValueOnce(nextAnalysis.promise)
    const firstStart = panel.props.onAnalyze()
    const blockedStart = panel.props.onAnalyze()
    await blockedStart
    expect(harness.analyzeRetakes).toHaveBeenCalledOnce()

    nextAnalysis.resolve({
      candidateCount: 0,
      analyzedCount: 0,
      recommendations: [],
    })
    await firstStart
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    harness.analyzeRetakes.mockResolvedValueOnce({
      candidateCount: 0,
      analyzedCount: 0,
      recommendations: [],
    })
    await panel.props.onAnalyze()
    expect(harness.analyzeRetakes).toHaveBeenCalledTimes(2)
  })

  it('lets a new transcript analysis win every stale callback from the prior run', async () => {
    const file = { name: 'source.mp4' } as File
    const firstTranscript: Transcript = {
      words: [
        { text: 'First', start: 0, end: 0.4 },
        { text: 'version.', start: 0.5, end: 0.9 },
      ],
    }
    const secondTranscript: Transcript = {
      words: [
        { text: 'Second', start: 0, end: 0.4 },
        { text: 'version.', start: 0.5, end: 0.9 },
      ],
    }
    const staleRecommendation: RetakeRecommendation = {
      id: 'stale-first-result',
      startSourceMs: 0,
      endSourceMs: 900,
      reason: 'unclear-explanation',
      severity: 'recommended',
      title: 'Stale first result',
      explanation: 'This belongs only to the first transcript.',
      confidence: 0.8,
      status: 'open',
    }
    const firstAnalysis = deferredValue<RetakeBatchResult>()
    const secondAnalysis = deferredValue<RetakeBatchResult>()
    let firstOptions: RetakeBatchOptions | undefined
    let secondOptions: RetakeBatchOptions | undefined

    harness.extractAudio.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
    )
    harness.transcribe
      .mockResolvedValueOnce(firstTranscript)
      .mockResolvedValueOnce(secondTranscript)
    harness.analyzeRetakes.mockImplementation(
      (
        receivedTranscript: Transcript,
        _sourceDurationMs: number,
        options: RetakeBatchOptions,
      ) => {
        if (receivedTranscript === firstTranscript) {
          firstOptions = options
          return firstAnalysis.promise
        }
        if (receivedTranscript === secondTranscript) {
          secondOptions = options
          return secondAnalysis.promise
        }
        throw new Error('Unexpected analysis transcript.')
      },
    )

    let view = selectSource(file, 'blob:source', 10)
    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    let panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    const editor = editorReducerRecord()
    type EditorStateView = {
      edl: EDL | null
      history: unknown[]
      retakes: RetakeEditorState
    }
    const state = () => editor.state as EditorStateView
    const edlBefore = state().edl
    const historyBefore = state().history

    const firstPending = panel.props.onAnalyze()
    expect(firstOptions?.signal?.aborted).toBe(false)

    // A successful replacement invalidates the old token before aborting it,
    // resets lifecycle state, and makes a new run possible after rerender.
    await findButton(view, 'Transcribe Again').props.onClick?.()
    expect(firstOptions?.signal?.aborted).toBe(true)
    expect(state().retakes.retakeAnalysisStatus).toBe('idle')
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    const secondRunTrigger = panel.props.onAnalyze
    const secondPending = secondRunTrigger()
    expect(harness.analyzeRetakes).toHaveBeenCalledTimes(2)
    expect(secondOptions?.signal?.aborted).toBe(false)

    secondOptions?.onProgress?.({ completed: 0, total: 2 })
    firstOptions?.onProgress?.({ completed: 1, total: 1 })
    expect(state().retakes).toMatchObject({
      retakeAnalysisStatus: 'analyzing',
      retakeAnalysisProgress: { completed: 0, total: 2 },
    })

    // The stale success executes its return/finally while B is still pending.
    // Reusing B's pre-start callback then proves A's finally did not unlock B.
    firstAnalysis.resolve({
      candidateCount: 1,
      analyzedCount: 1,
      recommendations: [staleRecommendation],
    })
    await firstPending
    await secondRunTrigger()
    expect(harness.analyzeRetakes).toHaveBeenCalledTimes(2)
    expect(state().retakes).toMatchObject({
      retakeAnalysisStatus: 'analyzing',
      retakeAnalysisProgress: { completed: 0, total: 2 },
      retakeRecommendations: [],
    })

    secondOptions?.onProgress?.({ completed: 2, total: 2 })
    secondAnalysis.resolve({
      candidateCount: 2,
      analyzedCount: 2,
      recommendations: [],
    })
    await secondPending
    view = renderApp()
    panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    expect(panel.props).toMatchObject({
      recommendations: [],
      analysisStatus: 'complete',
      analysisProgress: { completed: 2, total: 2 },
      analysisError: undefined,
      hasSuccessfulEmptyAnalysis: true,
    })
    expect(state().retakes.retakeRecommendations).toEqual([])
    expect(state().edl).toBe(edlBefore)
    expect(state().history).toBe(historyBefore)
  })

  it.each(['success', 'error'] as const)(
    'ignores an old %s after the newer transcript analysis has completed',
    async (outcome) => {
      const oldAnalysis = deferredValue<RetakeBatchResult>()
      let oldOptions: RetakeBatchOptions | undefined
      const firstTranscript: Transcript = {
        words: [{ text: 'First version.', start: 0, end: 1 }],
      }
      const secondTranscript: Transcript = {
        words: [{ text: 'Second version.', start: 0, end: 1 }],
      }
      harness.extractAudio.mockResolvedValue(new Blob(['audio']))
      harness.transcribe
        .mockResolvedValueOnce(firstTranscript)
        .mockResolvedValueOnce(secondTranscript)
      harness.analyzeRetakes.mockImplementationOnce((
        _transcript: Transcript,
        _durationMs: number,
        options: RetakeBatchOptions,
      ) => {
        oldOptions = options
        return oldAnalysis.promise
      }).mockResolvedValueOnce({
        candidateCount: 2,
        analyzedCount: 2,
        recommendations: [],
      })

      let view = selectSource({ name: 'source.mp4' } as File, 'blob:source', 10)
      await findButton(view, 'Transcribe').props.onClick?.()
      view = renderApp()
      const oldPending = findComponent<RetakesPanelProps>(
        view, RetakesPanel, 'retakes panel',
      ).props.onAnalyze()

      await findButton(view, 'Transcribe Again').props.onClick?.()
      expect(oldOptions?.signal?.aborted).toBe(true)
      view = renderApp()
      await findComponent<RetakesPanelProps>(
        view, RetakesPanel, 'retakes panel',
      ).props.onAnalyze()
      const completedState = editorReducerRecord().state

      // The mock intentionally ignores abort. Both its late progress callback
      // and its eventual success/error must preserve the newer completion.
      oldOptions?.onProgress?.({ completed: 0, failed: 1, total: 1 })
      if (outcome === 'error') {
        oldAnalysis.reject(new Error('Old request failed after the new result.'))
      } else {
        oldAnalysis.resolve({
          candidateCount: 1,
          analyzedCount: 1,
          recommendations: [{
            id: 'old-result', startSourceMs: 0, endSourceMs: 1_000,
            reason: 'incomplete-thought', severity: 'recommended',
            title: 'Old result', explanation: 'Advice from the old transcript.',
            confidence: 0.9, status: 'open',
          }],
        })
      }
      await oldPending
      expect(editorReducerRecord().state).toBe(completedState)
      expect(harness.analyzeRetakes).toHaveBeenNthCalledWith(
        2, secondTranscript, 10_000, expect.any(Object),
      )
      view = renderApp()
      expect(findComponent<RetakesPanelProps>(
        view, RetakesPanel, 'retakes panel',
      ).props).toMatchObject({
        recommendations: [],
        analysisStatus: 'complete',
        analysisProgress: { completed: 2, total: 2 },
        analysisError: undefined,
        hasSuccessfulEmptyAnalysis: true,
      })
    },
  )

  it('aborts and ignores an analysis that outlives its source document', async () => {
    const firstFile = { name: 'first.mp4' } as File
    const secondFile = { name: 'second.mp4' } as File
    const transcript: Transcript = {
      words: [{ text: 'First source.', start: 0, end: 0.8 }],
    }
    const staleRecommendation: RetakeRecommendation = {
      id: 'stale-source-result',
      startSourceMs: 0,
      endSourceMs: 800,
      reason: 'unclear-explanation',
      severity: 'recommended',
      title: 'Stale source result',
      explanation: 'This belongs only to the replaced source.',
      confidence: 0.8,
      status: 'open',
    }
    const analysis = deferredValue<RetakeBatchResult>()
    let options: RetakeBatchOptions | undefined

    harness.extractAudio.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
    )
    harness.transcribe.mockResolvedValue(transcript)
    harness.analyzeRetakes.mockImplementation(
      (
        _transcript: Transcript,
        _sourceDurationMs: number,
        receivedOptions: RetakeBatchOptions,
      ) => {
        options = receivedOptions
        return analysis.promise
      },
    )

    let view = selectSource(firstFile, 'blob:first', 10)
    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    const panel = findComponent<RetakesPanelProps>(
      view,
      RetakesPanel,
      'retakes panel',
    )
    const pending = panel.props.onAnalyze()
    expect(options?.signal?.aborted).toBe(false)

    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:second')
    findFileInput(view).props.onChange?.({ target: { files: [secondFile] } })
    expect(options?.signal?.aborted).toBe(true)
    const editor = editorReducerRecord()
    const state = () =>
      editor.state as {
        edl: EDL | null
        history: unknown[]
        retakes: RetakeEditorState
      }
    expect(state().retakes).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })

    options?.onProgress?.({ completed: 1, total: 1 })
    analysis.resolve({
      candidateCount: 1,
      analyzedCount: 1,
      recommendations: [staleRecommendation],
    })
    await pending
    expect(state().edl).toBeNull()
    expect(state().history).toEqual([])
    expect(state().retakes).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
  })

  it('stores retake advice outside EDL Undo and clears it with the source document', () => {
    const file = { name: 'source.mp4' } as File
    selectSource(file, 'blob:source', 10)
    const editor = editorReducerRecord()
    type EditorStateView = {
      edl: EDL | null
      history: unknown[]
      retakes: RetakeEditorState
    }
    const state = () => editor.state as EditorStateView
    const recommendation: RetakeRecommendation = {
      id: 'retake_1000_3000_severe-stumble',
      startSourceMs: 1_000,
      endSourceMs: 3_000,
      reason: 'severe-stumble',
      severity: 'recommended',
      title: 'Severe stumble',
      explanation: 'The restart leaves no complete clean take.',
      confidence: 0.9,
      status: 'open',
    }

    expect(state().retakes).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'set-retake-analysis-state',
        status: 'error',
        progress: { completed: 1, total: 2 },
        error: 'One section could not be analyzed.',
      },
    })
    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'set-retake-recommendations',
        recommendations: [recommendation],
      },
    })
    expect(state().history).toEqual([])
    expect(state().edl).not.toHaveProperty('retakeRecommendations')

    const originalEdl = state().edl
    if (originalEdl === null) throw new Error('Expected an initialized EDL.')
    editor.dispatch({
      type: 'commit-edl',
      edl: {
        ...originalEdl,
        segments: [
          { ...originalEdl.segments[0], start: 2, end: 10 },
        ],
      },
    })
    editor.dispatch({
      type: 'update-retakes',
      action: {
        type: 'dismiss-retake-recommendation',
        id: recommendation.id,
      },
    })
    expect(state().history).toHaveLength(1)

    editor.dispatch({ type: 'undo' })
    expect(state().edl).toBe(originalEdl)
    expect(state().history).toEqual([])
    expect(state().retakes.retakeRecommendations[0].status).toBe(
      'dismissed',
    )
    expect(state().retakes).toMatchObject({
      retakeAnalysisStatus: 'error',
      retakeAnalysisProgress: { completed: 1, total: 2 },
      retakeAnalysisError: 'One section could not be analyzed.',
    })

    editor.dispatch({ type: 'reset-document' })
    expect(state().edl).toBeNull()
    expect(state().history).toEqual([])
    expect(state().retakes).toEqual({
      retakeRecommendations: [],
      retakeAnalysisStatus: 'idle',
    })
  })

  it('keeps upload, URL replacement, preload, and metadata initialization connected', () => {
    const first = { name: 'first.mp4' } as File
    const second = { name: 'second.mov' } as File
    const createObjectUrl = vi.mocked(URL.createObjectURL)
    createObjectUrl
      .mockReset()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')

    let view = renderApp()
    const input = findFileInput(view)
    expect(input.props.accept).toBe('video/*')
    input.props.onChange?.({ target: { files: [first] } })

    view = renderApp()
    // The custom transport replaces native controls.
    expect(findVideo(view).props).toMatchObject({ src: 'blob:first' })
    expect(findVideo(view).props.controls).toBeUndefined()
    findFileInput(view).props.onChange?.({ target: { files: [second] } })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first')
    expect(harness.loadFfmpeg).toHaveBeenCalledTimes(2)
    view = renderApp()
    const video = findVideo(view)
    expect(video.props.src).toBe('blob:second')
    const media: VideoLike = {
      currentSrc: 'blob:second',
      currentTime: 0,
      duration: 8,
      pause: vi.fn(),
      paused: true,
      play: vi.fn().mockResolvedValue(undefined),
      videoHeight: 720,
      videoWidth: 1280,
    }
    video.props.onLoadedMetadata?.({ currentTarget: media })

    view = renderApp()
    const timeline = findComponent<TimelineProps>(view, Timeline, 'timeline')
    expect(timeline.props.edl.source).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      url: 'blob:second',
      duration: 8,
      width: 1280,
      height: 720,
    })
    expect(ranges(timeline.props.edl)).toEqual([[0, 8]])
    expect(
      findComponent<ExportButtonProps>(view, ExportButton, 'export button')
        .props.file,
    ).toBe(second)
  })

  it('keeps reversed trims, Undo, middle deletion, and source-time playback aligned', () => {
    const file = { name: 'source.mp4' } as File
    let view = selectSource(file, 'blob:source', 10)
    let video = findVideo(view)
    const media: VideoLike = {
      currentSrc: 'blob:source',
      currentTime: 8,
      duration: 10,
      pause: vi.fn(),
      paused: true,
      play: vi.fn().mockResolvedValue(undefined),
      videoHeight: 1080,
      videoWidth: 1920,
    }

    video.props.onTimeUpdate?.({ currentTarget: media })
    view = renderApp()
    findButton(view, 'Set In').props.onClick?.()
    media.currentTime = 2
    findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
    view = renderApp()
    findButton(view, 'Set Out').props.onClick?.()
    view = renderApp()
    findButton(view, 'Trim to Range').props.onClick?.()

    view = renderApp()
    expect(
      ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl),
    ).toEqual([[2, 8]])
    findButton(view, 'Undo').props.onClick?.()
    view = renderApp()
    expect(
      ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl),
    ).toEqual([[0, 10]])

    media.currentTime = 3
    findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
    view = renderApp()
    findButton(view, 'Set In').props.onClick?.()
    media.currentTime = 6
    findVideo(view).props.onTimeUpdate?.({ currentTarget: media })
    view = renderApp()
    findButton(view, 'Set Out').props.onClick?.()
    view = renderApp()
    findButton(view, 'Delete Range').props.onClick?.()

    view = renderApp()
    expect(
      ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl),
    ).toEqual([
      [0, 3],
      [6, 10],
    ])

    media.paused = false
    media.currentTime = 4
    video = findVideo(view)
    video.props.onPlay?.({ currentTarget: media })
    expect(media.currentTime).toBe(6)
    media.currentTime = 10
    video.props.onTimeUpdate?.({ currentTarget: media })
    expect(media.pause).toHaveBeenCalledOnce()
  })

  it('keeps transcript deletion, caption generation, editing, preview, export, and Undo on one EDL', async () => {
    const file = { name: 'source.mp4' } as File
    const transcript: Transcript = {
      words: [
        { text: 'Hello', start: 0, end: 0.8 },
        { text: 'um', start: 1, end: 2 },
        { text: 'world', start: 2.2, end: 3 },
      ],
    }
    const audio = new Blob([new Uint8Array([1])], { type: 'audio/mpeg' })
    harness.extractAudio.mockResolvedValue(audio)
    harness.transcribe.mockResolvedValue(transcript)
    let view = selectSource(file, 'blob:source', 10)

    await findButton(view, 'Transcribe').props.onClick?.()
    view = renderApp()
    let transcriptView = findComponent<TranscriptProps>(
      view,
      TranscriptView,
      'transcript',
    )
    transcriptView.props.onDeleteRange(1, 2)

    view = renderApp()
    expect(
      ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl),
    ).toEqual([
      [0, 1],
      [2, 10],
    ])
    transcriptView = findComponent<TranscriptProps>(
      view,
      TranscriptView,
      'transcript',
    )
    transcriptView.props.onDeleteRange(0, 10)
    view = renderApp()
    expect(
      ranges(findComponent<TimelineProps>(view, Timeline, 'timeline').props.edl),
    ).toEqual([
      [0, 1],
      [2, 10],
    ])

    findButton(view, 'Generate Captions').props.onClick?.()
    view = renderApp()
    let captionList = findComponent<CaptionListProps>(
      view,
      CaptionList,
      'caption list',
    )
    expect(captionList.props.captions.map((caption) => caption.text)).toEqual([
      'Hello world',
    ])
    const captionId = captionList.props.captions[0].id
    captionList.props.onEditText(captionId, 'Corrected SDK name')

    view = renderApp()
    captionList = findComponent<CaptionListProps>(
      view,
      CaptionList,
      'caption list',
    )
    expect(captionList.props.captions[0].text).toBe('Corrected SDK name')
    expect(
      findComponent<CaptionOverlayProps>(
        view,
        CaptionOverlay,
        'caption overlay',
      ).props.captions[0].text,
    ).toBe('Corrected SDK name')
    expect(
      findComponent<ExportButtonProps>(view, ExportButton, 'export button')
        .props.edl.captions[0].text,
    ).toBe('Corrected SDK name')

    findButton(view, 'Undo').props.onClick?.()
    view = renderApp()
    expect(
      findComponent<CaptionListProps>(view, CaptionList, 'caption list').props
        .captions[0].text,
    ).toBe('Hello world')
    expect(harness.extractAudio).toHaveBeenCalledWith(file)
    expect(harness.transcribe).toHaveBeenCalledWith(audio)
  })
})
