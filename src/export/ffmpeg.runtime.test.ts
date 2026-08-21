import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayRenderSegment } from '../overlays/renderPlan'
import type { OverlayAsset } from '../overlays/types'
import { runExport } from './ffmpeg'
import { buildAudioCleanupPlan } from './audioCleanupPlan'
import { DEFAULT_AUDIO_CLEANUP_SETTINGS } from './audioCleanupSettings'
import { getAudioFilterCapabilities } from './audioFilterCapabilities'

vi.mock('@ffmpeg/util', () => ({ fetchFile: vi.fn() }))

const fetchFileMock = vi.mocked(fetchFile)

const PNG: OverlayAsset = {
  id: 'png',
  kind: 'image',
  name: 'logo.png',
  mimeType: 'image/png',
  width: 800,
  height: 400,
  src: 'blob:logo',
}

const WEBP: OverlayAsset = {
  id: 'webp',
  kind: 'image',
  name: 'cutaway.webp',
  mimeType: 'image/webp',
  width: 1600,
  height: 900,
  src: 'blob:cutaway',
}

const PLAN: OverlayRenderSegment[] = [
  segment('logo-a', PNG.id, 0, 1_000, 0),
  segment('logo-b', PNG.id, 2_000, 3_000, 0),
  segment('cutaway', WEBP.id, 0, 3_000, 1),
]

function segment(
  overlayId: string,
  assetId: string,
  outputStartMs: number,
  outputEndMs: number,
  zIndex: number,
): OverlayRenderSegment {
  return {
    overlayId,
    assetId,
    sourceStartMs: outputStartMs,
    sourceEndMs: outputEndMs,
    outputStartMs,
    outputEndMs,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    fit: 'contain',
    opacity: 1,
    zIndex,
    fadeInMs: 0,
    fadeOutMs: 0,
  }
}

function fakeSourceFile(): File {
  return { name: 'source.mp4' } as File
}

function createFakeFfmpeg() {
  type LogListener = (event: { message: string }) => void
  type ProgressListener = (event: { progress: number; time: number }) => void
  type EventListener = LogListener | ProgressListener
  const logListeners = new Set<LogListener>()
  const progressListeners = new Set<ProgressListener>()
  const on = vi.fn((event: string, listener: EventListener) => {
    if (event === 'log') {
      logListeners.add(listener as LogListener)
    }
    if (event === 'progress') {
      progressListeners.add(listener as ProgressListener)
    }
  })
  const off = vi.fn((event: string, listener: EventListener) => {
    if (event === 'log') {
      logListeners.delete(listener as LogListener)
    }
    if (event === 'progress') {
      progressListeners.delete(listener as ProgressListener)
    }
  })
  const writeFile = vi.fn(async (path: string, data: unknown) => {
    void path
    void data
  })
  const createDir = vi.fn(async (path: string) => {
    void path
    return true
  })
  const exec = vi.fn(async (args: string[]) => {
    void args
    return 0
  })
  const readFile = vi.fn(async (path: string) => {
    void path
    return new Uint8Array([1, 2, 3])
  })
  const deleteFile = vi.fn(async (path: string) => {
    void path
    return true
  })

  const ffmpeg = {
    on,
    off,
    writeFile,
    createDir,
    exec,
    readFile,
    deleteFile,
  } as unknown as FFmpeg

  return {
    ffmpeg,
    on,
    off,
    writeFile,
    exec,
    readFile,
    deleteFile,
    emitLog(message: string): void {
      for (const listener of logListeners) {
        listener({ message })
      }
    },
    emitProgress(progress: number, time = 0): void {
      for (const listener of progressListeners) {
        listener({ progress, time })
      }
    },
  }
}

function overlayRequest(plan = PLAN, assets = [PNG, WEBP]) {
  return {
    renderPlan: plan,
    assets,
    frameWidth: 1280,
    frameHeight: 720,
  }
}

function filterOfExec(args: string[]): string {
  const index = args.indexOf('-filter_complex')
  return args[index + 1]
}

function mappedStreamsOfExec(args: string[]): string[] {
  return args.flatMap((arg, index) =>
    arg === '-map' && args[index + 1] !== undefined ? [args[index + 1]] : [],
  )
}

async function captureExportError(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work()
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw new Error('Expected export to reject with an Error instance.', {
      cause: error,
    })
  }
  throw new Error('Expected export to reject.')
}

beforeEach(() => {
  fetchFileMock.mockReset()
})

describe('runExport with image overlays', () => {
  it('stages each unique image once, executes the graph, and cleans every file', async () => {
    const fake = createFakeFfmpeg()
    const file = fakeSourceFile()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))

    const blob = await runExport(
      fake.ffmpeg,
      file,
      [{ start: 0, end: 4 }],
      [],
      undefined,
      overlayRequest(),
    )

    expect(fetchFileMock.mock.calls.map(([input]) => input)).toEqual([
      file,
      PNG.src,
      WEBP.src,
    ])
    expect(fake.writeFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'overlay_0.png',
      'overlay_1.webp',
    ])
    expect(fake.exec).toHaveBeenCalledTimes(1)
    const args = fake.exec.mock.calls[0][0]
    expect(args).toEqual(
      expect.arrayContaining([
        '-loop',
        '1',
        '-i',
        'overlay_0.png',
        '-i',
        'overlay_1.webp',
        '-map',
        '[ovout]',
        '-map',
        '[outa]',
      ]),
    )
    expect(filterOfExec(args)).toContain('[ovbase]scale=1280:720')
    expect(fake.readFile).toHaveBeenCalledWith('output.mp4')
    expect(blob.type).toBe('video/mp4')
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3])
    expect(fake.deleteFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'output.mp4',
      'overlay_0.png',
      'overlay_1.webp',
    ])
    expect(fake.off).toHaveBeenCalledWith('log', fake.on.mock.calls[0][1])
  })

  it('composes cleanup, captions, and an overlay in one runtime export', async () => {
    const fake = createFakeFfmpeg()
    const file = fakeSourceFile()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))

    await runExport(
      fake.ffmpeg,
      file,
      [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
      [{ text: 'Keep this caption', start: 0.25, end: 1.25 }],
      undefined,
      overlayRequest([PLAN[0]], [PNG]),
      cleanup,
    )

    expect(fake.writeFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'overlay_0.png',
      '/fonts/Roboto-Bold.ttf',
      'captions.srt',
    ])
    expect(fake.exec).toHaveBeenCalledTimes(1)
    const args = fake.exec.mock.calls[0][0]
    const filter = filterOfExec(args)
    expect(filter).toContain('concat=n=2:v=1:a=1[ovbase][ca]')
    expect(filter).toContain('afftdn=')
    expect(filter).toContain('acompressor=')
    expect(filter).toContain('loudnorm=')
    expect(filter).toContain('aresample=48000')
    expect(filter).toContain('alimiter=')
    expect(filter.indexOf('[ovbase]')).toBeLessThan(
      filter.indexOf('[ovout]subtitles='),
    )
    expect(mappedStreamsOfExec(args)).toEqual(['[outv]', '[outa]'])
    expect(fake.deleteFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'output.mp4',
      'captions.srt',
      '/fonts/Roboto-Bold.ttf',
      'overlay_0.png',
    ])
  })

  it('cleans every staged caption and overlay file after an encode failure', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog('Error while encoding: Cannot allocate memory')
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [{ text: 'Caption', start: 0, end: 1 }],
        undefined,
        overlayRequest([PLAN[0]], [PNG]),
        cleanup,
      ),
    ).rejects.toThrow(
      'The browser ran out of memory during export. Close other tabs or export a shorter, simpler edit and try again.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(fake.deleteFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'output.mp4',
      'captions.srt',
      '/fonts/Roboto-Bold.ttf',
      'overlay_0.png',
    ])
    expect(fake.off).toHaveBeenCalledWith('log', fake.on.mock.calls[0][1])
  })

  it('reuses staged images when a missing loudnorm filter triggers the fallback', async () => {
    const fake = createFakeFfmpeg()
    const file = fakeSourceFile()
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      if (fake.exec.mock.calls.length === 1) {
        fake.emitLog("No such filter: 'loudnorm'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      file,
      [{ start: 0, end: 4 }],
      [],
      note,
      overlayRequest([PLAN[0]], [PNG]),
    )

    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(fetchFileMock).toHaveBeenCalledTimes(2)
    expect(fake.writeFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'overlay_0.png',
    ])
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('loudnorm')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('loudnorm')
    expect(fake.exec.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['-i', 'overlay_0.png']),
    )
    expect(fake.exec.mock.calls[1][0]).toEqual(
      expect.arrayContaining(['-i', 'overlay_0.png']),
    )
    expect(note).toHaveBeenCalledOnce()
    expect(fake.deleteFile.mock.calls.map(([path]) => path)).toEqual([
      'output.mp4',
      'input.mp4',
      'output.mp4',
      'overlay_0.png',
    ])
  })

  it('preserves a partial-stage error while attempting all cleanup', async () => {
    const fake = createFakeFfmpeg()
    const file = fakeSourceFile()
    fetchFileMock
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(new Uint8Array([2]))
      .mockRejectedValueOnce(new Error('object URL expired'))
    fake.deleteFile.mockRejectedValue(new Error('cleanup failed'))

    await expect(
      runExport(
        fake.ffmpeg,
        file,
        [{ start: 0, end: 4 }],
        [],
        undefined,
        overlayRequest(),
      ),
    ).rejects.toThrow(
      'Could not read image "cutaway.webp" for export. Re-add the image and try again.',
    )

    expect(fake.exec).not.toHaveBeenCalled()
    expect(fake.writeFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'overlay_0.png',
    ])
    expect(fake.deleteFile.mock.calls.map(([path]) => path)).toEqual([
      'input.mp4',
      'output.mp4',
      'overlay_0.png',
      'overlay_1.webp',
    ])
  })
})

describe('runExport lifecycle callbacks and required processing', () => {
  it('keeps a caller-owned progress callback reachable during encoding', async () => {
    const fake = createFakeFfmpeg()
    const onProgress = vi.fn(
      (event: { progress: number; time: number }): void => {
        void event
      },
    )
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.ffmpeg.on('progress', onProgress)
    fake.exec.mockImplementation(async () => {
      fake.emitProgress(0.42, 1_250_000)
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
    )

    expect(onProgress).toHaveBeenCalledWith({
      progress: 0.42,
      time: 1_250_000,
    })
    expect(fake.off).not.toHaveBeenCalledWith('progress', onProgress)
  })

  it('returns a useful error when required audio processing is unavailable', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog("No such filter: 'aresample'")
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      ),
    ).rejects.toThrow(
      'This export engine is missing required audio processing, so the export was stopped to preserve audio safely.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })
})

describe('runExport user-facing fatal errors', () => {
  it.each([
    {
      name: 'an unsupported channel layout',
      log: "Input channel_layout '5.1(side)' is not supported by this filter",
      expected:
        'The source audio uses a channel layout this exporter cannot process. Convert it to mono or stereo and try again.',
    },
    {
      name: 'a parsed loudness-normalization failure',
      log: '[Parsed_loudnorm_4 @ 0x123] Failed to configure output pad',
      expected:
        'Audio cleanup failed during loudness normalization. The export was stopped. Try another source file or re-encode the source audio.',
    },
    {
      name: 'an audio mapping failure',
      log: "Output with label 'outa' does not exist in any defined filter graph.",
      expected:
        'Processed audio could not be connected to the exported MP4. The export was stopped to avoid missing or untreated audio.',
    },
    {
      name: 'a parsed denoising failure',
      log: '[Parsed_afftdn_1 @ 0x123] Error initializing filter graph',
      expected:
        'Audio cleanup failed while processing this source. The export was stopped; turn off Improve voice audio or try another source file.',
    },
    {
      name: 'a parsed voice-leveling failure',
      log: '[Parsed_acompressor_2 @ 0x123] Failed to configure output pad',
      expected:
        'Audio cleanup failed while processing this source. The export was stopped; turn off Improve voice audio or try another source file.',
    },
    {
      name: 'a parsed peak-limiting failure',
      log: '[Parsed_alimiter_3 @ 0x123] Invalid argument',
      expected:
        'Audio cleanup failed while processing this source. The export was stopped; turn off Improve voice audio or try another source file.',
    },
    {
      name: 'an unrelated encoder failure',
      log: 'Error while opening encoder for output stream #0:0',
      expected:
        'The MP4 could not be encoded. Try again with a shorter or simpler edit.',
    },
    {
      name: 'an out-of-memory failure even when loudnorm is mentioned',
      log: 'loudnorm: Error configuring filter: Cannot allocate memory',
      expected:
        'The browser ran out of memory during export. Close other tabs or export a shorter, simpler edit and try again.',
    },
    {
      name: 'an Emscripten memory-growth failure',
      log: 'Cannot enlarge memory arrays to size 2147483648 bytes',
      expected:
        'The browser ran out of memory during export. Close other tabs or export a shorter, simpler edit and try again.',
    },
  ])('stops without retrying for $name', async ({ log, expected }) => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog(log)
      return 1
    })

    const error = await captureExportError(() =>
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      ),
    )

    expect(error.message).toBe(expected)
    expect(error.message).not.toContain('ffmpeg export exited')
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toContain(log)
    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })

  it.each([
    {
      name: 'an abort-shaped error',
      rawName: 'AbortError',
      rawMessage: 'raw worker abort detail',
      expected: 'Export was canceled. No output file was created.',
    },
    {
      name: 'a terminated shared engine',
      rawName: 'Error',
      rawMessage: 'called FFmpeg.terminate() while worker was running',
      expected:
        'The export engine stopped before the export finished. Try the export again.',
    },
  ])(
    'normalizes $name without retrying',
    async ({ rawName, rawMessage, expected }) => {
      const fake = createFakeFfmpeg()
      const note = vi.fn()
      const raw = new Error(rawMessage)
      raw.name = rawName
      fetchFileMock.mockResolvedValue(new Uint8Array([9]))
      fake.exec.mockRejectedValue(raw)

      const error = await captureExportError(() =>
        runExport(
          fake.ffmpeg,
          fakeSourceFile(),
          [{ start: 0, end: 4 }],
          [],
          note,
        ),
      )

      expect(error.message).toBe(expected)
      expect(error.cause).toBe(raw)
      expect(fake.exec).toHaveBeenCalledTimes(1)
      expect(note).not.toHaveBeenCalled()
    },
  )

  it('keeps a missing caption filter fatal instead of silently dropping captions', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog("No such filter: 'subtitles'")
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [{ text: 'Keep me', start: 0, end: 1 }],
        note,
      ),
    ).rejects.toThrow(
      'This export engine cannot burn captions. Turn off Burn captions into video and try again.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
  })

  it('lets an exact optional-filter fallback outrank an unrelated malformed-media warning', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('afftdn=')) {
        fake.emitLog('Could not find codec parameters for stream 0:2')
        fake.emitLog("No such filter: 'afftdn'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      note,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('afftdn=')
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Noise reduction is unavailable'),
    )
    expect(getAudioFilterCapabilities(fake.ffmpeg).afftdn).toBe('unsupported')
  })

  it.each([
    "No such filter: 'afftdnoise'",
    "No such filter: 'acompressor2'",
    "No such filter: 'loudnormalizer'",
    "No such filter: 'alimiteralike'",
    "No such filter: 'aresampler'",
    "No such filter: 'subtitles2'",
    "Stream specifier ':audio' in filtergraph description matches no streams.",
    '[Parsed_loudnormalizer_4 @ 0x123] Error configuring filter output',
    "alimiter option latency enabled\nError while opening encoder for output stream #0:0",
  ])('does not treat an imprecise diagnostic as a safe fallback: %s', async (log) => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog(log)
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      ),
    ).rejects.toThrow(
      'The MP4 could not be encoded. Try again with a shorter or simpler edit.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })
})

describe('runExport staging errors', () => {
  it('wraps a source read failure and still detaches the log listener', async () => {
    const fake = createFakeFfmpeg()
    fetchFileMock.mockRejectedValue(new Error('raw revoked object URL'))

    const error = await captureExportError(() =>
      runExport(fake.ffmpeg, fakeSourceFile(), [{ start: 0, end: 4 }]),
    )

    expect(error.message).toBe(
      'Could not read the source file for export. Re-select the file and try again.',
    )
    expect(fake.exec).not.toHaveBeenCalled()
    expect(fake.off).toHaveBeenCalledWith('log', fake.on.mock.calls[0][1])
  })

  it('wraps a source VFS write failure without attempting an encode', async () => {
    const fake = createFakeFfmpeg()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.writeFile.mockRejectedValueOnce(new Error('Errno 28 raw VFS detail'))

    await expect(
      runExport(fake.ffmpeg, fakeSourceFile(), [{ start: 0, end: 4 }]),
    ).rejects.toThrow(
      'The browser could not write temporary export files. Free browser memory and try again.',
    )

    expect(fake.exec).not.toHaveBeenCalled()
  })

  it('wraps an overlay VFS write failure without exposing the VFS path', async () => {
    const fake = createFakeFfmpeg()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.writeFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('write overlay_0.png failed'))

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        undefined,
        overlayRequest([PLAN[0]], [PNG]),
      ),
    ).rejects.toThrow(
      'The browser could not write temporary image files for export. Free browser memory and try again.',
    )

    expect(fake.exec).not.toHaveBeenCalled()
  })

  it('wraps a caption font read failure and recommends disabling caption burn', async () => {
    const fake = createFakeFfmpeg()
    fetchFileMock
      .mockResolvedValueOnce(new Uint8Array([9]))
      .mockRejectedValueOnce(new Error('raw font fetch failure'))

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [{ text: 'Caption', start: 0, end: 1 }],
      ),
    ).rejects.toThrow(
      'Could not load the caption font for export. Turn off Burn captions into video and try again.',
    )

    expect(fake.exec).not.toHaveBeenCalled()
  })

  it('wraps a caption VFS write failure without attempting an encode', async () => {
    const fake = createFakeFfmpeg()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.writeFile
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('raw captions.srt write failure'))

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [{ text: 'Caption', start: 0, end: 1 }],
      ),
    ).rejects.toThrow(
      'The browser could not write temporary caption files. Turn off Burn captions into video or free browser memory and try again.',
    )

    expect(fake.exec).not.toHaveBeenCalled()
  })

  it('does not retry or announce a fallback when the encoded output cannot be read', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('afftdn=')) {
        fake.emitLog("No such filter: 'afftdn'")
        return 1
      }
      return 0
    })
    fake.readFile.mockRejectedValue(new Error('raw output.mp4 VFS read failure'))

    const error = await captureExportError(() =>
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      ),
    )

    expect(error.message).toBe(
      'The export finished, but the browser could not read the generated MP4. Free browser memory and try again.',
    )
    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('afftdn=')
    expect(note).not.toHaveBeenCalled()
    expect(fake.off).toHaveBeenCalledWith('log', fake.on.mock.calls[0][1])
  })
})

describe('runExport with noise reduction', () => {
  it('retries without afftdn, warns, and caches the missing filter', async () => {
    const fake = createFakeFfmpeg()
    const file = fakeSourceFile()
    const firstNote = vi.fn()
    const secondNote = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('afftdn=')) {
        fake.emitLog("No such filter: 'afftdn'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      file,
      [{ start: 0, end: 4 }],
      [],
      firstNote,
      undefined,
      cleanup,
    )
    await runExport(
      fake.ffmpeg,
      file,
      [{ start: 0, end: 4 }],
      [],
      secondNote,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(3)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('afftdn=')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('afftdn=')
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('afftdn=')
    expect(fake.deleteFile.mock.calls[0][0]).toBe('output.mp4')
    expect(firstNote).toHaveBeenCalledWith(
      expect.stringContaining('Noise reduction is unavailable'),
    )
    expect(secondNote).toHaveBeenCalledWith(
      expect.stringContaining('Noise reduction is unavailable'),
    )
  })

  it('can fall back from afftdn and loudnorm in the same export', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      const filter = filterOfExec(args)
      if (filter.includes('afftdn=')) {
        fake.emitLog("No such filter: 'afftdn'")
        return 1
      }
      if (filter.includes('loudnorm=')) {
        fake.emitLog("No such filter: 'loudnorm'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      note,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(3)
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('afftdn=')
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('loudnorm=')
    expect(fake.deleteFile.mock.calls.slice(0, 2)).toEqual([
      ['output.mp4'],
      ['output.mp4'],
    ])
    expect(note).toHaveBeenCalledOnce()
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(
        /Noise reduction is unavailable.*Loudness normalization is unavailable/,
      ),
    )
  })
})

describe('runExport with voice leveling', () => {
  it('retries without acompressor, warns, and caches the missing filter', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
    })
    const firstNote = vi.fn()
    const secondNote = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('acompressor=')) {
        fake.emitLog("No such filter: 'acompressor'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      firstNote,
      undefined,
      cleanup,
    )
    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      secondNote,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(3)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('acompressor=')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('acompressor=')
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('acompressor=')
    expect(fake.deleteFile.mock.calls[0][0]).toBe('output.mp4')
    expect(firstNote).toHaveBeenCalledWith(
      expect.stringContaining('Voice leveling is unavailable'),
    )
    expect(secondNote).toHaveBeenCalledWith(
      expect.stringContaining('Voice leveling is unavailable'),
    )
  })
})

describe('runExport with peak limiting', () => {
  it('retries without alimiter, warns, and caches the missing filter', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
    })
    const firstNote = vi.fn()
    const secondNote = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('alimiter=')) {
        fake.emitLog("No such filter: 'alimiter'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      firstNote,
      undefined,
      cleanup,
    )
    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      secondNote,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(3)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('alimiter=')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('alimiter=')
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('alimiter=')
    expect(fake.deleteFile.mock.calls[0][0]).toBe('output.mp4')
    expect(firstNote).toHaveBeenCalledWith(
      expect.stringContaining('Peak limiting is unavailable'),
    )
    expect(secondNote).toHaveBeenCalledWith(
      expect.stringContaining('Peak limiting is unavailable'),
    )
  })

  it('retries only for a specifically failed alimiter option', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
    })
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('alimiter=')) {
        fake.emitLog(
          "Error applying option 'latency' to filter 'alimiter': Option not found",
        )
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      note,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('alimiter=')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('alimiter=')
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Peak limiting is unavailable'),
    )
    expect(getAudioFilterCapabilities(fake.ffmpeg).alimiter).toBe('unsupported')
  })
})

describe('runExport with silent or missing audio', () => {
  it('retries a precisely diagnosed no-audio source as video-only', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      if (fake.exec.mock.calls.length === 1) {
        fake.emitLog(
          "Stream specifier ':a' in filtergraph description matches no streams.",
        )
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
      [],
      note,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(2)
    const firstArgs = fake.exec.mock.calls[0][0]
    const retryArgs = fake.exec.mock.calls[1][0]
    expect(filterOfExec(firstArgs)).toContain('[0:a]')
    expect(filterOfExec(firstArgs)).toContain('loudnorm=')
    expect(filterOfExec(retryArgs)).toContain('concat=n=2:v=1:a=0[outv]')
    expect(filterOfExec(retryArgs)).not.toMatch(
      /\[0:a\]|\[outa\]|atrim|afade|afftdn|acompressor|loudnorm|aresample|alimiter/,
    )
    expect(mappedStreamsOfExec(retryArgs)).toEqual(['[outv]'])
    expect(retryArgs).not.toContain('-c:a')
    expect(retryArgs).not.toContain('-b:a')
    expect(fetchFileMock).toHaveBeenCalledTimes(1)
    expect(fake.writeFile).toHaveBeenCalledTimes(1)
    expect(fake.deleteFile.mock.calls[0][0]).toBe('output.mp4')
    expect(note).toHaveBeenCalledWith(
      'The source has no audio track — exported video without audio.',
    )
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })

  it('does not misclassify a missing video stream as missing audio', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog(
        "Stream specifier ':v' in filtergraph description matches no streams.",
      )
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
      ),
    ).rejects.toThrow(
      'The MP4 could not be encoded. Try again with a shorter or simpler edit.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
  })

  it('skips only loudnorm when it fails on non-finite silence measurements', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('loudnorm=')) {
        fake.emitLog(
          "Value -inf for parameter 'input_i' out of range",
        )
        fake.emitLog(
          "Error applying option 'input_i' to filter 'loudnorm': Numerical result out of range",
        )
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      note,
      undefined,
      cleanup,
    )

    expect(fake.exec).toHaveBeenCalledTimes(2)
    const retryFilter = filterOfExec(fake.exec.mock.calls[1][0])
    expect(retryFilter).not.toContain('loudnorm=')
    expect(retryFilter).toContain('afftdn=')
    expect(retryFilter).toContain('acompressor=')
    expect(retryFilter).toContain('aresample=48000')
    expect(retryFilter).toContain('alimiter=')
    expect(fake.deleteFile.mock.calls[0][0]).toBe('output.mp4')
    expect(note).toHaveBeenCalledWith(
      'Loudness normalization could not analyze silent audio — exported without it.',
    )
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'supported',
      acompressor: 'supported',
      loudnorm: 'unknown',
      alimiter: 'supported',
      acrossfade: 'unknown',
    })
  })

  it('does not call an unrelated loudnorm NaN failure silent audio', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog('[Parsed_loudnorm_2 @ 0x123] Error processing timestamp NaN')
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      ),
    ).rejects.toThrow(
      'Audio cleanup failed during loudness normalization. The export was stopped.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg).loudnorm).toBe('unknown')
  })

  it('does not retry when loudnorm successfully accepts silent audio', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog('[Parsed_loudnorm_2] input_i: -inf input_tp: -inf')
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      note,
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('loudnorm=')
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg).loudnorm).toBe('supported')
  })

  it.each([
    { name: 'nearly silent', inputI: -89, inputTp: -87 },
    { name: 'very quiet', inputI: -55, inputTp: -50 },
    { name: 'already loud', inputI: -8, inputTp: -0.2 },
  ])(
    'accepts a successful finite loudnorm report for $name audio',
    async ({ inputI, inputTp }) => {
      const fake = createFakeFfmpeg()
      const note = vi.fn()
      const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
      fetchFileMock.mockResolvedValue(new Uint8Array([9]))
      fake.exec.mockImplementation(async () => {
        fake.emitLog(
          `[Parsed_loudnorm_2] input_i: ${inputI} input_tp: ${inputTp}`,
        )
        return 0
      })

      await runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
        undefined,
        cleanup,
      )

      expect(fake.exec).toHaveBeenCalledTimes(1)
      const filter = filterOfExec(fake.exec.mock.calls[0][0])
      expect(filter).toContain('afftdn=')
      expect(filter).toContain('acompressor=')
      expect(filter).toContain('loudnorm=')
      expect(filter).toContain('alimiter=')
      expect(note).not.toHaveBeenCalled()
    },
  )
})

describe('runExport with cached filter capabilities', () => {
  it('records only filters present in a successful encode result', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan(DEFAULT_AUDIO_CLEANUP_SETTINGS)
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      undefined,
      undefined,
      cleanup,
    )

    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'supported',
      acompressor: 'supported',
      loudnorm: 'supported',
      alimiter: 'supported',
      acrossfade: 'unknown',
    })
  })

  it('leaves unrequested filters unknown', async () => {
    const fake = createFakeFfmpeg()
    const cleanup = buildAudioCleanupPlan({
      ...DEFAULT_AUDIO_CLEANUP_SETTINGS,
      noiseReduction: 'off',
      voiceLeveling: false,
      loudnessNormalization: false,
    })
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      undefined,
      undefined,
      cleanup,
    )

    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'supported',
      acrossfade: 'unknown',
    })
  })

  it('keeps malformed audio fatal even near a non-finite loudnorm diagnostic', async () => {
    const fake = createFakeFfmpeg()
    const note = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async () => {
      fake.emitLog('[Parsed_loudnorm_2] input_i: -inf input_tp: -inf')
      fake.emitLog('Invalid data found when processing input')
      return 1
    })

    await expect(
      runExport(
        fake.ffmpeg,
        fakeSourceFile(),
        [{ start: 0, end: 4 }],
        [],
        note,
      ),
    ).rejects.toThrow(
      'The source media is malformed or uses a codec this exporter cannot decode.',
    )

    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(note).not.toHaveBeenCalled()
    expect(getAudioFilterCapabilities(fake.ffmpeg)).toEqual({
      afftdn: 'unknown',
      acompressor: 'unknown',
      loudnorm: 'unknown',
      alimiter: 'unknown',
      acrossfade: 'unknown',
    })
  })

  it('does not retry loudnorm after this FFmpeg instance proved it unsupported', async () => {
    const fake = createFakeFfmpeg()
    const firstNote = vi.fn()
    const secondNote = vi.fn()
    fetchFileMock.mockResolvedValue(new Uint8Array([9]))
    fake.exec.mockImplementation(async (args: string[]) => {
      if (filterOfExec(args).includes('loudnorm=')) {
        fake.emitLog("No such filter: 'loudnorm'")
        return 1
      }
      return 0
    })

    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      firstNote,
    )
    await runExport(
      fake.ffmpeg,
      fakeSourceFile(),
      [{ start: 0, end: 4 }],
      [],
      secondNote,
    )

    expect(fake.exec).toHaveBeenCalledTimes(3)
    expect(filterOfExec(fake.exec.mock.calls[0][0])).toContain('loudnorm=')
    expect(filterOfExec(fake.exec.mock.calls[1][0])).not.toContain('loudnorm=')
    expect(filterOfExec(fake.exec.mock.calls[2][0])).not.toContain('loudnorm=')
    expect(firstNote).toHaveBeenCalledWith(
      expect.stringContaining('Loudness normalization is unavailable'),
    )
    expect(secondNote).toHaveBeenCalledWith(
      expect.stringContaining('Loudness normalization is unavailable'),
    )
  })
})
