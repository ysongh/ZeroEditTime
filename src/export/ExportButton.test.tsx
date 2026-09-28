import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EDL } from '../edl/types'
import type { ImageOverlay, OverlayAsset } from '../overlays/types'
import ExportButton from './ExportButton'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import {
  DEFAULT_AUDIO_CLEANUP_SETTINGS,
  type AudioCleanupSettings,
} from './audioCleanupSettings'

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

/** Visible text a screen reader would read: skips aria-hidden icons. */
function accessibleText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!isValidElement(node)) {
    return Children.toArray(node).map(accessibleText).join('')
  }
  const props = node.props as { children?: ReactNode; 'aria-hidden'?: unknown }
  return props['aria-hidden'] === 'true' || props['aria-hidden'] === true
    ? ''
    : accessibleText(props.children)
}

function findButton(node: ReactNode, label: string): ReactElement<ButtonProps> {
  if (!isValidElement(node)) {
    throw new Error(`Could not find button "${label}".`)
  }
  const element = node as ReactElement<ButtonProps>
  if (
    element.type === 'button' &&
    accessibleText(element.props.children) === label
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

type RenderOptions = {
  edl?: EDL
  overlayAssets?: readonly OverlayAsset[]
  imageOverlays?: readonly ImageOverlay[]
  audioCleanupSettings?: AudioCleanupSettings
  burnCaptions?: boolean
  onBusyChange?: (busy: boolean) => void
}

function renderExportButton({
  edl = EDL_FIXTURE,
  overlayAssets = [],
  imageOverlays = [],
  audioCleanupSettings = { ...DEFAULT_AUDIO_CLEANUP_SETTINGS },
  burnCaptions = true,
  onBusyChange,
}: RenderOptions = {}): ReactElement {
  harness.stateSetters.length = 0
  harness.stateOverrides.clear()
  return ExportButton({
    edl,
    file: { name: 'source.mp4' } as File,
    overlayAssets,
    imageOverlays,
    audioCleanupSettings,
    burnCaptions,
    onBusyChange,
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
  it('does not access FFmpeg while rendering', () => {
    renderExportButton({
      audioCleanupSettings: {
        ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
        noiseReduction: 'strong',
      },
    })

    expect(harness.getFfmpeg).not.toHaveBeenCalled()
    expect(harness.loadFfmpeg).not.toHaveBeenCalled()
    expect(harness.runExport).not.toHaveBeenCalled()
  })

  it('forwards the cleanup settings it is given and reports busy start and end', async () => {
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
    const settings: AudioCleanupSettings = {
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'strong',
      loudnessTargetLufs: -18,
      truePeakLimitDb: -2,
    }
    const onBusyChange = vi.fn()
    const view = renderExportButton({ audioCleanupSettings: settings, onBusyChange })

    findButton(view, 'Export MP4').props.onClick?.()

    await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
    expect(harness.runExport.mock.calls[0][6]).toEqual(
      buildAudioCleanupPlan(settings),
    )
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
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

  it.each([
    [true, [{ text: 'Keep this caption', start: 0.25, end: 1.25 }]],
    [false, []],
  ] as const)(
    'with burnCaptions %s passes the prepared burn captions %j',
    async (burnCaptions, expected) => {
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
      const view = renderExportButton({
        edl: CAPTIONED_EDL_FIXTURE,
        burnCaptions,
      })

      findButton(view, 'Export MP4').props.onClick?.()

      await vi.waitFor(() => expect(anchor.click).toHaveBeenCalledOnce())
      expect(harness.runExport.mock.calls[0][3]).toEqual(expected)
    },
  )

  it('disables export and explains why when every segment is cut', () => {
    const view = renderExportButton({
      edl: { ...EDL_FIXTURE, segments: [] },
    })

    expect(findButton(view, 'Export MP4').props.disabled).toBe(true)
    expect(accessibleText(view)).toContain(
      'Nothing to export — every segment has been cut.',
    )
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
    const view = renderExportButton({
      overlayAssets: [OVERLAY_ASSET_FIXTURE],
      imageOverlays: [IMAGE_OVERLAY_FIXTURE],
    })

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
