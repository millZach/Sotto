// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoreMlModelVersion } from '../../../src/main/asr/coreMlEngine'
import type { FluidAudioModel } from '../../../src/main/asr/fluidAudioModels'
import type { SpeechEngine } from '../../../src/main/asr/speechEngine'
import { SpeechModelManager } from '../../../src/main/asr/speechModelManager'
import { SpeechModelStore } from '../../../src/main/asr/speechModelStore'
import { SOTTO_SPEECH_MODEL_ID, SPEECH_MODEL_BYTES, type SpeechModelManifest, type SpeechModelStatus } from '../../../src/shared/speechModel'

const DATA = Buffer.from('tokens of a small test model')
const MODEL: SpeechModelManifest = {
  id: 'test-model',
  files: [{ name: 'tokens.txt', bytes: DATA.length, sha256: createHash('sha256').update(DATA).digest('hex') }],
}

const fluid = (folder: string, version: CoreMlModelVersion, name: string): FluidAudioModel => ({
  id: `fluidaudio:${folder}`, folder, directory: `/models/${folder}`, version, name, maker: 'NVIDIA', languages: 'English only', bytes: 1_000,
})
const ULTRA = fluid('parakeet-ultra', 'ultra', 'Parakeet Ultra')
const V2 = fluid('parakeet-tdt-0.6b-v2', 'v2', 'Parakeet v2')

const engineNamed = (name: string) => ({ name, transcribe: vi.fn(async () => name), dispose: vi.fn() })

describe('SpeechModelManager', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-speech-manager-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  function setup(options: { choice?: string | null; models?: FluidAudioModel[]; saveFails?: boolean } = {}) {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(DATA), { status: 200, headers: { 'content-length': String(DATA.length) } }))
    const sottoEngine = engineNamed('sotto')
    const store = new SpeechModelStore({
      directory, model: MODEL, fetchFn, loadEngine: vi.fn(async () => sottoEngine), onStatus: () => undefined,
      fileUrl: () => 'https://release-assets.githubusercontent.com/assets/tokens.txt',
    })
    let models = options.models ?? []
    let choice = options.choice ?? null
    const pending: { version: CoreMlModelVersion; directory: string; resolve: (engine: SpeechEngine) => void; reject: (error: Error) => void }[] = []
    const coreMlLoader = vi.fn((version: CoreMlModelVersion) => (modelDirectory: string) => new Promise<SpeechEngine>((resolve, reject) => {
      pending.push({ version, directory: modelDirectory, resolve, reject })
    }))
    const statuses: SpeechModelStatus[] = []
    const saveChoice = vi.fn(async (id: string | null) => {
      if (options.saveFails === true) throw new Error('disk full')
      choice = id
    })
    const manager = new SpeechModelManager({
      store,
      findFluidAudio: async () => models,
      coreMlLoader,
      readChoice: () => choice,
      saveChoice,
      onStatus: (status) => statuses.push(status),
    })
    return {
      manager, store, fetchFn, sottoEngine, coreMlLoader, pending, statuses, saveChoice,
      setModels: (next: FluidAudioModel[]) => { models = next },
      choice: () => choice,
      setChoice: (next: string | null) => { choice = next },
    }
  }

  async function downloadSottoModel(): Promise<void> {
    await setup().store.ensure()
  }

  it('starts with nothing chosen as missing and downloads nothing', async () => {
    const { manager, fetchFn, saveChoice } = setup()
    await manager.start()
    expect(manager.status()).toEqual({ state: 'missing' })
    expect(manager.currentEngine()).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(saveChoice).not.toHaveBeenCalled()
  })

  it('chooses and loads Sotto\'s model for someone who already has it', async () => {
    await downloadSottoModel()
    const { manager, fetchFn, sottoEngine, statuses, choice } = setup()
    await manager.start()
    expect(choice()).toBe(SOTTO_SPEECH_MODEL_ID)
    expect(manager.status()).toEqual({ state: 'ready' })
    expect(manager.currentEngine()).toBe(sottoEngine)
    expect(statuses).toEqual([{ state: 'loading' }, { state: 'ready' }])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('leaves nothing chosen when that choice cannot be saved', async () => {
    await downloadSottoModel()
    const { manager } = setup({ saveFails: true })
    await manager.start()
    expect(manager.status()).toEqual({ state: 'missing' })
    expect(manager.currentEngine()).toBeNull()
  })

  it('picks up the download of Sotto\'s chosen model at start when it stopped before finishing', async () => {
    const { manager, fetchFn } = setup({ choice: SOTTO_SPEECH_MODEL_ID })
    await manager.start()
    expect(fetchFn).toHaveBeenCalled()
  })

  it('downloads nothing at start when no model is chosen', async () => {
    const { manager, fetchFn } = setup({ choice: null })
    await manager.start()
    expect(manager.status()).toEqual({ state: 'missing' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('loads a chosen FluidAudio model through the helper', async () => {
    const { manager, pending, statuses } = setup({ choice: ULTRA.id, models: [ULTRA] })
    const started = manager.start()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(manager.status()).toEqual({ state: 'loading' })
    expect(manager.currentEngine()).toBeNull()
    expect(pending[0]).toMatchObject({ version: 'ultra', directory: '/models/parakeet-ultra' })
    const ultra = engineNamed('ultra')
    pending[0]!.resolve(ultra)
    await started
    expect(manager.status()).toEqual({ state: 'ready' })
    expect(manager.currentEngine()).toBe(ultra)
    expect(statuses).toEqual([{ state: 'loading' }, { state: 'ready' }])
  })

  it('reports a chosen FluidAudio model whose folder is gone', async () => {
    const { manager, coreMlLoader } = setup({ choice: ULTRA.id, models: [] })
    await manager.start()
    expect(manager.status()).toEqual({ state: 'failed', reason: 'gone', receivedBytes: 0, totalBytes: 1 })
    expect(coreMlLoader).not.toHaveBeenCalled()
  })

  it('reports a helper that will not load, and tries again when asked', async () => {
    const { manager, pending } = setup({ choice: ULTRA.id, models: [ULTRA] })
    const started = manager.start()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.reject(new Error('load'))
    await started
    expect(manager.status()).toEqual({ state: 'failed', reason: 'engine', receivedBytes: 0, totalBytes: 1_000 })

    manager.download()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.resolve(engineNamed('ultra'))
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
  })

  it('does nothing on Try again with nothing chosen', async () => {
    const { manager, fetchFn, coreMlLoader } = setup({ models: [ULTRA] })
    await manager.start()
    manager.download()
    await manager.list()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(coreMlLoader).not.toHaveBeenCalled()
  })

  it('downloads Sotto\'s model when the user chooses it', async () => {
    const { manager, fetchFn, sottoEngine, choice } = setup()
    await manager.start()
    expect(await manager.choose(SOTTO_SPEECH_MODEL_ID)).toBe(true)
    expect(choice()).toBe(SOTTO_SPEECH_MODEL_ID)
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    expect(fetchFn).toHaveBeenCalled()
    expect(manager.currentEngine()).toBe(sottoEngine)
  })

  it('switching lets go of the model chosen before', async () => {
    await downloadSottoModel()
    const { manager, store, pending, sottoEngine, statuses } = setup({ models: [ULTRA, V2] })
    await manager.start()
    expect(await manager.choose(ULTRA.id)).toBe(true)
    expect(store.get()).toEqual({ state: 'missing' })
    expect(sottoEngine.dispose).toHaveBeenCalledTimes(1)
    const ultra = engineNamed('ultra')
    pending[0]!.resolve(ultra)
    await vi.waitFor(() => expect(manager.currentEngine()).toBe(ultra))
    // The store going back to missing is not passed on: Ultra is the chosen model by then.
    expect(statuses.slice(-2)).toEqual([{ state: 'loading' }, { state: 'ready' }])

    expect(await manager.choose(V2.id)).toBe(true)
    expect(ultra.dispose).toHaveBeenCalledTimes(1)
    expect(manager.currentEngine()).toBeNull()
    expect(manager.status()).toEqual({ state: 'loading' })
  })

  it('lets the latest choice win over a load still running, and stops the stale engine', async () => {
    const { manager, pending, statuses, choice } = setup({ models: [ULTRA, V2] })
    await manager.start()
    await manager.choose(ULTRA.id)
    await manager.choose(V2.id)
    expect(choice()).toBe(V2.id)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    const v2 = engineNamed('v2')
    pending[1]!.resolve(v2)
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    const ultra = engineNamed('ultra')
    pending[0]!.resolve(ultra)
    await vi.waitFor(() => expect(ultra.dispose).toHaveBeenCalledTimes(1))
    expect(manager.currentEngine()).toBe(v2)
    expect(statuses.filter((status) => status.state === 'ready')).toHaveLength(1)
  })

  it('refuses a model that is not on offer and changes nothing', async () => {
    const { manager, saveChoice } = setup({ models: [ULTRA] })
    await manager.start()
    expect(await manager.choose('fluidaudio:avalon-lite')).toBe(false)
    expect(await manager.choose('anything')).toBe(false)
    expect(saveChoice).not.toHaveBeenCalled()
    expect(manager.status()).toEqual({ state: 'missing' })
  })

  it('changes nothing when a choice cannot be saved', async () => {
    const { manager, coreMlLoader } = setup({ models: [ULTRA], saveFails: true })
    await manager.start()
    expect(await manager.choose(ULTRA.id)).toBe(false)
    expect(coreMlLoader).not.toHaveBeenCalled()
    expect(manager.status()).toEqual({ state: 'missing' })
  })

  it('lists Sotto\'s model first, then the FluidAudio models found', async () => {
    const { manager, setModels } = setup({ models: [ULTRA, V2] })
    const before = await manager.list()
    expect(before.map((option) => [option.id, option.source, option.installed])).toEqual([
      [SOTTO_SPEECH_MODEL_ID, 'sotto', false],
      [ULTRA.id, 'fluidaudio', true],
      [V2.id, 'fluidaudio', true],
    ])
    expect(before[0]).toMatchObject({ name: 'Parakeet v3', maker: 'NVIDIA', languages: '25 European languages', bytes: SPEECH_MODEL_BYTES })
    expect(before[1]).toMatchObject({ name: 'Parakeet Ultra', bytes: 1_000 })

    await downloadSottoModel()
    setModels([])
    expect((await manager.list()).map((option) => [option.id, option.installed])).toEqual([[SOTTO_SPEECH_MODEL_ID, true]])
  })

  it('reports a helper that stopped by itself, and Try again starts it again', async () => {
    const { manager, pending, statuses } = setup({ choice: ULTRA.id, models: [ULTRA] })
    const started = manager.start()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    let stopped: (() => void) | undefined
    pending[0]!.resolve({ ...engineNamed('ultra'), onStopped: (listener: () => void) => { stopped = listener } })
    await started
    expect(manager.status()).toEqual({ state: 'ready' })
    stopped!()
    expect(manager.status()).toEqual({ state: 'failed', reason: 'engine', receivedBytes: 0, totalBytes: ULTRA.bytes })
    expect(manager.currentEngine()).toBeNull()
    manager.download()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.resolve(engineNamed('ultra again'))
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    expect(statuses.at(-1)).toEqual({ state: 'ready' })
  })

  it('saves the running model again when settings lost it and it is chosen again', async () => {
    const { manager, pending, saveChoice, setChoice, choice } = setup({ choice: ULTRA.id, models: [ULTRA] })
    const started = manager.start()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve(engineNamed('ultra'))
    await started
    setChoice(null)
    await expect(manager.choose(ULTRA.id)).resolves.toBe(true)
    expect(saveChoice).toHaveBeenLastCalledWith(ULTRA.id)
    expect(choice()).toBe(ULTRA.id)
    expect(pending).toHaveLength(1)
  })

  it('downloads nothing at start for a download an earlier version left part-way, and resumes it once chosen', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(directory, MODEL.id), { recursive: true })
    await writeFile(join(directory, MODEL.id, 'tokens.txt.part'), DATA.subarray(0, 4))
    const { manager, choice, fetchFn } = setup()
    await manager.start()
    expect(choice()).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    await manager.choose(SOTTO_SPEECH_MODEL_ID)
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'ready' }))
    expect(fetchFn).toHaveBeenCalled()
  })
})
