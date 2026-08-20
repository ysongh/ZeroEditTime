import { beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => {
  const instance = {
    loaded: false,
    load: vi.fn(async (): Promise<void> => {}),
  }
  return {
    instance,
    FFmpeg: vi.fn(function MockFFmpeg() {
      return instance
    }),
    toBlobURL: vi.fn(
      async (url: string, mimeType: string): Promise<string> =>
        `blob:${mimeType}:${url}`,
    ),
  }
})

vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: engineMocks.FFmpeg }))
vi.mock('@ffmpeg/util', () => ({ toBlobURL: engineMocks.toBlobURL }))

beforeEach(() => {
  vi.resetModules()
  engineMocks.instance.loaded = false
  engineMocks.FFmpeg.mockClear()
  engineMocks.instance.load.mockReset()
  engineMocks.instance.load.mockImplementation(async () => {
    engineMocks.instance.loaded = true
  })
  engineMocks.toBlobURL.mockReset()
  engineMocks.toBlobURL.mockImplementation(
    async (url: string, mimeType: string): Promise<string> =>
      `blob:${mimeType}:${url}`,
  )
})

describe('shared FFmpeg engine laziness', () => {
  it('does not construct or load FFmpeg during module import or pure filename work', async () => {
    const engine = await import('./engine')

    expect(engineMocks.FFmpeg).not.toHaveBeenCalled()
    expect(engineMocks.toBlobURL).not.toHaveBeenCalled()
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
    expect(engine.inputExtension('clip.MOV')).toBe('mov')
    expect(engineMocks.FFmpeg).not.toHaveBeenCalled()
  })

  it('constructs exactly one shared instance on first explicit access', async () => {
    const engine = await import('./engine')

    const first = engine.getFfmpeg()
    const second = engine.getFfmpeg()

    expect(first).toBe(engineMocks.instance)
    expect(second).toBe(first)
    expect(engineMocks.FFmpeg).toHaveBeenCalledTimes(1)
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
  })

  it('loads the mocked CDN core only when requested and skips repeat loads', async () => {
    const engine = await import('./engine')

    await engine.loadFfmpeg()
    await engine.loadFfmpeg()

    expect(engineMocks.FFmpeg).toHaveBeenCalledTimes(1)
    expect(engineMocks.toBlobURL).toHaveBeenCalledTimes(2)
    expect(engineMocks.toBlobURL.mock.calls).toEqual([
      [
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
        'text/javascript',
      ],
      [
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm',
        'application/wasm',
      ],
    ])
    expect(engineMocks.instance.load).toHaveBeenCalledTimes(1)
    expect(engineMocks.instance.load).toHaveBeenCalledWith({
      coreURL:
        'blob:text/javascript:https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
      wasmURL:
        'blob:application/wasm:https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm',
    })
  })
})
