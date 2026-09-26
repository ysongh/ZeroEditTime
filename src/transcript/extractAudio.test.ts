import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExport } from '../export/ffmpeg'
import { getFfmpeg, loadFfmpeg } from '../ffmpeg/engine'
import { AUDIO_PREPARATION_TIMEOUT_MS, extractAudio } from './extractAudio'

vi.mock('@ffmpeg/util', () => ({ fetchFile: vi.fn() }))
vi.mock('../ffmpeg/engine', async (importOriginal) => {
  const engine = await importOriginal<typeof import('../ffmpeg/engine')>()
  return { ...engine, getFfmpeg: vi.fn(), loadFfmpeg: vi.fn() }
})

const SOURCE = new File(['source bytes'], 'recording.MOV')
const SOURCE_BYTES = new Uint8Array([1, 2, 3])
const OUTPUT_BYTES = new Uint8Array([4, 5, 6])
const TIMEOUT_MESSAGE = 'Preparing audio timed out. Try again, or choose a shorter clip.'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function createFakeFfmpeg() {
  type LogListener = (event: { message: string }) => void
  const listeners = new Set<LogListener>()
  const on = vi.fn((_event: string, listener: LogListener) => {
    listeners.add(listener)
  })
  const off = vi.fn((_event: string, listener: LogListener) => {
    listeners.delete(listener)
  })
  const writeFile = vi.fn<(path: string, data: unknown) => Promise<boolean>>()
    .mockResolvedValue(true)
  const exec = vi.fn<(args: string[]) => Promise<number>>().mockResolvedValue(0)
  const readFile = vi.fn<(path: string) => Promise<Uint8Array>>()
    .mockResolvedValue(OUTPUT_BYTES)
  const deleteFile = vi.fn<(path: string) => Promise<boolean>>()
    .mockResolvedValue(true)
  const terminate = vi.fn()
  const ffmpeg = {
    on, off, writeFile, exec, readFile, deleteFile, terminate,
  } as unknown as FFmpeg

  return {
    ffmpeg, on, off, writeFile, exec, readFile, deleteFile, terminate,
    listeners,
    emitLog(message: string) {
      for (const listener of listeners) listener({ message })
    },
  }
}

describe('extractAudio runtime', () => {
  let fake: ReturnType<typeof createFakeFfmpeg>

  beforeEach(() => {
    vi.useFakeTimers()
    fake = createFakeFfmpeg()
    vi.mocked(getFfmpeg).mockReset().mockReturnValue(fake.ffmpeg)
    vi.mocked(loadFfmpeg).mockReset().mockResolvedValue(undefined)
    vi.mocked(fetchFile).mockReset().mockResolvedValue(SOURCE_BYTES)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('produces mono 16 kHz MP3 and cleans up the shared worker files and listener', async () => {
    const audio = await extractAudio(SOURCE)

    expect(audio.type).toBe('audio/mpeg')
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(OUTPUT_BYTES)
    expect(loadFfmpeg).toHaveBeenCalledOnce()
    expect(fetchFile).toHaveBeenCalledWith(SOURCE)
    expect(fake.writeFile).toHaveBeenCalledWith('input.mov', SOURCE_BYTES)
    expect(fake.exec).toHaveBeenCalledWith([
      '-i', 'input.mov', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '64k', 'output.mp3',
    ])
    expect(fake.readFile).toHaveBeenCalledWith('output.mp3')
    expect(fake.deleteFile.mock.calls).toEqual([
      ['input.mov'], ['output.mp3'], ['output.wav'],
    ])
    expect(fake.listeners.size).toBe(0)
    expect(fake.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not read a partial output after a nonzero encoder exit', async () => {
    fake.exec.mockResolvedValueOnce(1)

    await expect(extractAudio(SOURCE)).rejects.toThrow('encoder exited with code 1')

    expect(fake.exec).toHaveBeenCalledOnce()
    expect(fake.readFile).not.toHaveBeenCalled()
    expect(fake.deleteFile).toHaveBeenCalledTimes(3)
    expect(fake.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    'Output file #0 does not contain any stream',
    "Stream map '0:a' matches no streams.",
  ])('explains sources without audio: %s', async (log) => {
    fake.exec.mockImplementationOnce(async () => {
      fake.emitLog(log)
      return 1
    })

    await expect(extractAudio(SOURCE)).rejects.toThrow(
      'The selected file has no audio track to transcribe.',
    )
    expect(fake.exec).toHaveBeenCalledOnce()
    expect(fake.readFile).not.toHaveBeenCalled()
    expect(fake.deleteFile).toHaveBeenCalledTimes(3)
  })

  it('falls back to PCM WAV only when libmp3lame is unavailable', async () => {
    fake.exec.mockImplementationOnce(async () => {
      fake.emitLog("Unknown encoder 'libmp3lame'")
      return 1
    })

    const audio = await extractAudio(SOURCE)

    expect(audio.type).toBe('audio/wav')
    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(fake.exec.mock.calls[1][0]).toEqual([
      '-i', 'input.mov', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', 'output.wav',
    ])
    expect(fake.readFile.mock.calls).toEqual([['output.wav']])
    expect(fake.deleteFile).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    "Unknown encoder 'aac'",
    'Error while opening encoder libmp3lame',
    'Invalid data found when processing input',
  ])('does not retry unrelated encode failures: %s', async (log) => {
    fake.exec.mockImplementationOnce(async () => {
      fake.emitLog(log)
      throw new Error('Encoding failed')
    })

    await expect(extractAudio(SOURCE)).rejects.toThrow('Encoding failed')
    expect(fake.exec).toHaveBeenCalledOnce()
    expect(fake.readFile).not.toHaveBeenCalled()
  })

  it('surfaces failed WAV fallback without reading a partial file', async () => {
    fake.exec
      .mockImplementationOnce(async () => {
        fake.emitLog("Unknown encoder 'libmp3lame'")
        return 1
      })
      .mockResolvedValueOnce(2)

    await expect(extractAudio(SOURCE)).rejects.toThrow('encoder exited with code 2')
    expect(fake.exec).toHaveBeenCalledTimes(2)
    expect(fake.readFile).not.toHaveBeenCalled()
    expect(fake.deleteFile).toHaveBeenCalledTimes(3)
  })

  it('cleans up after source reading fails and lets another extraction retry', async () => {
    vi.mocked(fetchFile).mockRejectedValueOnce(new Error('Source cannot be read'))

    await expect(extractAudio(SOURCE)).rejects.toThrow('Source cannot be read')
    expect(fake.writeFile).not.toHaveBeenCalled()
    expect(fake.exec).not.toHaveBeenCalled()
    expect(fake.deleteFile).toHaveBeenCalledTimes(3)
    expect(fake.listeners.size).toBe(0)

    await expect(extractAudio(SOURCE)).resolves.toMatchObject({ type: 'audio/mpeg' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['source read', 'VFS write', 'encode', 'output read', 'cleanup'] as const)(
    'times out a stalled %s and releases ownership for retry',
    async (stage) => {
      const stalled = new Promise<never>(() => {})
      if (stage === 'source read') vi.mocked(fetchFile).mockReturnValueOnce(stalled)
      if (stage === 'VFS write') fake.writeFile.mockReturnValueOnce(stalled)
      if (stage === 'encode') fake.exec.mockReturnValueOnce(stalled)
      if (stage === 'output read') fake.readFile.mockReturnValueOnce(stalled)
      if (stage === 'cleanup') fake.deleteFile.mockReturnValueOnce(stalled)
      const rejection = expect(extractAudio(SOURCE)).rejects.toThrow(TIMEOUT_MESSAGE)

      await vi.advanceTimersByTimeAsync(AUDIO_PREPARATION_TIMEOUT_MS)

      await rejection
      expect(fake.terminate).toHaveBeenCalledOnce()
      expect(fake.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      await expect(extractAudio(SOURCE)).resolves.toMatchObject({ type: 'audio/mpeg' })
      expect(fake.terminate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it.each(['source read', 'encode'] as const)(
    'prevents late %s completion from reading, writing, or deleting a retry’s files',
    async (stage) => {
      const oldFetch = deferred<Uint8Array>()
      const oldEncode = deferred<number>()
      const retryEncode = deferred<number>()
      if (stage === 'source read') vi.mocked(fetchFile).mockReturnValueOnce(oldFetch.promise)
      if (stage === 'encode') fake.exec.mockReturnValueOnce(oldEncode.promise)
      const rejection = expect(extractAudio(SOURCE)).rejects.toThrow(TIMEOUT_MESSAGE)
      await vi.advanceTimersByTimeAsync(AUDIO_PREPARATION_TIMEOUT_MS)
      await rejection

      fake.exec.mockReturnValueOnce(retryEncode.promise)
      const retry = extractAudio(SOURCE)
      await vi.advanceTimersByTimeAsync(0)
      const writes = fake.writeFile.mock.calls.length
      const encodes = fake.exec.mock.calls.length
      expect(fake.readFile).not.toHaveBeenCalled()
      expect(fake.deleteFile).not.toHaveBeenCalled()
      expect(fake.listeners.size).toBe(1)

      oldFetch.resolve(SOURCE_BYTES)
      oldEncode.resolve(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(fake.writeFile).toHaveBeenCalledTimes(writes)
      expect(fake.exec).toHaveBeenCalledTimes(encodes)
      expect(fake.readFile).not.toHaveBeenCalled()
      expect(fake.deleteFile).not.toHaveBeenCalled()
      expect(fake.listeners.size).toBe(1)

      retryEncode.resolve(0)
      await expect(retry).resolves.toMatchObject({ type: 'audio/mpeg' })
      expect(fake.readFile).toHaveBeenCalledOnce()
      expect(fake.deleteFile).toHaveBeenCalledTimes(3)
      expect(fake.listeners.size).toBe(0)
    },
  )

  it.each(['extraction', 'export'] as const)(
    'protects an active %s from another job using the same worker',
    async (owner) => {
      const encode = deferred<number>()
      fake.exec.mockReturnValueOnce(encode.promise)
      const exportVideo = () => runExport(fake.ffmpeg, SOURCE, [{ start: 0, end: 1 }])
      const active = owner === 'extraction' ? extractAudio(SOURCE) : exportVideo()
      await vi.advanceTimersByTimeAsync(0)

      const competing = owner === 'extraction' ? exportVideo() : extractAudio(SOURCE)
      await expect(competing).rejects.toThrow('The audio/video engine is busy.')
      expect(fetchFile).toHaveBeenCalledOnce()
      expect(fake.writeFile).toHaveBeenCalledOnce()
      expect(fake.exec).toHaveBeenCalledOnce()
      expect(fake.deleteFile).not.toHaveBeenCalled()
      expect(fake.listeners.size).toBe(1)
      expect(fake.terminate).not.toHaveBeenCalled()

      encode.resolve(0)
      await expect(active).resolves.toMatchObject({
        type: owner === 'extraction' ? 'audio/mpeg' : 'video/mp4',
      })
      await expect(owner === 'extraction' ? exportVideo() : extractAudio(SOURCE))
        .resolves.toMatchObject({ type: owner === 'extraction' ? 'video/mp4' : 'audio/mpeg' })
      expect(fake.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
