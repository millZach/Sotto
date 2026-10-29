// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createParakeetEngineLoader } from '../../src/main/asr/parakeetEngine'
import { SpeechModelManager } from '../../src/main/asr/speechModelManager'
import { SpeechModelStore } from '../../src/main/asr/speechModelStore'
import type { SottoSpeechModel, SpeechModelStatus } from '../../src/shared/speechModel'
import { exited, fakeParakeetFork, running } from '../fixtures/fakeParakeetFork'

const DATA = Buffer.from('tokens of a small test model')
const MODEL_BYTES = DATA.length
const sottoModel = (id: string): SottoSpeechModel => ({
  id, name: id, maker: 'NVIDIA', languages: '25 European languages', releaseTag: `speech-model-${id}-1`,
  files: [{ name: 'tokens.txt', bytes: DATA.length, sha256: createHash('sha256').update(DATA).digest('hex') }],
})
/** Stand-ins for two of Sotto's downloads, each one small file; MODEL is the one already downloaded. */
const MODEL = sottoModel('test-v3')
const SOTTO_ULTRA = sottoModel('test-ultra')

/**
 * Sotto's own Parakeet models through the speech model manager and its stores, each run by `parakeetEngine.ts` in a
 * real helper process (`fakeParakeetHelper.mjs`), so a test sees the process start and end (#1787).
 */
describe('Speech model manager with Parakeet in its helper process', () => {
  let directory: string
  let helperMode = 'ready'
  const helpers = fakeParakeetFork(() => helperMode)
  const loadParakeet = createParakeetEngineLoader('/helper/parakeetHelper.js', helpers.fork)
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-parakeet-helper-')) })
  afterEach(async () => {
    helperMode = 'ready'
    for (const child of helpers.children.splice(0)) child.kill()
    await rm(directory, { recursive: true, force: true })
  })

  function stores(fetchFn: typeof fetch) {
    return [SOTTO_ULTRA, MODEL].map((model) => new SpeechModelStore({
      directory, model, fetchFn, loadEngine: loadParakeet, onStatus: () => undefined,
      fileUrl: () => 'https://release-assets.githubusercontent.com/assets/tokens.txt',
    }))
  }

  function setup() {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(DATA), { status: 200, headers: { 'content-length': String(DATA.length) } }))
    let choice: string | null = MODEL.id
    const statuses: SpeechModelStatus[] = []
    const manager = new SpeechModelManager({
      stores: stores(fetchFn),
      findFluidAudio: async () => [],
      coreMlLoader: () => () => Promise.reject(new Error('no Core ML here')),
      modelBeforeChoosing: MODEL.id,
      readChoice: () => choice,
      saveChoice: async (id) => { choice = id },
      onStatus: (status) => statuses.push(status),
    })
    return { manager, fetchFn, statuses, choice: () => choice }
  }

  /** Puts MODEL's files on disk, verified, the way an earlier download leaves them, and ends the helper that loaded. */
  async function downloadSottoModel(): Promise<void> {
    const store = stores(async () => new Response(new Uint8Array(DATA), { status: 200, headers: { 'content-length': String(DATA.length) } }))[1]!
    await store.ensure()
    store.unload()
    await Promise.all(helpers.children.splice(0).map(exited))
  }

  it('ends the helper when dictation is turned off, and starts a new one when it is turned back on', async () => {
    await downloadSottoModel()
    const { manager, choice, fetchFn } = setup()
    await manager.start()
    expect(manager.status()).toEqual({ state: 'ready' })
    const first = helpers.children[0]!
    expect(running(first)).toBe(true)
    await expect(manager.currentEngine()!.transcribe(new Float32Array([0.5]))).resolves.toMatch(/^heard 1 samples/)

    // Dictation off: the helper process ends, so every byte the model held goes back to the system.
    await manager.unload()
    await exited(first)
    expect(running(first)).toBe(false)
    expect(manager.currentEngine()).toBeNull()
    expect(choice()).toBe(MODEL.id)

    // Dictation back on: a new helper loads the same model, from the files already here.
    await manager.start()
    expect(manager.status()).toEqual({ state: 'ready' })
    expect(helpers.children).toHaveLength(2)
    expect(running(helpers.children[1]!)).toBe(true)
    await expect(manager.currentEngine()!.transcribe(new Float32Array([0.25]))).resolves.toMatch(/^heard 1 samples from 0.25/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ends a helper still loading when dictation is turned off, and loads again when it is turned back on', async () => {
    await downloadSottoModel()
    helperMode = 'never-ready'
    const { manager } = setup()
    const started = manager.start()
    await vi.waitFor(() => expect(helpers.children).toHaveLength(1))
    expect(manager.status()).toEqual({ state: 'loading' })

    await manager.unload()
    await exited(helpers.children[0]!)
    await started
    expect(manager.status()).toEqual({ state: 'missing' })

    helperMode = 'ready'
    await manager.start()
    expect(manager.status()).toEqual({ state: 'ready' })
    expect(helpers.children).toHaveLength(2)
  })

  it('reports a helper that stopped by itself, and Try again starts a new one on the same files', async () => {
    await downloadSottoModel()
    helperMode = 'crash-after-ready'
    const { manager, statuses } = setup()
    await manager.start()
    await expect(manager.currentEngine()!.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
    expect(manager.status()).toEqual({ state: 'failed', reason: 'engine', receivedBytes: 0, totalBytes: MODEL_BYTES })
    expect(statuses.at(-1)).toEqual(manager.status())
    expect(manager.currentEngine()).toBeNull()

    helperMode = 'ready'
    manager.download()
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    expect(helpers.children).toHaveLength(2)
    await expect(manager.currentEngine()!.transcribe(new Float32Array([0.5]))).resolves.toMatch(/^heard 1 samples/)
  })

  it('ends the helper of the model chosen before when another is chosen', async () => {
    await downloadSottoModel()
    const { manager } = setup()
    await manager.start()
    const first = helpers.children[0]!
    await manager.choose(SOTTO_ULTRA.id)
    await exited(first)
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    expect(helpers.children).toHaveLength(2)
    expect(running(helpers.children[1]!)).toBe(true)
  })
})
