import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import Timeline from './Timeline'
import CaptionList from './captions/CaptionList'
import CaptionOverlay from './captions/CaptionOverlay'
import type { Caption, EDL } from './edl/types'
import ExportButton from './export/ExportButton'
import TranscriptView from './transcript/Transcript'
import type { Transcript } from './transcript/types'

type StateRecord = {
  kind: 'state'
  setter: ReturnType<typeof vi.fn>
  value: unknown
}

type ReducerRecord = {
  kind: 'reducer'
  dispatch: ReturnType<typeof vi.fn>
  reducer: (state: unknown, action: unknown) => unknown
  state: unknown
}

type RefRecord = {
  kind: 'ref'
  ref: { current: unknown }
}

type EffectRecord = { kind: 'effect' }
type HookRecord = StateRecord | ReducerRecord | RefRecord | EffectRecord

const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as HookRecord[],
  useState: vi.fn(),
  useReducer: vi.fn(),
  useRef: vi.fn(),
  useEffect: vi.fn(),
  loadFfmpeg: vi.fn(),
  extractAudio: vi.fn(),
  transcribe: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: harness.useState,
    useReducer: harness.useReducer,
    useRef: harness.useRef,
    useEffect: harness.useEffect,
  }
})

vi.mock('./ffmpeg/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ffmpeg/engine')>()
  return { ...actual, loadFfmpeg: harness.loadFfmpeg }
})

vi.mock('./transcript/extractAudio', () => ({
  extractAudio: harness.extractAudio,
}))

vi.mock('./transcript/api', () => ({ transcribe: harness.transcribe }))

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
  videoHeight: number
  videoWidth: number
}

type VideoProps = NodeProps & {
  controls?: boolean
  onLoadedMetadata?: (event: { currentTarget: VideoLike }) => void
  onPlay?: (event: { currentTarget: VideoLike }) => void
  onTimeUpdate?: (event: { currentTarget: VideoLike }) => void
  src?: string
}

type TimelineProps = NodeProps & { edl: EDL }

type TranscriptProps = NodeProps & {
  edl: EDL
  onDeleteRange: (start: number, end: number) => void
}

type CaptionListProps = NodeProps & {
  captions: Caption[]
  onEditText: (id: string, text: string) => void
}

type CaptionOverlayProps = NodeProps & { captions: Caption[] }
type ExportButtonProps = NodeProps & { edl: EDL; file: File | null }

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

function findButton(node: ReactNode, label: string): ReactElement<ButtonProps> {
  return findNode(
    node,
    (element) =>
      element.type === 'button' &&
      Children.toArray(element.props.children).join('') === label,
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
  return App()
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
    videoHeight: 1080,
    videoWidth: 1920,
  }
  findVideo(view).props.onLoadedMetadata?.({ currentTarget: media })
  return renderApp()
}

beforeEach(() => {
  harness.cursor = 0
  harness.slots.length = 0
  harness.loadFfmpeg.mockReset().mockResolvedValue(undefined)
  harness.extractAudio.mockReset()
  harness.transcribe.mockReset()
  harness.useState.mockReset()
  harness.useReducer.mockReset()
  harness.useRef.mockReset()
  harness.useEffect.mockReset()

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
          dispatch: vi.fn(),
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

  harness.useEffect.mockImplementation(() => {
    const index = harness.cursor++
    const record = harness.slots[index]
    if (record === undefined) {
      harness.slots[index] = { kind: 'effect' }
      return
    }
    if (record.kind !== 'effect') {
      throw new Error(`Hook slot ${index} changed kind.`)
    }
  })

  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    '00000000-0000-4000-8000-000000000001',
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('App regression wiring', () => {
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
    expect(findVideo(view).props).toMatchObject({
      controls: true,
      src: 'blob:first',
    })
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
    findButton(view, 'Trim to selection').props.onClick?.()

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
    findButton(view, 'Delete range').props.onClick?.()

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

    findButton(view, 'Generate captions').props.onClick?.()
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
