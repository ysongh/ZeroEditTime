import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayRenderSegment } from '../overlays/renderPlan'
import type { OverlayAsset } from '../overlays/types'
import { runExport } from './ffmpeg'

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
  const logListeners = new Set<LogListener>()
  const on = vi.fn((event: string, listener: LogListener) => {
    if (event === 'log') {
      logListeners.add(listener)
    }
  })
  const off = vi.fn((event: string, listener: LogListener) => {
    if (event === 'log') {
      logListeners.delete(listener)
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
    ).rejects.toThrow('Could not stage image "cutaway.webp" for export.')

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
