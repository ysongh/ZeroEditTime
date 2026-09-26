import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineMocks = vi.hoisted(() => {
  const instance = {
    loaded: false,
    load: vi.fn(async (): Promise<void> => {}),
    terminate: vi.fn(),
  }
  return {
    instance,
    FFmpeg: vi.fn(function MockFFmpeg() {
      return instance
    }),
    fetch: vi.fn<typeof fetch>(),
  }
})

vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: engineMocks.FFmpeg }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function downloadedAsset(): Response {
  return new Response(new Uint8Array([1, 2, 3]))
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  engineMocks.instance.loaded = false
  engineMocks.FFmpeg.mockClear()
  engineMocks.instance.load.mockReset().mockImplementation(async () => {
    engineMocks.instance.loaded = true
  })
  engineMocks.instance.terminate.mockReset().mockImplementation(() => {
    engineMocks.instance.loaded = false
  })
  engineMocks.fetch.mockReset().mockImplementation(async () => downloadedAsset())
  vi.stubGlobal('fetch', engineMocks.fetch)
  let nextUrl = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:core-${++nextUrl}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('shared FFmpeg engine loading', () => {
  it('does not construct or download FFmpeg during imports or pure filename work', async () => {
    const engine = await import('./engine')

    expect(engine.inputExtension('clip.MOV')).toBe('mov')
    expect(engine.inputExtension('clip')).toBe('mp4')
    expect(engineMocks.FFmpeg).not.toHaveBeenCalled()
    expect(engineMocks.fetch).not.toHaveBeenCalled()
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
  })

  it('constructs exactly one shared instance on first explicit access', async () => {
    const engine = await import('./engine')

    const first = engine.getFfmpeg()
    expect(first).toBe(engineMocks.instance)
    expect(engine.getFfmpeg()).toBe(first)
    expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
    expect(engineMocks.fetch).not.toHaveBeenCalled()
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
  })

  it('loads pinned single-threaded ESM assets, revokes their URLs, and skips repeat loads', async () => {
    const engine = await import('./engine')
    await engine.loadFfmpeg()
    await engine.loadFfmpeg()

    expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
    expect(engineMocks.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm',
    ])
    expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) =>
      blob instanceof Blob ? blob.type : null,
    ))
      .toEqual(['text/javascript', 'application/wasm'])
    expect(engineMocks.instance.load).toHaveBeenCalledExactlyOnceWith({
      coreURL: 'blob:core-1', wasmURL: 'blob:core-2',
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:core-1')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:core-2')
    expect(engineMocks.instance.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('downloads in parallel and shares one in-flight load between overlapping callers', async () => {
    const engine = await import('./engine')
    const headers = deferred<Response>()
    const worker = deferred<void>()
    engineMocks.fetch.mockReturnValueOnce(headers.promise)
    engineMocks.instance.load.mockReturnValueOnce(worker.promise)

    const preload = engine.loadFfmpeg()
    const awaitedUse = engine.loadFfmpeg()
    expect(engineMocks.fetch).toHaveBeenCalledTimes(2)
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
    headers.resolve(downloadedAsset())
    await vi.advanceTimersByTimeAsync(0)
    expect(engineMocks.instance.load).toHaveBeenCalledOnce()
    expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    engineMocks.instance.loaded = true
    worker.resolve()
    await Promise.all([preload, awaitedUse])
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects HTTP errors before worker loading and permits a retry on the same instance', async () => {
    const engine = await import('./engine')
    engineMocks.fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    const preload = engine.loadFfmpeg()
    const awaitedUse = engine.loadFfmpeg()
    const results = await Promise.allSettled([preload, awaitedUse])

    expect(results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('HTTP 503') }) },
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('HTTP 503') }) },
    ])
    expect(engineMocks.instance.load).not.toHaveBeenCalled()
    expect(engineMocks.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(engineMocks.instance.terminate).toHaveBeenCalledOnce()
    await engine.loadFfmpeg()
    expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
    expect(engineMocks.instance.load).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('revokes staged URLs and retries after a worker load failure', async () => {
    const engine = await import('./engine')
    engineMocks.instance.load.mockRejectedValueOnce(new Error('Worker import failed.'))

    await expect(engine.loadFfmpeg()).rejects.toThrow('Worker import failed.')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(engineMocks.instance.terminate).toHaveBeenCalledOnce()
    await engine.loadFfmpeg()
    expect(engineMocks.instance.load).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4)
    expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['headers', 'body', 'worker'] as const)(
    'bounds stalled %s, aborts the old load, and recovers without late work restarting it',
    async (stage) => {
      const engine = await import('./engine')
      const headers = deferred<Response>()
      const body = deferred<ArrayBuffer>()
      const worker = deferred<void>()
      if (stage === 'headers') engineMocks.fetch.mockReturnValueOnce(headers.promise)
      if (stage === 'body') {
        const response = downloadedAsset()
        vi.spyOn(response, 'arrayBuffer').mockReturnValueOnce(body.promise)
        engineMocks.fetch.mockResolvedValueOnce(response)
      }
      if (stage === 'worker') engineMocks.instance.load.mockReturnValueOnce(worker.promise)

      const pending = engine.loadFfmpeg()
      const rejection = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(engine.ENGINE_LOAD_TIMEOUT_MS - 1)
      expect(engineMocks.instance.terminate).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejection
      expect(engineMocks.instance.terminate).toHaveBeenCalledOnce()
      expect(engineMocks.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
      const stagedUrls = vi.mocked(URL.createObjectURL).mock.results
        .map((result) => result.value as string)
      expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url))
        .toEqual(stagedUrls)

      await engine.loadFfmpeg()
      const loadsAfterRetry = engineMocks.instance.load.mock.calls.length
      const urlsAfterRetry = vi.mocked(URL.createObjectURL).mock.calls.length
      headers.resolve(downloadedAsset())
      body.resolve(new ArrayBuffer(3))
      worker.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(engineMocks.instance.load).toHaveBeenCalledTimes(loadsAfterRetry)
      expect(URL.createObjectURL).toHaveBeenCalledTimes(urlsAfterRetry)
      expect(engineMocks.instance.loaded).toBe(true)
      expect(engineMocks.FFmpeg).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

describe('shared FFmpeg job ownership', () => {
  it('rejects overlapping jobs before their work starts and releases ownership on success', async () => {
    const engine = await import('./engine')
    const ffmpeg = engine.getFfmpeg()
    const work = deferred<string>()
    const rejectedWork = vi.fn(async () => 'overlap')
    const pending = engine.withFfmpegJob(ffmpeg, () => work.promise)

    await expect(engine.withFfmpegJob(ffmpeg, rejectedWork)).rejects.toThrow('engine is busy')
    expect(rejectedWork).not.toHaveBeenCalled()
    work.resolve('done')
    await expect(pending).resolves.toBe('done')
    await expect(engine.withFfmpegJob(ffmpeg, async () => 'next')).resolves.toBe('next')
    expect(engineMocks.instance.terminate).not.toHaveBeenCalled()
  })

  it.each(['throw', 'reject'] as const)('releases ownership when work fails via %s', async (failure) => {
    const engine = await import('./engine')
    const ffmpeg = engine.getFfmpeg()
    const fail = () => {
      if (failure === 'throw') throw new Error('Job failed.')
      return Promise.reject(new Error('Job failed.'))
    }
    await expect(engine.withFfmpegJob(ffmpeg, fail, {
      timeoutMs: 100, message: 'Too slow.',
    })).rejects.toThrow('Job failed.')
    await expect(engine.withFfmpegJob(ffmpeg, async () => 'recovered')).resolves.toBe('recovered')
    expect(engineMocks.instance.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts and terminates a timed-out job without letting late work unlock its successor', async () => {
    const engine = await import('./engine')
    const ffmpeg = engine.getFfmpeg()
    const oldWork = deferred<string>()
    const currentWork = deferred<string>()
    let oldSignal: AbortSignal | undefined
    const pending = engine.withFfmpegJob(ffmpeg, (signal) => {
      oldSignal = signal
      return oldWork.promise
    }, { timeoutMs: 100, message: 'Audio preparation timed out.' })
    const rejection = expect(pending).rejects.toThrow('Audio preparation timed out.')
    await vi.advanceTimersByTimeAsync(99)
    expect(oldSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(oldSignal?.aborted).toBe(true)
    expect(engineMocks.instance.terminate).toHaveBeenCalledOnce()

    const current = engine.withFfmpegJob(ffmpeg, () => currentWork.promise)
    oldWork.resolve('stale')
    await vi.advanceTimersByTimeAsync(0)
    await expect(engine.withFfmpegJob(ffmpeg, async () => 'overlap'))
      .rejects.toThrow('engine is busy')
    currentWork.resolve('current')
    await expect(current).resolves.toBe('current')
    await expect(engine.withFfmpegJob(ffmpeg, async () => 'next')).resolves.toBe('next')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a completed job deadline without aborting or terminating the worker', async () => {
    const engine = await import('./engine')
    let signal: AbortSignal | undefined
    await expect(engine.withFfmpegJob(engine.getFfmpeg(), async (jobSignal) => {
      signal = jobSignal
      return 'done'
    }, { timeoutMs: 100, message: 'Too slow.' })).resolves.toBe('done')

    await vi.advanceTimersByTimeAsync(200)
    expect(signal?.aborted).toBe(false)
    expect(engineMocks.instance.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
