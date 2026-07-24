import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MODEL_SCHEME,
  RUNTIME_SCHEME,
  registerModelSchemesAsPrivileged,
  registerLocalAssetProtocols,
  loadVerifiedRuntimeSource,
  resolveModelRequest,
  resolveRuntimeRequest,
} from '../../../src/main/models/modelProtocol'

const files = new Set(['config.json', 'onnx/encoder_model_quantized.onnx'])
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('model protocols', () => {
  it('registers both schemes as secure standard fetch-enabled CORS schemes', () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerModelSchemesAsPrivileged({ registerSchemesAsPrivileged })
    expect(registerSchemesAsPrivileged).toHaveBeenCalledOnce()
    expect(registerSchemesAsPrivileged.mock.calls[0]?.[0]).toEqual([
      { scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
      { scheme: RUNTIME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    ])
  })

  it('resolves only exact manifest-listed canonical model paths under the selected root', async () => {
    const boundaryRoot = await mkdtemp(join(tmpdir(), 'sotto-protocol-')); roots.push(boundaryRoot)
    const root = join(boundaryRoot, 'Xenova', 'whisper-base')
    await mkdir(root, { recursive: true }); await writeFile(join(root, 'config.json'), '{}')
    await expect(resolveModelRequest('sotto-model://model/Xenova/whisper-base/config.json', { 'Xenova/whisper-base': { root, boundaryRoot, files } }))
      .resolves.toBe(join(root, 'config.json'))
  })

  it.each([
    'https://model/Xenova/whisper-base/config.json', 'sotto-model://other/Xenova/whisper-base/config.json',
    'sotto-model://model/Xenova/whisper-base/config.json?x=1', 'sotto-model://model/Xenova/whisper-base/config.json#x',
    'sotto-model://user:pass@model/Xenova/whisper-base/config.json', 'sotto-model://model:42/Xenova/whisper-base/config.json',
    'sotto-model://model/Xenova/whisper-base/../config.json', 'sotto-model://model/Xenova/whisper-base/%2e%2e/config.json',
    'sotto-model://model/Xenova/whisper-base/%252e%252e/config.json', 'sotto-model://model/Xenova/whisper-base/onnx%2fencoder_model_quantized.onnx',
    'sotto-model://model/Xenova/whisper-base/onnx%252fencoder_model_quantized.onnx',
    'sotto-model://model/Xenova/whisper-base/config%2ejson',
    'sotto-model://model/Xenova/whisper-base/onnx%5cencoder_model_quantized.onnx', 'sotto-model://model/Xenova/whisper-base/missing.json',
    'sotto-model:/model/Xenova/whisper-base/config.json', 'sotto-model:///Xenova/whisper-base/config.json',
    'sotto-model://model//Xenova/whisper-base/config.json', 'SOTTO-MODEL://model/Xenova/whisper-base/config.json',
    'sotto-model://MODEL/Xenova/whisper-base/config.json', 'sotto-model://model/Xenova/whisper-base/config.json\0',
    'sotto-model://model/Xenova/whisper-base/config.json%00', String.raw`sotto-model://model/Xenova\whisper-base\config.json`,
  ])('rejects unsafe or unlisted model URL %s', async (url) => {
    await expect(resolveModelRequest(url, { 'Xenova/whisper-base': { root: 'C:/models/Xenova/whisper-base', boundaryRoot: 'C:/models', files } })).rejects.toThrow()
  })

  it('resolves runtime files only from the exact host and allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-protocol-')); roots.push(root)
    await writeFile(join(root, 'ort-wasm-simd-threaded.wasm'), 'runtime')
    await expect(resolveRuntimeRequest('sotto-runtime://runtime/ort-wasm-simd-threaded.wasm', {
      root, boundaryRoot: root, files: new Set(['ort-wasm-simd-threaded.wasm']),
    })).resolves.toBe(join(root, 'ort-wasm-simd-threaded.wasm'))
    await expect(resolveRuntimeRequest('sotto-runtime://other/ort-wasm-simd-threaded.wasm', {
      root, boundaryRoot: root, files: new Set(['ort-wasm-simd-threaded.wasm']),
    })).rejects.toThrow()
  })

  it('rejects model files reached through a parent junction outside the trusted boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-protocol-')); roots.push(root)
    const boundaryRoot = join(root, 'models')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'config.json'), '{}')
    await mkdir(boundaryRoot)
    await symlink(outside, join(boundaryRoot, 'repository'), 'junction')

    await expect(resolveModelRequest('sotto-model://model/Xenova/whisper-base/config.json', {
      'Xenova/whisper-base': {
        root: join(boundaryRoot, 'repository'),
        boundaryRoot,
        files: new Set(['config.json']),
      },
    })).rejects.toMatchObject({ code: 'MODEL_PATH_DENIED' })
  })

  it('loads a runtime source only after exact manifest, file-set, size, and hash verification', async () => {
    const root = await runtimeFixture()

    await expect(loadVerifiedRuntimeSource(root)).resolves.toMatchObject({
      root,
      boundaryRoot: root,
      files: new Set([
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.asyncify.mjs',
        'ort-wasm-simd-threaded.asyncify.wasm',
      ]),
    })
  })

  it.each(['extra-file', 'size', 'hash', 'manifest-field', 'file-field', 'file-order', 'duplicate'] as const)(
    'rejects runtime manifest drift: %s',
    async (mutation) => {
      const root = await runtimeFixture()
      const paths = [
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.asyncify.mjs',
        'ort-wasm-simd-threaded.asyncify.wasm',
      ]
      const records = paths.map((path) => ({
        path,
        bytes: Buffer.from(path).length,
        sha256: createHash('sha256').update(path).digest('hex'),
      }))
      const manifest: Record<string, unknown> = { version: 1, files: records }
      if (mutation === 'extra-file') await writeFile(join(root, 'stale.wasm'), 'stale')
      if (mutation === 'size') records[0]!.bytes += 1
      if (mutation === 'hash') records[0]!.sha256 = '0'.repeat(64)
      if (mutation === 'manifest-field') manifest.injected = true
      if (mutation === 'file-field') Reflect.set(records[0]!, 'injected', true)
      if (mutation === 'file-order') records.reverse()
      if (mutation === 'duplicate') records[1] = { ...records[0]! }
      await writeFile(join(root, 'manifest.lock.json'), JSON.stringify(manifest))

      await expect(loadVerifiedRuntimeSource(root)).rejects.toThrow('Invalid runtime assets')
    },
  )

  it('rejects a runtime root reached through a directory junction', async () => {
    const actualRoot = await runtimeFixture()
    const parent = await mkdtemp(join(tmpdir(), 'sotto-runtime-junction-')); roots.push(parent)
    const linkedRoot = join(parent, 'runtime')
    await symlink(actualRoot, linkedRoot, 'junction')

    await expect(loadVerifiedRuntimeSource(linkedRoot)).rejects.toThrow('Invalid runtime assets')
  })

  it('installs GET-only file-backed handlers and cleanly owns them', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 'sotto-handlers-')); roots.push(assetRoot)
    const modelRoot = join(assetRoot, 'models', 'Xenova', 'whisper-base')
    const runtimeRoot = join(assetRoot, 'runtime')
    await mkdir(modelRoot, { recursive: true }); await mkdir(runtimeRoot)
    await writeFile(join(modelRoot, 'config.json'), '{}'); await writeFile(join(runtimeRoot, 'ort.wasm'), 'wasm')
    const handlers = new Map<string, (request: { method: string; url: string }) => Promise<Response>>()
    const protocol = { handle: vi.fn(async (scheme: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => { handlers.set(scheme, handler) }), unhandle: vi.fn(async (scheme: string) => { handlers.delete(scheme) }) }
    const fetch = vi.fn(async () => new Response('ok'))
    const cleanup = await registerLocalAssetProtocols({ protocol, net: { fetch },
      modelSources: async () => ({ 'Xenova/whisper-base': { root: modelRoot, boundaryRoot: join(assetRoot, 'models'), files: new Set(['config.json']) } }),
      runtimeSource: { root: runtimeRoot, boundaryRoot: runtimeRoot, files: new Set(['ort.wasm']) } })
    await handlers.get(MODEL_SCHEME)!({ method: 'GET', url: 'sotto-model://model/Xenova/whisper-base/config.json' })
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\//))
    await expect(handlers.get(MODEL_SCHEME)!({ method: 'POST', url: 'sotto-model://model/Xenova/whisper-base/config.json' })).resolves.toMatchObject({ status: 405 })
    await cleanup(); await cleanup()
    expect(protocol.unhandle).toHaveBeenCalledTimes(2)
  })

  it('attempts cleanup of both schemes when one unhandle fails', () => {
    const removed: string[] = []
    const cleanup = registerLocalAssetProtocols({ protocol: { handle: vi.fn(), unhandle(scheme) { removed.push(scheme); if (scheme === RUNTIME_SCHEME) throw new Error('secret') } }, net: { fetch: vi.fn() }, modelSources: async () => ({}), runtimeSource: { root: 'C:/runtime', boundaryRoot: 'C:/runtime', files: new Set() } })
    expect(() => cleanup()).toThrowError(expect.objectContaining({ code: 'PROTOCOL_CLEANUP_FAILED' }))
    expect(removed).toEqual([RUNTIME_SCHEME, MODEL_SCHEME])
    expect(() => cleanup()).not.toThrow()
  })

  it('rolls back the model scheme when runtime protocol registration fails', () => {
    const installed: string[] = []
    const removed: string[] = []
    const protocol = {
      handle(scheme: string) {
        if (scheme === RUNTIME_SCHEME) throw new Error('private registration detail')
        installed.push(scheme)
      },
      unhandle(scheme: string) { removed.push(scheme) },
    }

    expect(() => registerLocalAssetProtocols({
      protocol,
      net: { fetch: vi.fn() },
      modelSources: async () => ({}),
      runtimeSource: { root: 'C:/runtime', boundaryRoot: 'C:/runtime', files: new Set() },
    })).toThrow('Local protocol registration failed')

    expect(installed).toEqual([MODEL_SCHEME])
    expect(removed).toEqual([MODEL_SCHEME])
  })
})

async function runtimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-source-')); roots.push(root)
  const paths = [
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]
  const records = []
  for (const path of paths) {
    const content = Buffer.from(path)
    await writeFile(join(root, path), content)
    records.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  await writeFile(join(root, 'manifest.lock.json'), JSON.stringify({ version: 1, files: records }))
  return root
}
