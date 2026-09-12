import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { RUNTIME_FILE_ALLOWLIST, validateRuntimeManifest } from '../../../scripts/model-catalog.mjs'
import { replaceDirectory } from '../../../scripts/prepare-runtime.mjs'
import { verifyPreparedAssets } from '../../../scripts/verify-runtime.mjs'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-runtime-'))
  roots.push(root)
  const files = []
  for (const path of RUNTIME_FILE_ALLOWLIST) {
    const data = Buffer.from(path)
    await writeFile(join(root, path), data)
    files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  await writeFile(join(root, 'manifest.lock.json'), JSON.stringify({ version: 1, files }))
  return root
}

describe('natural speech runtime preparation', () => {
  it('retains both WASM runtime variants selected by Transformers', () => {
    expect(RUNTIME_FILE_ALLOWLIST).toEqual([
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.asyncify.mjs',
      'ort-wasm-simd-threaded.asyncify.wasm',
    ])
  })

  it('accepts the committed manifest and rejects schema or file-order drift', async () => {
    const runtime = JSON.parse(await readFile(join(process.cwd(), 'resources', 'runtime', 'manifest.lock.json'), 'utf8'))
    expect(validateRuntimeManifest(runtime)).toBe(runtime)
    expect(() => validateRuntimeManifest({ ...runtime, injected: true })).toThrow('Invalid runtime manifest')
    expect(() => validateRuntimeManifest({ ...runtime, files: [...runtime.files].reverse() })).toThrow('Invalid runtime manifest')
    expect(() => validateRuntimeManifest({ ...runtime, files: [runtime.files[0], runtime.files[0]] })).toThrow('Invalid runtime manifest')
  })

  it('verifies runtime integrity without any transcription model directory', async () => {
    const runtimeRoot = await runtimeFixture()
    await expect(verifyPreparedAssets({ runtimeRoot })).resolves.toEqual({ runtimeFiles: 4 })
  })

  it('rejects an unexpected runtime file', async () => {
    const runtimeRoot = await runtimeFixture()
    await writeFile(join(runtimeRoot, 'unexpected.wasm'), 'unreviewed')
    await expect(verifyPreparedAssets({ runtimeRoot })).rejects.toThrow('unexpected runtime files')
  })

  it('rejects a runtime binary whose size matches but hash changed', async () => {
    const runtimeRoot = await runtimeFixture()
    const name = RUNTIME_FILE_ALLOWLIST[0]!
    await writeFile(join(runtimeRoot, name), Buffer.alloc(Buffer.byteLength(name)))
    await expect(verifyPreparedAssets({ runtimeRoot })).rejects.toThrow('SHA-256 mismatch')
  })

  it('promotes a whole prepared directory and removes stale destination files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-prepare-')); roots.push(root)
    const destination = join(root, 'runtime')
    const temporary = join(root, 'runtime.partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'stale.wasm'), 'stale')
    await writeFile(join(temporary, 'current.wasm'), 'current')
    await replaceDirectory(temporary, destination)
    await expect(readdir(destination)).resolves.toEqual(['current.wasm'])
  })

  it('preserves the prior runtime when the staged directory is missing', async () => {
    const root = await runtimeFixture()
    const name = RUNTIME_FILE_ALLOWLIST[0]!
    await expect(replaceDirectory(join(root, 'missing.partial'), root)).rejects.toThrow()
    await expect(readFile(join(root, name), 'utf8')).resolves.toBe(name)
  })
})
