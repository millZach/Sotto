// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  repository: 'onnx-community/Supertonic-TTS-ONNX',
  revision: 'cff123c84b0655d9d647641f1b532c3cbb8f7faa',
  paths: ['LICENSE', 'config.json', 'tokenizer.json', 'tokenizer_config.json',
    ...['text_encoder', 'latent_denoiser', 'voice_decoder'].flatMap(name => [`onnx/${name}.onnx`, `onnx/${name}.onnx_data`]),
    ...['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'].map(name => `voices/${name}.bin`)],
}))
vi.mock('../../../src/main/agents/speechModelManifest.json', async () => {
  const { createHash } = await import('node:crypto')
  return { default: {
    version: 1, repository: fixture.repository, revision: fixture.revision, license: 'OpenRAIL-M',
    files: fixture.paths.map(path => ({ path, bytes: Buffer.byteLength(path),
      sha256: createHash('sha256').update(path).digest('hex'),
      url: `https://huggingface.co/${fixture.repository}/resolve/${fixture.revision}/${path}` })),
  } }
})

import { NaturalSpeechModels } from '../../../src/main/agents/speechModels'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = resolve(root)
    if (!resolved.startsWith(`${resolve(tmpdir())}${sep}sotto-speech-models-`)) throw new Error('Unexpected test directory')
    await rm(resolved, { recursive: true, force: true })
  }
})

async function setup(download?: (url: string, target: string, bytes: number) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-speech-models-'))
  roots.push(root)
  const userRoot = join(root, 'models')
  const downloader = vi.fn(download ?? (async (url: string, target: string) => {
    await writeFile(target, url.split(`/${fixture.revision}/`)[1]!)
  }))
  const manager = new NaturalSpeechModels(userRoot, { downloader })
  return { root, userRoot, downloader, manager, installed: join(userRoot, ...fixture.repository.split('/')) }
}

describe('NaturalSpeechModels', () => {
  it('does not download on status or protocol lookup, then publishes all verified files only after explicit download', async () => {
    const { manager, downloader, userRoot } = await setup()
    expect(await manager.status()).toEqual({ ready: false, completedBytes: 0, totalBytes: fixture.paths.reduce((n, p) => n + Buffer.byteLength(p), 0) })
    expect(await manager.protocolSources()).toEqual({})
    expect(downloader).not.toHaveBeenCalled()
    const downloaded = await manager.download()
    expect(downloaded.ready).toBe(true)
    expect(downloaded.completedBytes).toBe(downloaded.totalBytes)
    const source = (await manager.protocolSources())[fixture.repository]!
    expect(source.boundaryRoot).toBe(userRoot)
    expect([...source.files].sort()).toEqual([...fixture.paths].sort())
    const restarted = new NaturalSpeechModels(userRoot, { downloader })
    expect((await restarted.status()).ready).toBe(true)
    await restarted.download()
    expect(downloader).toHaveBeenCalledTimes(fixture.paths.length)
  })

  it('deduplicates concurrent downloads and keeps incomplete assets out of the protocol', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    const { manager, downloader } = await setup(async (url, target) => {
      entered()
      await gate
      await writeFile(target, url.split(`/${fixture.revision}/`)[1]!)
    })
    const first = manager.download()
    const second = manager.download()
    await started
    expect(await manager.protocolSources()).toEqual({})
    expect((await manager.status()).ready).toBe(false)
    release()
    await Promise.all([first, second])
    expect(downloader).toHaveBeenCalledTimes(fixture.paths.length)
  })

  it('rejects wrong hashes, removes partial staging, and allows a subsequent explicit retry', async () => {
    let corrupt = true
    const { manager, userRoot } = await setup(async (url, target) => {
      const text = url.split(`/${fixture.revision}/`)[1]!
      await writeFile(target, corrupt ? 'x'.repeat(text.length) : text)
    })
    await expect(manager.download()).rejects.toThrow('Natural voice download failed')
    expect(await manager.protocolSources()).toEqual({})
    expect(await readdir(join(userRoot, 'onnx-community'))).toEqual([])
    corrupt = false
    expect((await manager.download()).ready).toBe(true)
  })

  it('detects same-size tampering after a successful integrity cache and repairs on explicit download', async () => {
    const { manager, installed, downloader } = await setup()
    await manager.download()
    await manager.protocolSources()
    const target = join(installed, 'voices', 'F1.bin')
    await writeFile(target, 'x'.repeat(Buffer.byteLength('voices/F1.bin')))
    expect(await manager.protocolSources()).toEqual({})
    expect((await manager.status()).ready).toBe(false)
    await manager.download()
    expect(await readFile(target, 'utf8')).toBe('voices/F1.bin')
    expect(downloader).toHaveBeenCalledTimes(fixture.paths.length * 2)
  })

  it('rejects an owner directory junction before downloading or writing outside the models root', async () => {
    const { root, manager, userRoot, downloader } = await setup()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(userRoot)
    await symlink(outside, join(userRoot, 'onnx-community'), 'junction')
    await expect(manager.download()).rejects.toThrow('Natural voice download failed')
    expect(downloader).not.toHaveBeenCalled()
    expect(await readdir(outside)).toEqual([])
  })

  it('does not expose a model directory replaced by a junction after verification', async () => {
    const { root, manager, installed } = await setup()
    await manager.download()
    await manager.protocolSources()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await rm(installed, { recursive: true, force: true })
    await symlink(outside, installed, 'junction')
    expect(await manager.protocolSources()).toEqual({})
    await expect(manager.download()).rejects.toThrow('Natural voice download failed')
  })

  it('locks the production assets and includes every external ONNX data file and all ten voices', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'src/main/agents/speechModelManifest.json'), 'utf8')) as {
      repository: string; revision: string; files: { path: string; url: string; bytes: number; sha256: string }[]
    }
    expect(manifest.repository).toBe(fixture.repository)
    expect(manifest.revision).toBe(fixture.revision)
    expect(manifest.files.map(file => file.path).sort()).toEqual([...fixture.paths].sort())
    expect(manifest.files.reduce((n, file) => n + file.bytes, 0)).toBeGreaterThan(260_000_000)
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(new URL(file.url).hostname).toBe('huggingface.co')
      expect(file.url).not.toContain('/main/')
    }
    const license = await readFile(join(process.cwd(), 'docs/notices/supertonic-LICENSE.txt'))
    expect(createHash('sha256').update(license).digest('hex')).toBe(manifest.files.find(f => f.path === 'LICENSE')!.sha256)
  })
})
