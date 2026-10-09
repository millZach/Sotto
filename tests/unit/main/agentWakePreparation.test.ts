// @vitest-environment node
import { EventEmitter } from 'node:events'
import { basename, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWakeService } from '../../../src/main/agents/wake'
import { deferred } from '../../fixtures/deferred'

const mocks = vi.hoisted(() => ({
  hashes: {} as Record<string, string>,
  workers: [] as Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }>,
  realpath: vi.fn(async (path: string) => path),
}))

vi.mock('node:fs/promises', () => ({
  realpath: mocks.realpath,
  stat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true, size: 1 })),
  readFile: vi.fn(async (path: string) => basename(path)),
}))
vi.mock('node:crypto', () => ({
  createHash: () => ({ update: (filename: string) => ({ digest: () => mocks.hashes[filename] }) }),
}))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn()
    terminate = vi.fn(async () => 0)
    constructor() {
      super()
      mocks.workers.push(this)
    }
  },
}))

// The supported model and runtime digests; filesystem reads and workers are scripted.
const verifiedHashes = {
  'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx': '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48',
  'decoder-epoch-13-avg-2-chunk-16-left-64.onnx': '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21',
  'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx': '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1',
  'tokens.txt': '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0',
  'index.js': '4026ae1122eaab063b19c4c331af33eb96af7536d5e7c2b6a2726661843177d9',
  'package.json': 'b0d41736778dcf7a506fa1a1a784535a87761a719ff4ba7d3c8a2679f37d9033',
  'sherpa-onnx-asr.js': 'd51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
  'sherpa-onnx-kws.js': '03b44e372795fd907e84eecd29419e1d052dc6704ac06935c9bf9fe19b3e3434',
  'sherpa-onnx-punctuation.js': '6d9721e5e11809e248a8cd64a9a50de43b047a9f059cfb35bea88a5e7265f49a',
  'sherpa-onnx-speaker-diarization.js': '7f1a37ea0c31e4352347f8e8945115a7ccffdf93b974c49c01878a8fa472e5bd',
  'sherpa-onnx-speech-enhancement.js': 'f4bdf7affe3e99d1f6879e02b7c9541cb2d88ec992302b4c1828e8e445c845eb',
  'sherpa-onnx-tts.js': 'b9cb4782010b22d64be31298a3e407170d2b8f5def471ea6011c42a921577e8f',
  'sherpa-onnx-vad.js': '893f01168d529add8318c0a6055cf725e788585fda9b81722564a8c3c3f60e34',
  'sherpa-onnx-wasm-nodejs.js': '6f78967dfa404b2d67da0349d17d92c9467d670f6b732ec862485522151e0188',
  'sherpa-onnx-wasm-nodejs.wasm': 'ef5926d45aae2738dabf649a5f626cf9827ba18f45453840c56eebb31ca2dd1b',
  'sherpa-onnx-wave.js': 'bb40258584a8eea84d9e9c09e9642ce5e67e4db68fc1522d8610297420052230',
}

function reply(index: number, error?: string): void {
  const worker = mocks.workers[index]!
  const { id } = worker.postMessage.mock.calls[0]![0]
  worker.emit('message', { id, error })
}

describe('local wake preparation', () => {
  let service: AgentWakeService
  beforeEach(() => {
    mocks.hashes = { ...verifiedHashes }
    mocks.workers = []
    mocks.realpath.mockReset().mockImplementation(async path => path)
    service = new AgentWakeService(resolve('runtime'), resolve('worker.js'))
  })
  afterEach(() => service.dispose())

  it('shares preparation while the model check is still pending', async () => {
    let release!: (path: string) => void
    mocks.realpath.mockImplementationOnce(() => { const pending = deferred<string>(); release = pending.resolve; return pending.promise })
    const first = service.prepare(resolve('model'))
    const firstResult = expect(first).resolves.toBeUndefined()
    const second = service.prepare(resolve('model'))
    const secondResult = expect(second).resolves.toBeUndefined()
    release(resolve('model'))
    await vi.waitFor(() => expect(mocks.workers).toHaveLength(1), { timeout: 10_000 })
    reply(0)
    await Promise.all([firstResult, secondResult])
    expect(mocks.workers[0]!.terminate).not.toHaveBeenCalled()
  })

  it('disposes a rejected worker setup and retries unchanged settings', async () => {
    const first = service.prepare(resolve('model'))
    const rejected = expect(first).rejects.toThrow('fixture setup failed')
    await vi.waitFor(() => expect(mocks.workers).toHaveLength(1), { timeout: 10_000 })
    reply(0, 'fixture setup failed')
    await rejected
    expect(mocks.workers[0]!.terminate).toHaveBeenCalledOnce()
    mocks.hashes = { ...verifiedHashes }
    const retry = service.prepare(resolve('model'))
    await vi.waitFor(() => expect(mocks.workers).toHaveLength(2), { timeout: 10_000 })
    reply(1)
    await retry
  })

  it('keeps a newer setup when an older model check rejects', async () => {
    const { promise: pending, reject } = deferred<string>()
    mocks.realpath.mockImplementationOnce(() => pending)
    const old = service.prepare(resolve('old-model'))
    const rejected = expect(old).rejects.toThrow('unavailable')
    const current = service.prepare(resolve('model'))
    await vi.waitFor(() => expect(mocks.workers).toHaveLength(1), { timeout: 10_000 })
    reject(new Error('fixture missing folder'))
    await rejected
    expect(mocks.workers[0]!.terminate).not.toHaveBeenCalled()
    reply(0)
    await current
  })
})
