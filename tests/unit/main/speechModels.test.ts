// @vitest-environment node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

const faults = vi.hoisted(() => ({ rename: false, remove: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rm: vi.fn(async (...args: Parameters<typeof original.rm>) => {
    if (args[0] === faults.remove) throw Object.assign(new Error('private path'), { code: 'EACCES' })
    return original.rm(...args)
  }), rename: vi.fn(async (...args: Parameters<typeof original.rename>) => {
    if (faults.rename) throw Object.assign(new Error('private path'), { code: 'EACCES' })
    return original.rename(...args)
  }) }
})

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
import { deferred } from '../../fixtures/deferred'

const roots: string[] = []
afterEach(async () => {
  faults.rename = false
  faults.remove = ''
  vi.restoreAllMocks()
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
  it('sweeps interrupted staging on startup without touching installed or unrelated assets or link targets', async () => {
    const { manager, userRoot, root, downloader } = await setup()
    const parent = join(userRoot, 'onnx-community')
    await mkdir(parent, { recursive: true })
    const partial = '.Supertonic-TTS-ONNX.partial-12345678-1234-1234-1234-123456789abc'
    await mkdir(join(parent, partial))
    await writeFile(join(parent, partial, 'unfinished'), 'partial bytes')
    await mkdir(join(parent, 'Supertonic-TTS-ONNX'))
    await writeFile(join(parent, 'unrelated.partial-file'), 'keep')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'outside')
    await symlink(outside, join(parent, partial.replace('12345678', 'abcdefab')), 'junction')
    await manager.initialize()
    expect(await readdir(parent)).not.toContain(partial)
    expect(await readdir(parent)).toContain('Supertonic-TTS-ONNX')
    expect(await readFile(join(parent, 'unrelated.partial-file'), 'utf8')).toBe('keep')
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside')
    expect(downloader).not.toHaveBeenCalled()
    await manager.download()
    await manager.initialize()
    expect((await manager.status()).ready).toBe(true)
  })

  it.each([false, true])('recovers interrupted replacement when installed exists: %s', async installedExists => {
    const { manager, userRoot, installed, downloader } = await setup()
    await manager.download()
    const backup = `${installed}.backup-12345678-1234-1234-1234-123456789abc`
    await rename(installed, backup)
    if (installedExists) {
      await cp(backup, installed, { recursive: true })
    }
    const restarted = new NaturalSpeechModels(userRoot, { downloader })
    const before = downloader.mock.calls.length
    await restarted.initialize()
    expect((await restarted.status()).ready).toBe(true)
    expect(await readdir(join(userRoot, 'onnx-community'))).toEqual(['Supertonic-TTS-ONNX'])
    expect(downloader).toHaveBeenCalledTimes(before)
  })

  it('does not read installed model contents at startup when no backups need cleanup', async () => {
    const { manager, userRoot, downloader } = await setup()
    await manager.download()
    vi.mocked(createReadStream).mockClear()
    const restarted = new NaturalSpeechModels(userRoot, { downloader })
    await restarted.initialize()
    expect(createReadStream).not.toHaveBeenCalled()
  })

  it('continues partial cleanup after a backup permission error and logs only an event name', async () => {
    const { manager, installed, userRoot, downloader } = await setup()
    await manager.download()
    const backup = `${installed}.backup-12345678-1234-1234-1234-123456789abc`
    await rename(installed, backup)
    const partial = join(userRoot, 'onnx-community', '.Supertonic-TTS-ONNX.partial-12345678-1234-1234-1234-123456789abc')
    await mkdir(partial)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    faults.rename = true
    await new NaturalSpeechModels(userRoot, { downloader }).initialize()
    expect(await readdir(join(userRoot, 'onnx-community'))).toEqual([backup.split(/[\\/]/).at(-1)])
    expect(warn.mock.calls).toEqual([['natural-voice-backup-restore-failed']])
  })

  it('continues removing other temporary folders after one removal fails', async () => {
    const { manager, installed, userRoot, downloader } = await setup()
    await manager.download()
    const backup = `${installed}.backup-12345678-1234-1234-1234-123456789abc`
    await cp(installed, backup, { recursive: true })
    const partial = join(userRoot, 'onnx-community', '.Supertonic-TTS-ONNX.partial-12345678-1234-1234-1234-123456789abc')
    await mkdir(partial)
    faults.remove = backup
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await new NaturalSpeechModels(userRoot, { downloader }).initialize()
    expect(await readdir(join(userRoot, 'onnx-community'))).toEqual(['Supertonic-TTS-ONNX', backup.split(/[\\/]/).at(-1)])
    expect(warn.mock.calls).toEqual([['natural-voice-temporary-cleanup-failed']])
  })

  it('keeps backups when the installed model fails integrity verification', async () => {
    const { manager, installed, userRoot, downloader } = await setup()
    await manager.download()
    const backup = `${installed}.backup-12345678-1234-1234-1234-123456789abc`
    await cp(installed, backup, { recursive: true })
    await writeFile(join(installed, 'LICENSE'), 'x'.repeat(Buffer.byteLength('LICENSE')))
    const restarted = new NaturalSpeechModels(userRoot, { downloader })
    await restarted.initialize()
    expect((await restarted.status()).ready).toBe(false)
    expect(await readFile(join(backup, 'LICENSE'), 'utf8')).toBe('LICENSE')
  })

  it('does not restore or remove a backup directory link', async () => {
    const { manager, userRoot, root } = await setup()
    const parent = join(userRoot, 'onnx-community')
    const outside = join(root, 'outside')
    await mkdir(parent, { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'safe')
    const backup = 'Supertonic-TTS-ONNX.backup-12345678-1234-1234-1234-123456789abc'
    await symlink(outside, join(parent, backup), 'junction')
    await manager.initialize()
    expect(await readdir(parent)).toEqual([backup])
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('safe')
  })

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

    const { promise: gate, resolve: release } = deferred<void>()

    const { promise: started, resolve: entered } = deferred<void>()
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
