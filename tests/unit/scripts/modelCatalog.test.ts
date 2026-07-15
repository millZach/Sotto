import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MODEL_CATALOG as SHARED_CATALOG } from '../../../src/shared/modelCatalog'
import {
  MODEL_CATALOG,
  MODEL_FILE_ALLOWLIST,
  RUNTIME_FILE_ALLOWLIST,
  modelFileUrl,
  validateBundledManifest,
  validateCatalogLock,
  validateRuntimeManifest,
} from '../../../scripts/model-catalog.mjs'
import type { CatalogLock } from '../../../scripts/model-catalog.mjs'
import { download, fetchPinned, replaceDirectory, replacePreparedAssetSet, treeMetadata } from '../../../scripts/prepare-model.mjs'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('build-time model catalog', () => {
  it('matches the immutable renderer disclosure catalog', () => {
    expect(Object.keys(MODEL_CATALOG)).toEqual(['fast', 'balanced', 'accurate'])
    for (const preset of Object.keys(SHARED_CATALOG) as (keyof typeof SHARED_CATALOG)[]) {
      expect(MODEL_CATALOG[preset]).toMatchObject(SHARED_CATALOG[preset])
      expect(Object.isFrozen(MODEL_CATALOG[preset])).toBe(true)
    }
    expect(Object.isFrozen(MODEL_CATALOG)).toBe(true)
  })

  it('copies only the binaries selected by Transformers 4.2.0 for WASM and WebGPU', () => {
    expect(RUNTIME_FILE_ALLOWLIST).toEqual([
      'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.asyncify.wasm',
    ])
  })

  it('has the exact transformer file allowlist', () => {
    expect(MODEL_FILE_ALLOWLIST).toEqual([
      'added_tokens.json', 'config.json', 'generation_config.json', 'merges.txt',
      'normalizer.json', 'onnx/decoder_model_merged_quantized.onnx',
      'onnx/encoder_model_quantized.onnx', 'preprocessor_config.json',
      'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json',
    ])
    expect(Object.isFrozen(MODEL_FILE_ALLOWLIST)).toBe(true)
  })

  it('creates only pinned HTTPS Hugging Face URLs', () => {
    for (const entry of Object.values(MODEL_CATALOG)) {
      for (const path of MODEL_FILE_ALLOWLIST) {
        const url = new URL(modelFileUrl(entry, path))
        expect(url.protocol).toBe('https:')
        expect(url.hostname).toBe('huggingface.co')
        expect(url.pathname).toContain(`/resolve/${entry.revision}/`)
        expect(url.pathname).not.toContain('/main/')
      }
    }
  })

  it('cancels a redirect body before fetching its target', async () => {
    const redirect = rejectedResponse(302, { location: 'https://cdn-lfs.huggingface.co/signed' })
    const success = rejectedResponse(200)
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) return redirect.response
      expect(redirect.cancel).toHaveBeenCalledOnce()
      return success.response
    })

    await expect(fetchPinned(
      'https://huggingface.co/Xenova/whisper-tiny/resolve/revision/config.json',
      { fetchImpl },
    )).resolves.toBe(success.response)
  })

  it('cancels a redirect body before rejecting a missing location', async () => {
    const redirect = rejectedResponse(302)

    await expect(fetchPinned(
      'https://huggingface.co/Xenova/whisper-tiny/resolve/revision/config.json',
      { fetchImpl: vi.fn(async () => redirect.response) },
    )).rejects.toThrow('invalid redirect')

    expect(redirect.cancel).toHaveBeenCalledOnce()
  })

  it('cancels an unsuccessful metadata response', async () => {
    const unavailable = rejectedResponse(503)

    await expect(treeMetadata(MODEL_CATALOG.fast, {
      fetchImpl: vi.fn(async () => unavailable.response),
    })).rejects.toThrow('metadata unavailable')

    expect(unavailable.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['non-OK response', () => rejectedResponse(503)],
    ['declared-size mismatch', () => rejectedResponse(200, { contentLength: '11' })],
  ] as const)('cancels each %s before retrying a model download', async (_name, responseFactory) => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const responses = [responseFactory(), responseFactory()]
    const fetchImpl = vi.fn(async () => {
      const index = fetchImpl.mock.calls.length - 1
      if (index > 0) expect(responses[index - 1]!.cancel).toHaveBeenCalledOnce()
      return responses[index]!.response
    })

    await expect(download(
      'https://huggingface.co/Xenova/whisper-tiny/resolve/revision/model.bin',
      destination,
      10,
      { attempts: 2, fetchImpl },
    )).rejects.toThrow()

    expect(responses[1]!.cancel).toHaveBeenCalledOnce()
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('rejects a missing download body, retries finitely, and removes the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const fetchImpl = vi.fn(async () => rejectedResponse(200, { body: false }).response)

    await expect(download(
      'https://huggingface.co/Xenova/whisper-tiny/resolve/revision/model.bin',
      destination,
      10,
      { attempts: 2, fetchImpl },
    )).rejects.toThrow('download unavailable')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await expect(readFile(destination)).rejects.toThrow()
  })

  it.each([
    ['catalog field', (value: CatalogLock) => { Reflect.set(value, 'injected', true) }],
    ['preset field', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'injected', true) }],
    ['file field', (value: CatalogLock) => { Reflect.set(value.presets.fast.files[0]!, 'injected', true) }],
    ['file order', (value: CatalogLock) => { value.presets.fast.files.reverse() }],
    ['unpinned URL', (value: CatalogLock) => { value.presets.fast.files[0]!.url = value.presets.fast.files[0]!.url.replace(value.presets.fast.revision, 'main') }],
    ['ONNX size', (value: CatalogLock) => { value.presets.fast.files.find((file) => file.path.includes('encoder_model'))!.bytes += 1 }],
  ] as const)('rejects hostile lock drift in %s', async (_name, mutate) => {
    const catalog = JSON.parse(await readFile(join(process.cwd(), 'resources', 'models', 'catalog.lock.json'), 'utf8')) as CatalogLock
    mutate(catalog)
    expect(() => validateCatalogLock(catalog)).toThrow('Invalid model catalog')
  })

  it('accepts only the exact bundled and runtime manifest schemas', async () => {
    const catalog = validateCatalogLock(JSON.parse(await readFile(join(process.cwd(), 'resources', 'models', 'catalog.lock.json'), 'utf8')))
    const bundled = JSON.parse(await readFile(join(process.cwd(), 'resources', 'models', 'manifest.lock.json'), 'utf8'))
    const runtime = JSON.parse(await readFile(join(process.cwd(), 'resources', 'runtime', 'manifest.lock.json'), 'utf8'))
    expect(validateBundledManifest(bundled, catalog)).toBe(bundled)
    expect(validateRuntimeManifest(runtime)).toBe(runtime)
    expect(() => validateBundledManifest({ ...bundled, injected: true }, catalog)).toThrow('Invalid model manifest')
    expect(() => validateRuntimeManifest({ ...runtime, injected: true })).toThrow('Invalid runtime manifest')
    expect(() => validateRuntimeManifest({ ...runtime, files: [...runtime.files].reverse() })).toThrow('Invalid runtime manifest')
    expect(() => validateRuntimeManifest({ ...runtime, files: [runtime.files[0], runtime.files[0]] })).toThrow('Invalid runtime manifest')
  })

  it('promotes a whole prepared directory and removes stale destination files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-')); roots.push(root)
    const destination = join(root, 'runtime')
    const temporary = join(root, 'runtime.partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'stale.wasm'), 'stale')
    await writeFile(join(temporary, 'current.wasm'), 'current')

    await replaceDirectory(temporary, destination)

    await expect(readdir(destination)).resolves.toEqual(['current.wasm'])
  })

  it('restores the prior prepared directory when promotion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-')); roots.push(root)
    const destination = join(root, 'runtime')
    await mkdir(destination)
    await writeFile(join(destination, 'prior.wasm'), 'preserved')

    await expect(replaceDirectory(join(root, 'missing.partial'), destination)).rejects.toThrow()

    await expect(readFile(join(destination, 'prior.wasm'), 'utf8')).resolves.toBe('preserved')
  })

  it('preflights every staged root before changing either prior asset directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-set-')); roots.push(root)
    const model = join(root, 'models'); const runtime = join(root, 'runtime')
    const stagedModel = join(root, 'models.partial'); const missingRuntime = join(root, 'runtime.partial')
    await mkdir(model); await mkdir(runtime); await mkdir(stagedModel)
    await writeFile(join(model, 'prior-model'), 'model')
    await writeFile(join(runtime, 'prior-runtime'), 'runtime')

    await expect(replacePreparedAssetSet([
      { temporary: stagedModel, destination: model },
      { temporary: missingRuntime, destination: runtime },
    ])).rejects.toThrow('Asset promotion failed')

    await expect(readFile(join(model, 'prior-model'), 'utf8')).resolves.toBe('model')
    await expect(readFile(join(runtime, 'prior-runtime'), 'utf8')).resolves.toBe('runtime')
  })

  it('rolls back both prior roots when the second asset promotion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-prepare-set-')); roots.push(root)
    const model = join(root, 'models'); const runtime = join(root, 'runtime')
    const stagedModel = join(root, 'models.partial'); const stagedRuntime = join(root, 'runtime.partial')
    for (const directory of [model, runtime, stagedModel, stagedRuntime]) await mkdir(directory)
    await writeFile(join(model, 'prior-model'), 'model')
    await writeFile(join(runtime, 'prior-runtime'), 'runtime')
    await writeFile(join(stagedModel, 'next-model'), 'next')
    await writeFile(join(stagedRuntime, 'next-runtime'), 'next')
    let renameCalls = 0

    await expect(replacePreparedAssetSet([
      { temporary: stagedModel, destination: model },
      { temporary: stagedRuntime, destination: runtime },
    ], {
      exists: (path) => readdir(path).then(() => true, () => false),
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls === 4) throw new Error('second promotion denied')
        await rename(from, to)
      },
      rm,
    })).rejects.toThrow('Asset promotion failed')

    await expect(readFile(join(model, 'prior-model'), 'utf8')).resolves.toBe('model')
    await expect(readFile(join(runtime, 'prior-runtime'), 'utf8')).resolves.toBe('runtime')
    await expect(readFile(join(model, 'next-model'))).rejects.toThrow()
    await expect(readFile(join(runtime, 'next-runtime'))).rejects.toThrow()
  })
})

function rejectedResponse(
  status: number,
  options: { readonly location?: string; readonly contentLength?: string; readonly body?: boolean } = {},
) {
  const cancel = vi.fn(async () => undefined)
  const headers = new Headers()
  if (options.location !== undefined) headers.set('location', options.location)
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength)
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body: options.body === false ? null : { cancel },
  } as unknown as Response
  return { response, cancel }
}
