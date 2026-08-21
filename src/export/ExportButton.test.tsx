import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EDL } from '../edl/types'
import type { ImageOverlay, OverlayAsset } from '../overlays/types'
import AudioCleanupControls from './AudioCleanupControls'
import ExportButton from './ExportButton'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS } from './audioCleanupSettings'

const harness = vi.hoisted(() => ({
  getFfmpeg: vi.fn(),
  loadFfmpeg: vi.fn(),
  runExport: vi.fn(),
  useState: vi.fn(),
  stateSetters: [] as Array<ReturnType<typeof vi.fn>>,
  stateOverrides: new Map<number, unknown>(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: harness.useState }
})
vi.mock('../ffmpeg/engine', () => ({
  getFfmpeg: harness.getFfmpeg,
  loadFfmpeg: harness.loadFfmpeg,
}))
vi.mock('./ffmpeg', () => ({ runExport: harness.runExport }))

const EDL_FIXTURE: EDL = {
  version: 1,
  source: {
    id: 'source',
    url: 'blob:source',
    duration: 4,
    width: 1280,
    height: 720,
  },
  segments: [{ id: 'seg_0_4', start: 0, end: 4 }],
  captions: [],
}

const CAPTIONED_EDL_FIXTURE: EDL = {
  ...EDL_FIXTURE,
  captions: [
    {
      id: 'cap_0_25_1_25',
      text: 'Keep this caption',
      start: 0.25,
      end: 1.25,
    },
  ],
}

const OVERLAY_ASSET_FIXTURE: OverlayAsset = {
  id: 'asset_logo',
  kind: 'image',
  name: 'logo.png',
  mimeType: 'image/png',
  width: 400,
  height: 200,
  src: 'blob:logo',
}

const IMAGE_OVERLAY_FIXTURE: ImageOverlay = {
  id: 'overlay_logo',
  assetId: OVERLAY_ASSET_FIXTURE.id,
  startSourceMs: 1_000,
  endSourceMs: 3_000,
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.25,
  fit: 'contain',
  opacity: 0.6,
  zIndex: 2,
  fadeInMs: 250,
  fadeOutMs: 500,
}

type ButtonProps = {
  children?: ReactNode
  disabled?: boolean
  onClick?: () => void
}

type CheckboxProps = {
  checked?: boolean
  children?: ReactNode
  onChange?: (event: { target: { checked: boolean } }) => void
  type?: string
}

function findButton(node: ReactNode, label: string): ReactElement<ButtonProps> {
  if (!isValidElement(node)) {
    throw new Error(`Could not find button "${label}".`)
  }
  const element = node as ReactElement<ButtonProps>
  if (
    element.type === 'button' &&
    Children.toArray(element.props.children).join('') === label
  ) {
    return element
  }
  for (const child of Children.toArray(element.props.children)) {
    if (!isValidElement(child)) {
      continue
    }
    try {
      return findButton(child, label)
    } catch {
      // Keep walking sibling branches.
    }
  }
  throw new Error(`Could not find button "${label}".`)
}

function findAudioCleanupControls(
  node: ReactNode,
): ReactElement<ComponentProps<typeof AudioCleanupControls>> {
  if (!isValidElement(node)) {
    throw new Error('Could not find AudioCleanupControls.')
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.type === AudioCleanupControls) {
    return element as ReactElement<ComponentProps<typeof AudioCleanupControls>>
  }
  for (const child of Children.toArray(element.props.children)) {
    if (!isValidElement(child)) {
      continue
    }
    try {
      return findAudioCleanupControls(child)
    } catch {
      // Keep walking sibling branches.
    }
  }
  throw new Error('Could not find AudioCleanupControls.')
}

function findCheckbox(node: ReactNode): ReactElement<CheckboxProps> {
  if (!isValidElement(node)) {
    throw new Error('Could not find checkbox.')
  }
  const element = node as ReactElement<CheckboxProps>
  if (element.type === 'input' && element.props.type === 'checkbox') {
    return element
  }
  for (const child of Children.toArray(element.props.children)) {
    if (!isValidElement(child)) {
      continue
    }
    try {
      return findCheckbox(child)
    } catch {
      // Keep walking sibling branches.
    }
  }
  throw new Error('Could not find checkbox.')
}

function containsText(node: ReactNode, text: string): boolean {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).includes(text)
  }
  if (!isValidElement(node)) {
    return false
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  return Children.toArray(element.props.children).some((child) =>
    containsText(child, text),
  )
}

function renderExportButton(
  edl: EDL = EDL_FIXTURE,
  stateOverrides: ReadonlyMap<number, unknown> = new Map(),
  overlayAssets: readonly OverlayAsset[] = [],
  imageOverlays: readonly ImageOverlay[] = [],
): ReactElement {
  harness.stateSetters.length = 0
  harness.stateOverrides.clear()
  for (const [index, value] of stateOverrides) {
    harness.stateOverrides.set(index, value)
  }
  return ExportButton({
    edl,
    file: { name: 'source.mp4' } as File,
    overlayAssets,
    imageOverlays,
  })
}

function createFfmpeg(loaded: boolean) {
  type ProgressListener = (event: { progress: number }) => void
  let progressListener: ProgressListener | undefined
  const ffmpeg = {
    loaded,
    on: vi.fn((event: string, listener: ProgressListener) => {
      if (event === 'progress') {
        progressListener = listener
      }
    }),
    off: vi.fn(),
  }
  return {
    ffmpeg,
    emitProgress(progress: number): void {
      progressListener?.({ progress })
    },
    getProgressListener(): ProgressListener | undefined {
      return progressListener
    },
  }
}

beforeEach(() => {
  harness.getFfmpeg.mockReset()
  harness.loadFfmpeg.mockReset()
  harness.runExport.mockReset()
  harness.useState.mockReset()
  harness.useState.mockImplementation((initial: unknown) => {
    const index = harness.stateSetters.length
    const value = harness.stateOverrides.has(index)
      ? harness.stateOverrides.get(index)
      : typeof initial === 'function'
        ? (initial as () => unknown)()
        : initial
    const setter = vi.fn()
    harness.stateSetters.push(setter)
    return [value, setter]
  })
  harness.stateOverrides.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ExportButton orchestration', () => {
  it('does not access FFmpeg while rendering or changing cleanup settings', () => {
    const view = renderExportButton()

    expect(harness.getFfmpeg).not.toHaveBeenCalled()
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.runExport).not.toHaveBeenCalled()

    findAudioCleanupControls(view).props.onChange({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
    })

    expect(harness.stateSetters[5]).toHaveBeenCalledWith({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
    })
    expect(harness.getFfmpeg).not.toHaveBeenCalled()
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.runExport).not.toHaveBeenCalled()
  })

  it('loads lazily, forwards the default cleanup plan, and reports progress', async () => {
    const fake = createFfmpeg(false)
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    })
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:download')
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.loadFfmpeg.mockImplementation(async () => {
      fake.ffmpeg.loaded = true
    })
    harness.runExport.mockImplementation(async () => {
      fake.emitProgress(-0.4)
      fake.emitProgress(1.4)
      return new Blob([new Uint8Array([1])], { type: 'video/mp4' })
    })
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.loadFfmpeg).toHaveBeenCalledOnce()
    expect(harness.loadFfmpeg.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runExport.mock.invocationCallOrder[0],
    )
    expect(harness.runExport).toHaveBeenCalledWith(
      fake.ffmpeg,
      expect.objectContaining({ name: 'source.mp4' }),
      EDL_FIXTURE.segments,
      [],
      expect.any(Function),
      undefined,
      buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS),
    )
    expect(harness.stateSetters[0].mock.calls.map(([value]) => value)).toEqual([
      'loading',
      'encoding',
      'idle',
    ])
    expect(harness.stateSetters[1].mock.calls.map(([value]) => value)).toEqual([
      0,
      0,
      1,
      0,
    ])
    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(createObjectUrl.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: 'video/mp4' }),
    )
    expect(anchor.href).toBe('blob:download')
    expect(anchor.download).toBe('zero-edit-time.mp4')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:download')
    const progressListener = fake.getProgressListener()
    expect(progressListener).toBeDefined()
    expect(fake.ffmpeg.off).toHaveBeenCalledWith(
      'progress',
      progressListener,
    )
  })

  it('downloads a prepared sidecar SRT without touching FFmpeg', async () => {
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:srt-download')
    const revokeObjectUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {})
    const view = renderExportButton(CAPTIONED_EDL_FIXTURE)

    findButton(view, 'Download SRT').props.onClick?.()

    expect(createObjectUrl).toHaveBeenCalledOnce()
    const blob = createObjectUrl.mock.calls[0][0]
    expect(blob).toBeInstanceOf(Blob)
    if (!(blob instanceof Blob)) {
      throw new Error('Expected SRT download to use a Blob.')
    }
    expect(await blob.text()).toBe(
      '1\n00:00:00,250 --> 00:00:01,250\nKeep this caption\n\n',
    )
    expect(blob.type).toBe('text/plain')
    expect(anchor.href).toBe('blob:srt-download')
    expect(anchor.download).toBe('zero-edit-time.srt')
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:srt-download')
    expect(harness.getFfmpeg).not.toHaveBeenCalled()
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.runExport).not.toHaveBeenCalled()
  })

  it('burns prepared captions by default and exposes the opt-out', async () => {
    const fake = createFfmpeg(true)
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'video/mp4' }),
    )
    const view = renderExportButton(CAPTIONED_EDL_FIXTURE)
    const checkbox = findCheckbox(view)

    expect(checkbox.props.checked).toBe(true)
    checkbox.props.onChange?.({ target: { checked: false } })
    expect(harness.stateSetters[4]).toHaveBeenCalledWith(false)

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.runExport.mock.calls[0][3]).toEqual([
      { text: 'Keep this caption', start: 0.25, end: 1.25 },
    ])
  })

  it('passes no burn captions after the caption toggle is off', async () => {
    const fake = createFfmpeg(true)
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'video/mp4' }),
    )
    const stateOverrides = new Map<number, unknown>([[4, false]])
    const view = renderExportButton(CAPTIONED_EDL_FIXTURE, stateOverrides)

    expect(findCheckbox(view).props.checked).toBe(false)
    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.runExport.mock.calls[0][3]).toEqual([])
  })

  it('hides caption controls when none are stored and disables SRT when all are cut', () => {
    const noCaptionsView = renderExportButton()

    expect(() => findCheckbox(noCaptionsView)).toThrow(
      'Could not find checkbox.',
    )
    expect(() => findButton(noCaptionsView, 'Download SRT')).toThrow(
      'Could not find button "Download SRT".',
    )

    const fullyCutCaptionEdl: EDL = {
      ...CAPTIONED_EDL_FIXTURE,
      segments: [{ id: 'seg_2_4', start: 2, end: 4 }],
    }
    const fullyCutView = renderExportButton(fullyCutCaptionEdl)

    expect(findCheckbox(fullyCutView).props.checked).toBe(true)
    expect(findButton(fullyCutView, 'Download SRT').props.disabled).toBe(true)
    expect(
      containsText(
        fullyCutView,
        "Every caption's speech has been cut — nothing to burn or download.",
      ),
    ).toBe(true)
  })

  it('passes the current overlay plan, asset, fades, and frame size to export', async () => {
    const fake = createFfmpeg(true)
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockResolvedValue(
      new Blob([new Uint8Array([1])], { type: 'video/mp4' }),
    )
    const view = renderExportButton(
      EDL_FIXTURE,
      new Map(),
      [OVERLAY_ASSET_FIXTURE],
      [IMAGE_OVERLAY_FIXTURE],
    )

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.runExport.mock.calls[0][5]).toEqual({
      renderPlan: [
        {
          overlayId: 'overlay_logo',
          assetId: 'asset_logo',
          sourceStartMs: 1_000,
          sourceEndMs: 3_000,
          outputStartMs: 1_000,
          outputEndMs: 3_000,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.25,
          fit: 'contain',
          opacity: 0.6,
          zIndex: 2,
          fadeInMs: 250,
          fadeOutMs: 500,
        },
      ],
      assets: [OVERLAY_ASSET_FIXTURE],
      frameWidth: 1280,
      frameHeight: 720,
    })
  })

  it('surfaces export errors and removes the progress listener in finally', async () => {
    const fake = createFfmpeg(true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockRejectedValue(new Error('encode failed'))
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() =>
      expect(harness.stateSetters[2]).toHaveBeenLastCalledWith('encode failed'),
    )
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.stateSetters[0].mock.calls.map(([value]) => value)).toEqual([
      'encoding',
      'idle',
    ])
    const progressListener = fake.getProgressListener()
    expect(progressListener).toBeDefined()
    expect(fake.ffmpeg.off).toHaveBeenCalledWith(
      'progress',
      progressListener,
    )
    expect(consoleError).toHaveBeenCalledWith(
      'Export failed:',
      expect.objectContaining({ message: 'encode failed' }),
    )
  })

  it('shows a successful fallback as a notice rather than a fatal error', async () => {
    const fake = createFfmpeg(true)
    const anchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockImplementation(async (...args: unknown[]) => {
      const onNote = args[4]
      if (typeof onNote === 'function') {
        const notify = onNote as (message: string) => void
        notify(
          'Noise reduction is unavailable in this browser export engine — exported without it.',
        )
      }
      return new Blob([new Uint8Array([1])], { type: 'video/mp4' })
    })
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.stateSetters[3].mock.calls.map(([value]) => value)).toEqual([
      null,
      'Noise reduction is unavailable in this browser export engine — exported without it.',
    ])
    expect(harness.stateSetters[2]).toHaveBeenCalledOnce()
    expect(harness.stateSetters[2]).toHaveBeenCalledWith(null)
  })

  it('surfaces a friendly engine-load error without starting export', async () => {
    const fake = createFfmpeg(false)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.loadFfmpeg.mockRejectedValue(
      new Error('failed to import ffmpeg-core.js from raw CDN URL'),
    )
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() =>
      expect(harness.stateSetters[2]).toHaveBeenLastCalledWith(
        'Could not load the export engine. Check your connection and try again.',
      ),
    )
    expect(harness.runExport).not.toHaveBeenCalled()
    expect(fake.ffmpeg.on).not.toHaveBeenCalled()
    expect(harness.stateSetters[0].mock.calls.map(([value]) => value)).toEqual([
      'loading',
      'idle',
    ])
    expect(consoleError).toHaveBeenCalledWith(
      'Export failed:',
      expect.objectContaining({
        message:
          'Could not load the export engine. Check your connection and try again.',
      }),
    )
  })

  it('handles a synchronous engine-construction failure inside the UI boundary', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.getFfmpeg.mockImplementation(() => {
      throw new Error('Worker constructor exposed a raw browser exception')
    })
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() =>
      expect(harness.stateSetters[2]).toHaveBeenLastCalledWith(
        'Could not start the export engine. Reload the page and try again.',
      ),
    )
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.runExport).not.toHaveBeenCalled()
    expect(harness.stateSetters[0]).toHaveBeenCalledOnce()
    expect(harness.stateSetters[0]).toHaveBeenCalledWith('idle')
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('clears a fallback notice if the completed encode cannot be downloaded', async () => {
    const fake = createFfmpeg(true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.getFfmpeg.mockReturnValue(fake.ffmpeg)
    harness.runExport.mockImplementation(async (...args: unknown[]) => {
      const onNote = args[4]
      if (typeof onNote === 'function') {
        const notify = onNote as (message: string) => void
        notify('Noise reduction is unavailable — exported without it.')
      }
      return new Blob([new Uint8Array([1])], { type: 'video/mp4' })
    })
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('raw object URL failure')
    })
    const view = renderExportButton()

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() =>
      expect(harness.stateSetters[2]).toHaveBeenLastCalledWith(
        'The video was exported, but the download could not start. Try again.',
      ),
    )
    expect(harness.runExport).toHaveBeenCalledOnce()
    expect(harness.stateSetters[3].mock.calls.map(([value]) => value)).toEqual([
      null,
      'Noise reduction is unavailable — exported without it.',
      null,
    ])
    expect(fake.ffmpeg.off).toHaveBeenCalledWith(
      'progress',
      fake.getProgressListener(),
    )
    expect(consoleError).toHaveBeenCalledOnce()
  })
})
