// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpeechModelStore } from '../../../src/main/asr/speechModelStore'
import type { SpeechEngine } from '../../../src/main/asr/speechEngine'
import { PARAKEET_ULTRA, PARAKEET_V2, PARAKEET_V3, speechModelBytes, speechModelFileUrl, type SottoSpeechModel, type SpeechModelStatus } from '../../../src/shared/speechModel'

/** When set, every download sink fails its first write with this error code, as a full or over-quota disk does. */
const sinkFault = vi.hoisted(() => ({ code: null as string | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const createWriteStream = ((...args: Parameters<typeof actual.createWriteStream>) => {
    const code = sinkFault.code
    if (code === null) return actual.createWriteStream(...args)
    return new Writable({ write: (_chunk, _encoding, callback) => callback(Object.assign(new Error('Synthetic storage fault'), { code })) })
  }) as typeof actual.createWriteStream
  return { ...actual, createWriteStream, default: { ...actual, createWriteStream } }
})

const bytes = (seed: number, length: number): Buffer => Buffer.from(Array.from({ length }, (_, index) => (seed * 31 + index * 7) % 256))
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

const FILES = { 'encoder.int8.onnx': bytes(1, 4_000), 'decoder.int8.onnx': bytes(2, 1_200), 'tokens.txt': bytes(3, 300) } as const
const MODEL: SottoSpeechModel = {
  id: 'test-model',
  name: 'Test model',
  maker: 'Sotto',
  languages: 'English only',
  releaseTag: 'speech-model-test',
  files: Object.entries(FILES).map(([name, data]) => ({ name, bytes: data.length, sha256: sha256(data) })),
}
const TOTAL = MODEL.files.reduce((total, file) => total + file.bytes, 0)
const fileUrl = (file: { readonly name: string }): string => `https://github.com/millZach/Sotto-releases/releases/download/speech-model-test/${file.name}`

interface FakeGitHubOptions {
  /** Names served with their content cut short and the stream broken, once each. */
  readonly drop?: Set<string>
  /** Names served with different content than pinned. */
  readonly corrupt?: Set<string>
  /** Where github.com redirects to; the release-asset host unless a test needs another. */
  readonly assetHost?: string
}

function fakeGitHub(options: FakeGitHubOptions = {}) {
  const requests: { readonly url: string; readonly range: string | null }[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const range = new Headers(init?.headers).get('range')
    requests.push({ url: url.href, range })
    const name = url.pathname.split('/').pop() as keyof typeof FILES
    if (url.hostname === 'github.com') {
      return new Response(null, { status: 302, headers: { location: `https://${options.assetHost ?? 'release-assets.githubusercontent.com'}/assets/${name}` } })
    }
    let data: Buffer = FILES[name]
    if (options.corrupt?.has(name)) data = Buffer.from(data.map((byte) => byte ^ 0xff))
    const start = range === null ? 0 : Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
    const slice = data.subarray(start)
    const dropping = options.drop?.has(name) === true
    if (dropping) options.drop!.delete(name)
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1
        if (!dropping) {
          controller.enqueue(new Uint8Array(slice))
          controller.close()
        } else if (pulls === 1) {
          controller.enqueue(new Uint8Array(slice.subarray(0, Math.floor(slice.length / 2))))
        } else {
          // The connection drops a moment after the first half arrived, as a real one does.
          await new Promise((resolve) => setTimeout(resolve, 50))
          controller.error(new Error('connection dropped'))
        }
      },
    })
    return start === 0
      ? new Response(body, { status: 200, headers: { 'content-length': String(data.length) } })
      : new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}`, 'content-length': String(slice.length) } })
  })
  return { fetchFn, requests }
}

const engine: SpeechEngine = { transcribe: async () => 'hello' }

describe('SpeechModelStore', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-speech-model-')) })
  afterEach(async () => {
    sinkFault.code = null
    await rm(directory, { recursive: true, force: true })
  })

  function createStore(fetchFn: typeof fetch, loadEngine = vi.fn(async () => engine)) {
    const statuses: SpeechModelStatus[] = []
    const store = new SpeechModelStore({ directory, model: MODEL, fileUrl, fetchFn, loadEngine, onStatus: (status) => statuses.push(status) })
    return { store, statuses, loadEngine }
  }

  it('downloads every file through GitHub, checks each against its pin, and starts the engine', async () => {
    const github = fakeGitHub()
    const { store, statuses, loadEngine } = createStore(github.fetchFn)
    await store.ensure()
    expect(store.get()).toEqual({ state: 'ready' })
    expect(store.currentEngine()).toBe(engine)
    expect(loadEngine).toHaveBeenCalledWith(join(directory, 'test-model'))
    expect(statuses[0]).toEqual({ state: 'downloading', receivedBytes: 0, totalBytes: TOTAL })
    expect(statuses.at(-2)).toEqual({ state: 'loading' })
    for (const [name, data] of Object.entries(FILES)) expect(await readFile(join(directory, 'test-model', name))).toEqual(data)
    expect(new Set(github.requests.map((request) => new URL(request.url).hostname))).toEqual(new Set(['github.com', 'release-assets.githubusercontent.com']))
    expect((await readdir(join(directory, 'test-model'))).some((file) => file.endsWith('.part'))).toBe(false)
  })

  it('loads a model it already verified without downloading anything', async () => {
    await createStore(fakeGitHub().fetchFn).store.ensure()
    const github = fakeGitHub()
    const { store, statuses } = createStore(github.fetchFn)
    await store.ensure()
    expect(github.requests).toEqual([])
    expect(statuses).toEqual([{ state: 'loading' }, { state: 'ready' }])
  })

  it('reports a dropped connection, and a retry continues from the bytes it already has', async () => {
    const github = fakeGitHub({ drop: new Set(['encoder.int8.onnx']) })
    const { store } = createStore(github.fetchFn)
    await store.ensure()
    const failed = store.get()
    expect(failed).toMatchObject({ state: 'failed', reason: 'network', totalBytes: TOTAL })
    const partial = await stat(join(directory, 'test-model', 'encoder.int8.onnx.part'))
    expect(partial.size).toBeGreaterThan(0)
    expect(failed).toMatchObject({ receivedBytes: partial.size })

    await store.ensure()
    expect(store.get()).toEqual({ state: 'ready' })
    const resumed = github.requests.filter((request) => request.url.includes('encoder') && request.range !== null)
    expect(resumed.map((request) => request.range)).toContain(`bytes=${partial.size}-`)
    expect(await readFile(join(directory, 'test-model', 'encoder.int8.onnx'))).toEqual(FILES['encoder.int8.onnx'])
  })

  it('throws away a file that does not match its pin and says so', async () => {
    const { store } = createStore(fakeGitHub({ corrupt: new Set(['decoder.int8.onnx']) }).fetchFn)
    await store.ensure()
    expect(store.get()).toMatchObject({ state: 'failed', reason: 'checksum' })
    const left = await readdir(join(directory, 'test-model'))
    expect(left).not.toContain('decoder.int8.onnx')
    expect(left).not.toContain('decoder.int8.onnx.part')
    expect(store.currentEngine()).toBeNull()
  })

  it.each(['ENOSPC', 'EDQUOT'])('says the model could not be saved when writing it fails with %s, not that GitHub could not be reached', async (code) => {
    sinkFault.code = code
    const { store } = createStore(fakeGitHub().fetchFn)
    await store.ensure()
    expect(store.get()).toMatchObject({ state: 'failed', reason: 'disk', totalBytes: TOTAL })
    expect(store.currentEngine()).toBeNull()
  })

  it('never follows GitHub to a host it does not know', async () => {
    const github = fakeGitHub({ assetHost: 'example.com' })
    const { store } = createStore(github.fetchFn)
    await store.ensure()
    expect(store.get()).toMatchObject({ state: 'failed', reason: 'network' })
    expect(github.requests.every((request) => new URL(request.url).hostname === 'github.com')).toBe(true)
  })

  it('reports an engine that will not start on verified files', async () => {
    const { store } = createStore(fakeGitHub().fetchFn, vi.fn(async () => { throw new Error('native module missing') }))
    await store.ensure()
    expect(store.get()).toEqual({ state: 'failed', reason: 'engine', receivedBytes: TOTAL, totalBytes: TOTAL })
    expect(store.currentEngine()).toBeNull()
  })

  it('checks every file again after the engine would not start, and replaces one that went bad at the same size', async () => {
    await createStore(fakeGitHub().fetchFn).store.ensure()
    const tokens = join(directory, 'test-model', 'tokens.txt')
    await writeFile(tokens, Buffer.from(FILES['tokens.txt'].map((byte) => byte ^ 0xff)))
    const loadEngine = vi.fn(async () => engine).mockRejectedValueOnce(new Error('bad weights'))
    const github = fakeGitHub()
    const { store } = createStore(github.fetchFn, loadEngine)
    await store.ensure()
    expect(store.get()).toMatchObject({ state: 'failed', reason: 'engine' })
    expect(github.requests).toEqual([])

    await store.ensure()
    expect(store.get()).toEqual({ state: 'ready' })
    expect(github.requests.filter((request) => new URL(request.url).hostname === 'github.com').map((request) => request.url.split('/').pop())).toEqual(['tokens.txt'])
    expect(await readFile(tokens)).toEqual(FILES['tokens.txt'])
  })

  it('runs one attempt at a time', async () => {
    const github = fakeGitHub()
    const { store } = createStore(github.fetchFn)
    await Promise.all([store.ensure(), store.ensure()])
    expect(github.requests.filter((request) => request.url.includes('github.com')).length).toBe(MODEL.files.length)
  })

  it('downloads again over a marker that no longer matches the files on disk', async () => {
    await createStore(fakeGitHub().fetchFn).store.ensure()
    await writeFile(join(directory, 'test-model', 'tokens.txt'), 'changed')
    const github = fakeGitHub()
    const { store } = createStore(github.fetchFn)
    await store.ensure()
    expect(store.get()).toEqual({ state: 'ready' })
    expect(github.requests.some((request) => request.url.endsWith('tokens.txt'))).toBe(true)
    expect(await readFile(join(directory, 'test-model', 'tokens.txt'))).toEqual(FILES['tokens.txt'])
  })

  it('says whether the model is downloaded without hashing or loading it', async () => {
    const { store, loadEngine } = createStore(fakeGitHub().fetchFn)
    expect(await store.isDownloaded()).toBe(false)
    await store.ensure()
    expect(await store.isDownloaded()).toBe(true)
    await writeFile(join(directory, 'test-model', 'tokens.txt'), 'changed')
    expect(await store.isDownloaded()).toBe(false)
    expect(loadEngine).toHaveBeenCalledTimes(1)
  })

  it('unloads the engine and goes back to missing, keeping the files', async () => {
    const dispose = vi.fn()
    const { store, statuses } = createStore(fakeGitHub().fetchFn, vi.fn(async () => ({ ...engine, dispose })))
    await store.ensure()
    store.unload()
    expect(store.get()).toEqual({ state: 'missing' })
    expect(statuses.at(-1)).toEqual({ state: 'missing' })
    expect(store.currentEngine()).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(await store.isDownloaded()).toBe(true)
  })

  it('never brings back a model unloaded while it was loading, and loads again when asked', async () => {
    let finish!: (value: SpeechEngine) => void
    const stale = { transcribe: async () => 'old', dispose: vi.fn() }
    const loadEngine = vi.fn(async () => engine).mockImplementationOnce(() => new Promise<SpeechEngine>((resolve) => { finish = resolve }))
    await createStore(fakeGitHub().fetchFn).store.ensure()
    const { store, statuses } = createStore(fakeGitHub().fetchFn, loadEngine)
    const first = store.ensure()
    await vi.waitFor(() => expect(loadEngine).toHaveBeenCalledTimes(1))
    store.unload()
    finish(stale)
    await first
    expect(store.get()).toEqual({ state: 'missing' })
    expect(store.currentEngine()).toBeNull()
    expect(stale.dispose).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual([{ state: 'loading' }, { state: 'missing' }])

    await store.ensure()
    expect(store.currentEngine()).toBe(engine)
  })

  it('stops a download unloaded part way and publishes nothing more from it', async () => {
    const github = fakeGitHub({ drop: new Set(['encoder.int8.onnx']) })
    const subscribed: SpeechModelStatus[] = []
    const { store, statuses } = createStore(github.fetchFn)
    store.subscribe((status) => subscribed.push(status))
    const attempt = store.ensure()
    await vi.waitFor(() => expect(statuses[0]).toMatchObject({ state: 'downloading' }))
    store.unload()
    await attempt
    expect(store.get()).toEqual({ state: 'missing' })
    expect(statuses.at(-1)).toEqual({ state: 'missing' })
    expect(subscribed).toEqual(statuses)
  })

  it('fetches each of Sotto\'s models from its own release tag, into its own folder', async () => {
    for (const model of [PARAKEET_V3, PARAKEET_ULTRA, PARAKEET_V2]) {
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
      const statuses: SpeechModelStatus[] = []
      const store = new SpeechModelStore({ directory, model, fetchFn, loadEngine: vi.fn(async () => engine), onStatus: (status) => statuses.push(status) })
      await store.ensure()
      expect(String(fetchFn.mock.calls[0]![0])).toBe(`https://github.com/millZach/Sotto-releases/releases/download/${model.releaseTag}/encoder.int8.onnx`)
      expect(String(fetchFn.mock.calls[0]![0])).toBe(speechModelFileUrl(model, model.files[0]!))
      expect(statuses.at(-1)).toEqual({ state: 'failed', reason: 'network', receivedBytes: 0, totalBytes: speechModelBytes(model) })
      expect(await readdir(directory)).toContain(model.id)
    }
  })
})
