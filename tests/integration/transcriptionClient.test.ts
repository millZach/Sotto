import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  TranscriptionClient,
  TranscriptionError,
  type WorkerLike,
} from '../../src/renderer/src/transcription/client'

class FakeWorker implements WorkerLike {
  readonly posts: Array<{ message: unknown; transfer: ArrayBuffer[] }> = []
  readonly terminate = vi.fn()
  failPost = false
  private readonly listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>()

  postMessage(message: unknown, transfer: ArrayBuffer[] = []): void {
    if (this.failPost) throw new Error('structured clone failed with private details')
    this.posts.push({ message, transfer })
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener(new MessageEvent('message', { data }))
    }
  }

  emit(type: 'error' | 'messageerror', event = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }

  captureMessageListeners(): Array<(event: MessageEvent | Event) => void> {
    return [...(this.listeners.get('message') ?? [])]
  }
}

function makeClient(ids = ['request-1', 'request-2', 'request-3']): {
  client: TranscriptionClient
  worker: FakeWorker
} {
  const worker = new FakeWorker()
  const createRequestId = vi.fn(() => ids.shift() ?? 'request-extra')
  const client = new TranscriptionClient({ workerFactory: () => worker, createRequestId })
  return { client, worker }
}

describe('TranscriptionClient', () => {
  it('uses the Vite-safe production module-worker construction form', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/transcription/client.ts'),
      'utf8',
    )
    expect(source).toContain(
      "new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })",
    )
  })

  it('dispatches full audio as a transferable and correlates the result', async () => {
    const { client, worker } = makeClient()
    const audio = new Float32Array([0.1, 0.2])
    const resultPromise = client.transcribe({
      sessionId: 'session-1',
      audio,
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'wasm',
    })

    expect(worker.posts).toHaveLength(1)
    expect(worker.posts[0]?.message).toEqual(
      expect.objectContaining({
        type: 'transcribe',
        requestId: 'request-1',
        sessionId: 'session-1',
        sampleRate: 16_000,
        audio,
      }),
    )
    expect(worker.posts[0]?.transfer).toEqual([audio.buffer])

    worker.emitMessage({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'hello',
      language: 'en',
    })
    await expect(resultPromise).resolves.toEqual({ text: 'hello', language: 'en' })
  })

  it('copies a partial view so adjacent samples are never transferred', async () => {
    const { client, worker } = makeClient()
    const surrounding = new Float32Array([91, 0.25, 0.5, 92])
    const audio = surrounding.subarray(1, 3)
    const resultPromise = client.transcribe({
      sessionId: 'session-1',
      audio,
      preset: 'fast',
      language: 'en',
      inferencePreference: 'wasm',
    })

    const posted = worker.posts[0]?.message as { audio: Float32Array }
    expect([...posted.audio]).toEqual([0.25, 0.5])
    expect(posted.audio.buffer).not.toBe(surrounding.buffer)
    expect(worker.posts[0]?.transfer).toEqual([posted.audio.buffer])

    worker.emitMessage({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'private',
      language: 'en',
    })
    await resultPromise
  })

  it('delivers finite progress only to the correlated request', async () => {
    const { client, worker } = makeClient()
    const firstProgress = vi.fn()
    const secondProgress = vi.fn()
    const first = client.load({
      preset: 'fast',
      inferencePreference: 'wasm',
      onProgress: firstProgress,
    })
    const second = client.load({
      preset: 'instant',
      inferencePreference: 'wasm',
      onProgress: secondProgress,
    })

    worker.emitMessage({
      type: 'progress',
      requestId: 'request-2',
      stage: 'loading-model',
      progress: 0.4,
    })
    expect(firstProgress).not.toHaveBeenCalled()
    expect(secondProgress).toHaveBeenCalledWith({ stage: 'loading-model', progress: 0.4 })

    worker.emitMessage({
      type: 'ready',
      requestId: 'request-1',
      preset: 'fast',
      device: 'wasm',
    })
    worker.emitMessage({
      type: 'ready',
      requestId: 'request-2',
      preset: 'instant',
      device: 'wasm',
    })
    await Promise.all([first, second])
  })

  it('rejects cancellation locally and ignores a stale worker result', async () => {
    const { client, worker } = makeClient()
    const first = client.transcribe({
      sessionId: 'session-1',
      audio: new Float32Array([0.1]),
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'wasm',
    })

    client.cancel('session-1')
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(worker.posts[1]?.message).toEqual({
      type: 'cancel',
      requestId: 'request-2',
      targetRequestId: 'request-1',
      sessionId: 'session-1',
    })

    worker.emitMessage({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'session-1',
      text: 'must be ignored',
      language: 'en',
    })

    const second = client.transcribe({
      sessionId: 'session-2',
      audio: new Float32Array([0.2]),
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'wasm',
    })
    worker.emitMessage({
      type: 'result',
      requestId: 'request-3',
      sessionId: 'session-2',
      text: 'current',
      language: 'en',
    })
    await expect(second).resolves.toEqual({ text: 'current', language: 'en' })
  })

  it('retries auto-mode WebGPU failure once in a fresh forced-WASM worker', async () => {
    const firstWorker = new FakeWorker()
    const replacementWorker = new FakeWorker()
    const workers = [firstWorker, replacementWorker]
    const workerFactory = vi.fn(() => {
      const worker = workers.shift()
      if (worker === undefined) throw new Error('unexpected extra worker')
      return worker
    })
    const ids = ['gpu-request', 'other-request', 'wasm-retry']
    const client = new TranscriptionClient({
      workerFactory,
      createRequestId: () => ids.shift() ?? 'unexpected-id',
    })
    const oldListeners = firstWorker.captureMessageListeners()
    const result = client.transcribe({
      sessionId: 'session-1',
      audio: new Float32Array([0.1, 0.2]),
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'webgpu',
    })
    const unrelated = client.load({ preset: 'fast', inferencePreference: 'wasm' })

    firstWorker.emitMessage({
      type: 'error',
      requestId: 'gpu-request',
      sessionId: 'session-1',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })

    await expect(unrelated).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(workerFactory).toHaveBeenCalledTimes(2)
    const retryPost = replacementWorker.posts[0]
    expect(retryPost?.message).toEqual(
      expect.objectContaining({
        type: 'transcribe',
        requestId: 'wasm-retry',
        sessionId: 'session-1',
        preset: 'instant',
        inferencePreference: 'wasm',
        audio: expect.any(Float32Array),
      }),
    )
    expect((retryPost?.message as { audio: Float32Array }).audio).toEqual(
      new Float32Array([0.1, 0.2]),
    )
    expect(retryPost?.transfer).toEqual([
      (retryPost?.message as { audio: Float32Array }).audio.buffer,
    ])

    for (const listener of oldListeners) {
      listener(
        new MessageEvent('message', {
          data: {
            type: 'result',
            requestId: 'gpu-request',
            sessionId: 'session-1',
            text: 'stale poisoned result',
            language: 'en',
          },
        }),
      )
    }
    replacementWorker.emitMessage({
      type: 'result',
      requestId: 'wasm-retry',
      sessionId: 'session-1',
      text: 'fresh fallback',
      language: 'en',
    })
    await expect(result).resolves.toEqual({ text: 'fresh fallback', language: 'en' })
  })

  it('retries explicit WebGPU failure once in a fresh forced-WASM worker', async () => {
    const firstWorker = new FakeWorker()
    const replacementWorker = new FakeWorker()
    const workerFactory = vi
      .fn<() => FakeWorker>()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(replacementWorker)
    const ids = ['gpu', 'wasm']
    const client = new TranscriptionClient({
      workerFactory,
      createRequestId: () => ids.shift() ?? 'extra',
    })
    const result = client.load({ preset: 'instant', inferencePreference: 'webgpu' })

    firstWorker.emitMessage({
      type: 'error',
      requestId: 'gpu',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })

    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(replacementWorker.posts[0]?.message).toEqual({
      type: 'load',
      requestId: 'wasm',
      preset: 'instant',
      inferencePreference: 'wasm',
    })
    replacementWorker.emitMessage({
      type: 'ready',
      requestId: 'wasm',
      preset: 'instant',
      device: 'wasm',
    })
    await expect(result).resolves.toMatchObject({ device: 'wasm' })
    expect(workerFactory).toHaveBeenCalledTimes(2)
  })

  it('uses the recovered WASM backend for later GPU-capable requests in the client session', async () => {
    const firstWorker = new FakeWorker()
    const replacementWorker = new FakeWorker()
    const workerFactory = vi
      .fn<() => FakeWorker>()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(replacementWorker)
    const ids = ['gpu', 'wasm-recovery', 'later']
    const client = new TranscriptionClient({
      workerFactory,
      createRequestId: () => ids.shift() ?? 'extra',
    })
    const recovery = client.load({ preset: 'instant', inferencePreference: 'webgpu' })
    firstWorker.emitMessage({
      type: 'error',
      requestId: 'gpu',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
    replacementWorker.emitMessage({
      type: 'ready',
      requestId: 'wasm-recovery',
      preset: 'instant',
      device: 'wasm',
    })
    await recovery

    const later = client.load({ preset: 'fast', inferencePreference: 'webgpu' })
    expect(replacementWorker.posts[1]?.message).toEqual({
      type: 'load',
      requestId: 'later',
      preset: 'fast',
      inferencePreference: 'wasm',
    })
    replacementWorker.emitMessage({
      type: 'ready',
      requestId: 'later',
      preset: 'fast',
      device: 'wasm',
    })
    await expect(later).resolves.toMatchObject({ device: 'wasm' })
    expect(workerFactory).toHaveBeenCalledTimes(2)
  })

  it('cancellation can win after the fresh-worker fallback starts', async () => {
    const firstWorker = new FakeWorker()
    const replacementWorker = new FakeWorker()
    const workerFactory = vi
      .fn<() => FakeWorker>()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(replacementWorker)
    const ids = ['gpu', 'wasm', 'cancel']
    const client = new TranscriptionClient({
      workerFactory,
      createRequestId: () => ids.shift() ?? 'extra',
    })
    const result = client.transcribe({
      sessionId: 'session-1',
      audio: new Float32Array([0.1]),
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'webgpu',
    })

    firstWorker.emitMessage({
      type: 'error',
      requestId: 'gpu',
      sessionId: 'session-1',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
    client.cancel('session-1')

    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(replacementWorker.posts[1]?.message).toEqual({
      type: 'cancel',
      requestId: 'cancel',
      targetRequestId: 'wasm',
      sessionId: 'session-1',
    })
    replacementWorker.emitMessage({
      type: 'error',
      requestId: 'wasm',
      sessionId: 'session-1',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
    expect(workerFactory).toHaveBeenCalledTimes(2)
  })

  it('never retries the forced-WASM request a second time', async () => {
    const firstWorker = new FakeWorker()
    const replacementWorker = new FakeWorker()
    const workerFactory = vi
      .fn<() => FakeWorker>()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(replacementWorker)
    const ids = ['gpu', 'wasm']
    const client = new TranscriptionClient({
      workerFactory,
      createRequestId: () => ids.shift() ?? 'extra',
    })
    const result = client.load({ preset: 'instant', inferencePreference: 'webgpu' })

    firstWorker.emitMessage({
      type: 'error',
      requestId: 'gpu',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })
    replacementWorker.emitMessage({
      type: 'error',
      requestId: 'wasm',
      code: 'WEBGPU_FAILED',
      message: 'WebGPU transcription is unavailable.',
    })

    await expect(result).rejects.toMatchObject({ code: 'WEBGPU_FAILED' })
    expect(workerFactory).toHaveBeenCalledTimes(2)
    expect(replacementWorker.posts[0]?.message).toEqual(
      expect.objectContaining({ requestId: 'wasm', inferencePreference: 'wasm' }),
    )
  })

  it('terminates safely when posting to the worker throws', async () => {
    const worker = new FakeWorker()
    worker.failPost = true
    const client = new TranscriptionClient({
      workerFactory: () => worker,
      createRequestId: () => 'request-1',
    })

    const result = client.load({ preset: 'instant', inferencePreference: 'wasm' })

    await expect(result).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('fails safely on a wrong-session or malformed correlated response', async () => {
    const { client, worker } = makeClient()
    const wrongSession = client.transcribe({
      sessionId: 'session-1',
      audio: new Float32Array([0.1]),
      preset: 'instant',
      language: 'auto',
      inferencePreference: 'wasm',
    })
    worker.emitMessage({
      type: 'result',
      requestId: 'request-1',
      sessionId: 'another-session',
      text: 'wrong',
      language: 'en',
    })
    await expect(wrongSession).rejects.toMatchObject({ code: 'SESSION_MISMATCH' })

    const malformed = client.load({ preset: 'instant', inferencePreference: 'wasm' })
    worker.emitMessage({ type: 'ready', requestId: 'request-2', preset: 'instant' })
    await expect(malformed).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it.each(['error', 'messageerror'] as const)(
    'rejects all work and terminates after a worker %s event',
    async (eventType) => {
      const { client, worker } = makeClient()
      const load = client.load({ preset: 'instant', inferencePreference: 'wasm' })
      const transcribe = client.transcribe({
        sessionId: 'session-1',
        audio: new Float32Array([0.1]),
        preset: 'instant',
        language: 'auto',
        inferencePreference: 'wasm',
      })

      worker.emit(eventType)
      await expect(load).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
      await expect(transcribe).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
      expect(worker.terminate).toHaveBeenCalledOnce()
      expect(worker.listenerCount()).toBe(0)
    },
  )

  it('disposes idempotently, rejects outstanding work, and rejects later use', async () => {
    const { client, worker } = makeClient()
    const pending = client.load({ preset: 'instant', inferencePreference: 'wasm' })

    client.dispose()
    client.dispose()
    await expect(pending).rejects.toBeInstanceOf(TranscriptionError)
    await expect(pending).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.listenerCount()).toBe(0)

    await expect(
      client.load({ preset: 'instant', inferencePreference: 'wasm' }),
    ).rejects.toMatchObject({ code: 'WORKER_TERMINATED' })
  })
})
