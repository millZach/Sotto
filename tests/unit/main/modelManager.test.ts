import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFile, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  ModelManager,
  createHttpsDownloader,
  loadBundledModelManifest,
  readBoundedJsonFile,
  replaceDirectoryAtomic,
  validateDownloadRedirect,
  type CatalogLock,
  type HttpsGet,
} from '../../../src/main/models/modelManager'
import { MODEL_DOWNLOAD_PRIVACY_NOTICE } from '../../../src/shared/contracts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const bytes = Buffer.from('verified model file')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const paths = [
  'added_tokens.json', 'config.json', 'generation_config.json', 'merges.txt', 'normalizer.json',
  'onnx/decoder_model_merged_quantized.onnx', 'onnx/encoder_model_quantized.onnx',
  'preprocessor_config.json', 'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json',
] as const
const repositories = { fast: 'Xenova/whisper-tiny', balanced: 'Xenova/whisper-base', accurate: 'Xenova/whisper-small' } as const
const revisions = { fast: '5332fcc35e32a33b86612b9a57a89be7906102b1', balanced: '64da57285918e20ea79ea5c88eed7197933abaa8', accurate: '2d67713f236afa48a18992566e7647f6ca848e13' } as const
const onnxSizes = { fast: { decoder: 30_727_765, encoder: 10_124_910 }, balanced: { decoder: 53_707_539, encoder: 23_200_850 }, accurate: { decoder: 156_780_950, encoder: 92_324_809 } } as const
const files = (preset: keyof typeof repositories) => paths.map((path) => ({ path, url: `https://huggingface.co/${repositories[preset]}/resolve/${revisions[preset]}/${path}`, bytes: path.includes('decoder_model') ? onnxSizes[preset].decoder : path.includes('encoder_model') ? onnxSizes[preset].encoder : bytes.length, sha256 }))
const lock: CatalogLock = {
  version: 1,
  presets: {
    fast: { repository: repositories.fast, revision: revisions.fast, license: 'Apache-2.0', bundled: false, files: files('fast') },
    balanced: { repository: repositories.balanced, revision: revisions.balanced, license: 'Apache-2.0', bundled: true, files: files('balanced') },
    accurate: { repository: repositories.accurate, revision: revisions.accurate, license: 'Apache-2.0', bundled: false, files: files('accurate') },
  },
}
const bundledManifest = {
  version: 1 as const,
  preset: 'balanced' as const,
  repository: lock.presets.balanced.repository,
  revision: lock.presets.balanced.revision,
  files: lock.presets.balanced.files,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'talktype-models-')); roots.push(root)
  const packagedRoot = join(root, 'packaged'); const userRoot = join(root, 'user')
  await mkdir(join(packagedRoot, 'Xenova', 'whisper-base'), { recursive: true })
  for (const file of lock.presets.balanced.files) { const path = join(packagedRoot, 'Xenova', 'whisper-base', ...file.path.split('/')); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes) }
  const downloader = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, bytes) })
  const progress = vi.fn()
  return { root, packagedRoot, userRoot, downloader, progress,
    manager: new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, downloader, onProgress: progress, verifyFile: async () => true }) }
}

describe('ModelManager', () => {
  it('returns an immutable no-network disclosure snapshot with exact locked totals', async () => {
    const { manager, downloader } = await fixture()

    const disclosure = manager.disclosures()

    expect(disclosure.optionalDownloadNotice).toBe(MODEL_DOWNLOAD_PRIVACY_NOTICE)
    expect(disclosure.models).toEqual((['fast', 'balanced', 'accurate'] as const).map((preset) => ({
      preset,
      repository: lock.presets[preset].repository,
      sourceProvider: 'Hugging Face',
      sourceHost: 'huggingface.co',
      revision: lock.presets[preset].revision,
      totalBytes: lock.presets[preset].files.reduce((total, file) => total + file.bytes, 0),
      license: 'Apache-2.0',
      bundled: preset === 'balanced',
    })))
    expect(Object.isFrozen(disclosure)).toBe(true)
    expect(Object.isFrozen(disclosure.models)).toBe(true)
    expect(disclosure.models.every(Object.isFrozen)).toBe(true)
    expect(downloader).not.toHaveBeenCalled()
  })

  it.each([
    ['repository', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'repository', 'Xenova/whisper-base') }],
    ['revision', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'revision', revisions.balanced) }],
    ['license', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'license', 'MIT') }],
    ['bundled flag', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'bundled', true) }],
    ['file order', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'files', [...value.presets.fast.files].reverse()) }],
    ['duplicate path', (value: CatalogLock) => {
      const hostile = [...value.presets.fast.files]
      hostile[1] = { ...hostile[1]!, path: hostile[0]!.path }
      Reflect.set(value.presets.fast, 'files', hostile)
    }],
    ['pinned URL', (value: CatalogLock) => {
      const hostile = [...value.presets.fast.files]
      hostile[0] = { ...hostile[0]!, url: hostile[0]!.url.replace(revisions.fast, 'main') }
      Reflect.set(value.presets.fast, 'files', hostile)
    }],
    ['declared ONNX size', (value: CatalogLock) => {
      const hostile = [...value.presets.fast.files]
      const index = hostile.findIndex((file) => file.path.includes('encoder_model'))
      hostile[index] = { ...hostile[index]!, bytes: hostile[index]!.bytes + 1 }
      Reflect.set(value.presets.fast, 'files', hostile)
    }],
    ['extra preset field', (value: CatalogLock) => { Reflect.set(value.presets.fast, 'injected', true) }],
    ['extra file field', (value: CatalogLock) => { Reflect.set(value.presets.fast.files[0]!, 'injected', true) }],
  ] as const)('rejects hostile catalog drift in %s', (_name, mutate) => {
    const hostile = structuredClone(lock)
    mutate(hostile)
    expect(() => new ModelManager({ catalog: hostile, bundledManifest, packagedRoot: 'packaged', userRoot: 'user' }))
      .toThrow('Invalid model catalog')
  })

  it('rejects a catalog-valid but altered bundled manifest before any service is available', () => {
    const hostile = structuredClone(bundledManifest)
    Reflect.set(hostile, 'injected', true)
    expect(() => new ModelManager({
      catalog: lock,
      bundledManifest: hostile,
      packagedRoot: 'packaged',
      userRoot: 'user',
    })).toThrow('Invalid bundled model manifest')
  })

  it('reports local status without network and protects bundled Balanced', async () => {
    const { manager, downloader } = await fixture()
    await expect(manager.status('balanced')).resolves.toEqual({ preset: 'balanced', state: 'bundled' })
    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'missing' })
    await expect(manager.install('balanced', { consent: true })).rejects.toThrow()
    await expect(manager.remove('balanced')).rejects.toThrow()
    expect(downloader).not.toHaveBeenCalled()
  })

  it('requires consent before downloading and validates presets first', async () => {
    const { manager, downloader } = await fixture()
    await expect(manager.install('fast', { consent: false })).rejects.toThrow()
    await expect(manager.install('bogus' as 'fast', { consent: true })).rejects.toThrow()
    expect(downloader).not.toHaveBeenCalled()
  })

  it('retains an immutable validated snapshot of the caller catalog', async () => {
    const mutable = structuredClone(lock)
    const downloader = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, bytes) })
    const root = await mkdtemp(join(tmpdir(), 'talktype-model-snapshot-')); roots.push(root)
    const manager = new ModelManager({
      catalog: mutable,
      bundledManifest,
      packagedRoot: join(root, 'packaged'),
      userRoot: join(root, 'user'),
      downloader,
      verifyFile: async () => true,
    })
    Reflect.set(mutable.presets.fast, 'repository', 'Xenova/whisper-base')
    Reflect.set(mutable.presets.fast.files[0]!, 'url', 'https://evil.invalid/model')

    expect(manager.disclosures().models[0]).toMatchObject({
      preset: 'fast',
      repository: 'Xenova/whisper-tiny',
      sourceHost: 'huggingface.co',
    })
    await manager.install('fast', { consent: true })

    expect(downloader).toHaveBeenCalledWith(lock.presets.fast.files[0]!.url, expect.any(String), lock.presets.fast.files[0]!.bytes)
    expect(await manager.protocolSources()).toHaveProperty('Xenova/whisper-tiny')
  })

  it('reports bundled assets as error when shipped files are unavailable without network', async () => {
    const { root, userRoot, downloader } = await fixture()
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot: join(root, 'missing'), userRoot, downloader })
    await expect(manager.status('balanced')).resolves.toEqual({ preset: 'balanced', state: 'error' })
    expect(downloader).not.toHaveBeenCalled()
  })

  it('contains progress observer failures', async () => {
    const { packagedRoot, userRoot, downloader } = await fixture()
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, downloader, verifyFile: async () => true, onProgress: () => { throw new Error('renderer gone') } })
    await expect(manager.install('fast', { consent: true })).resolves.toBeUndefined()
  })

  it('installs atomically with private monotonic progress and supports safe removal', async () => {
    const { manager, downloader, progress, userRoot } = await fixture()
    await manager.install('fast', { consent: true })
    expect(downloader).toHaveBeenCalledWith(lock.presets.fast.files[0]?.url, expect.stringContaining('.partial-'), lock.presets.fast.files[0]?.bytes)
    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'ready' })
    const progressValues = progress.mock.calls.map(([value]) => value)
    expect(progressValues[0]).toEqual({ preset: 'fast', completedBytes: 0, totalBytes: lock.presets.fast.files.reduce((sum, file) => sum + file.bytes, 0) })
    expect(progressValues.at(-1)?.completedBytes).toBe(progressValues.at(-1)?.totalBytes)
    expect(JSON.stringify(progress.mock.calls)).not.toContain('huggingface')
    expect(JSON.parse(await readFile(join(userRoot, 'Xenova', 'whisper-tiny', 'manifest.lock.json'), 'utf8')).preset).toBe('fast')
    await manager.remove('fast')
    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'missing' })
  })

  it('deletes a failed temporary install and preserves an existing installation', async () => {
    const { userRoot } = await fixture()
    await mkdir(join(userRoot, 'Xenova', 'whisper-tiny'), { recursive: true })
    await writeFile(join(userRoot, 'Xenova', 'whisper-tiny', 'sentinel'), 'old')
    const bad = new ModelManager({ catalog: lock, bundledManifest, packagedRoot: 'unused', userRoot,
      downloader: async (_url, destination) => writeFile(destination, 'wrong') })
    await expect(bad.install('fast', { consent: true })).rejects.toThrow()
    await expect(readFile(join(userRoot, 'Xenova', 'whisper-tiny', 'sentinel'), 'utf8')).resolves.toBe('old')
    expect((await import('node:fs/promises')).readdir(join(userRoot, 'Xenova')).then((items) => items.filter((x) => x.includes('.partial-')))).resolves.toEqual([])
  })

  it('serializes concurrent operations for the same preset', async () => {
    const { manager, downloader } = await fixture()
    await Promise.all([manager.install('fast', { consent: true }), manager.install('fast', { consent: true })])
    expect(downloader).toHaveBeenCalledTimes(12)
  })

  it('exposes only complete repositories to the read-only protocol', async () => {
    const { manager } = await fixture()
    expect(Object.keys(await manager.protocolSources())).toEqual(['Xenova/whisper-base'])
    await manager.install('fast', { consent: true })
    expect(Object.keys(await manager.protocolSources()).sort()).toEqual(['Xenova/whisper-base', 'Xenova/whisper-tiny'])
  })

  it('atomically replaces an incomplete optional installation after verification', async () => {
    const { manager, userRoot } = await fixture()
    const destination = join(userRoot, 'Xenova', 'whisper-tiny')
    await mkdir(destination, { recursive: true }); await writeFile(join(destination, 'sentinel'), 'corrupt')
    await manager.install('fast', { consent: true })
    await expect(readFile(join(destination, 'config.json'))).resolves.toEqual(bytes)
    await expect(readFile(join(destination, 'sentinel'))).rejects.toThrow()
  })

  it('does not report same-size corrupted content as ready', async () => {
    const { userRoot } = await fixture()
    const destination = join(userRoot, 'Xenova', 'whisper-tiny')
    await mkdir(destination, { recursive: true })
    for (const file of lock.presets.fast.files) { const path = join(destination, ...file.path.split('/')); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, Buffer.alloc(bytes.length, 1)) }
    await writeFile(join(destination, 'manifest.lock.json'), JSON.stringify({ version: 1, preset: 'fast', repository: lock.presets.fast.repository, revision: lock.presets.fast.revision, files: lock.presets.fast.files }))
    const strict = new ModelManager({ catalog: lock, bundledManifest, packagedRoot: 'unused', userRoot, verifyFile: async () => false, downloader: vi.fn() })
    await expect(strict.status('fast')).resolves.toEqual({ preset: 'fast', state: 'missing' })
  })

  it('caches verified readiness without rehashing on every protocol request', async () => {
    const { packagedRoot, userRoot } = await fixture()
    const verifyFile = vi.fn(async () => true)
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, verifyFile })

    await manager.protocolSources()
    await manager.protocolSources()
    await manager.status('balanced')

    expect(verifyFile).toHaveBeenCalledTimes(12)
  })

  it('does not permanently cache a missing optional installation', async () => {
    const { manager, userRoot } = await fixture()
    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'missing' })
    const destination = join(userRoot, 'Xenova', 'whisper-tiny')
    await mkdir(destination, { recursive: true })
    for (const file of lock.presets.fast.files) {
      const path = join(destination, ...file.path.split('/'))
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, bytes)
    }
    await writeFile(join(destination, 'manifest.lock.json'), `${JSON.stringify({
      version: 1,
      preset: 'fast',
      repository: lock.presets.fast.repository,
      revision: lock.presets.fast.revision,
      files: lock.presets.fast.files,
    })}\n`)

    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'ready' })
  })

  it('rejects a repository reached through a parent junction outside the managed root', async () => {
    const { root, packagedRoot } = await fixture()
    const userRoot = join(root, 'managed')
    const outside = join(root, 'outside')
    const destination = join(outside, 'whisper-tiny')
    await mkdir(destination, { recursive: true })
    for (const file of lock.presets.fast.files) {
      const path = join(destination, ...file.path.split('/'))
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, bytes)
    }
    await writeFile(join(destination, 'manifest.lock.json'), `${JSON.stringify({
      version: 1,
      preset: 'fast',
      repository: lock.presets.fast.repository,
      revision: lock.presets.fast.revision,
      files: lock.presets.fast.files,
    })}\n`)
    await mkdir(userRoot)
    await symlink(outside, join(userRoot, 'Xenova'), 'junction')
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, verifyFile: async () => true })

    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'missing' })
    expect(await manager.protocolSources()).not.toHaveProperty('Xenova/whisper-tiny')
  })

  it('refuses installation through a parent junction without writing outside the managed root', async () => {
    const { root, packagedRoot } = await fixture()
    const userRoot = join(root, 'managed-install')
    const outside = join(root, 'outside-install')
    await mkdir(userRoot)
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'preserved')
    await symlink(outside, join(userRoot, 'Xenova'), 'junction')
    const downloader = vi.fn()
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, downloader })

    await expect(manager.install('fast', { consent: true })).rejects.toThrow('Model installation failed')

    expect(downloader).not.toHaveBeenCalled()
    await expect(readFile(join(outside, 'sentinel'), 'utf8')).resolves.toBe('preserved')
    await expect(readdir(outside)).resolves.toEqual(['sentinel'])
  })

  it('refuses removal through a parent junction and preserves outside content', async () => {
    const { root, packagedRoot } = await fixture()
    const userRoot = join(root, 'managed-remove')
    const outside = join(root, 'outside-remove')
    const outsideRepository = join(outside, 'whisper-tiny')
    await mkdir(userRoot)
    await mkdir(outsideRepository, { recursive: true })
    await writeFile(join(outsideRepository, 'sentinel'), 'preserved')
    await symlink(outside, join(userRoot, 'Xenova'), 'junction')
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot })

    await expect(manager.remove('fast')).rejects.toThrow('Model removal failed')

    await expect(readFile(join(outsideRepository, 'sentinel'), 'utf8')).resolves.toBe('preserved')
  })

  it('rejects a junction used as the managed user root before installation', async () => {
    const { root, packagedRoot } = await fixture()
    const outside = join(root, 'outside-root')
    const userRoot = join(root, 'managed-root-link')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'preserved')
    await symlink(outside, userRoot, 'junction')
    const downloader = vi.fn()
    const manager = new ModelManager({ catalog: lock, bundledManifest, packagedRoot, userRoot, downloader })

    await expect(manager.install('fast', { consent: true })).rejects.toThrow('Model installation failed')

    expect(downloader).not.toHaveBeenCalled()
    await expect(readdir(outside)).resolves.toEqual(['sentinel'])
  })

  it('invalidates cached readiness before an unsafe removal failure', async () => {
    const { manager, root, userRoot } = await fixture()
    await manager.install('fast', { consent: true })
    await expect(manager.status('fast')).resolves.toEqual({ preset: 'fast', state: 'ready' })
    await rm(join(userRoot, 'Xenova'), { recursive: true, force: true })
    const outside = join(root, 'outside-after-cache')
    await mkdir(join(outside, 'whisper-tiny'), { recursive: true })
    await writeFile(join(outside, 'whisper-tiny', 'sentinel'), 'outside')
    await symlink(outside, join(userRoot, 'Xenova'), 'junction')

    await expect(manager.remove('fast')).rejects.toThrow('Model removal failed')

    expect(await manager.protocolSources()).not.toHaveProperty('Xenova/whisper-tiny')
  })
})

describe('bundled model manifest loader', () => {
  it('caps an opened lock file even when it grows after the initial stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-bounded-lock-')); roots.push(root)
    const path = join(root, 'growing.lock.json')
    await writeFile(path, '{}')

    await expect(readBoundedJsonFile(path, {
      maximumBytes: 32,
      beforeRead: () => appendFile(path, 'x'.repeat(32)),
    })).rejects.toThrow('Invalid model manifest')
  })

  it('bounded-loads and freezes the exact Balanced manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-bundled-manifest-')); roots.push(root)
    const path = join(root, 'manifest.lock.json')
    await writeFile(path, JSON.stringify(bundledManifest))

    const loaded = await loadBundledModelManifest(path, lock)

    expect(loaded).toEqual(bundledManifest)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.files)).toBe(true)
    expect(loaded.files.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    ['extra key', (value: Record<string, unknown>) => { value.injected = true }],
    ['wrong preset', (value: Record<string, unknown>) => { value.preset = 'fast' }],
    ['repository mismatch', (value: Record<string, unknown>) => { value.repository = 'Xenova/whisper-tiny' }],
    ['revision mismatch', (value: Record<string, unknown>) => { value.revision = revisions.fast }],
    ['reordered files', (value: Record<string, unknown>) => { (value.files as unknown[]).reverse() }],
    ['duplicate files', (value: Record<string, unknown>) => { const files = value.files as unknown[]; files[1] = structuredClone(files[0]) }],
    ['altered file', (value: Record<string, unknown>) => { const files = value.files as Record<string, unknown>[]; files[0]!.bytes = Number(files[0]!.bytes) + 1 }],
  ] as const)('rejects bundled manifest drift: %s', async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-bundled-manifest-')); roots.push(root)
    const path = join(root, 'manifest.lock.json')
    const hostile = structuredClone(bundledManifest) as unknown as Record<string, unknown>
    mutate(hostile)
    await writeFile(path, JSON.stringify(hostile))

    await expect(loadBundledModelManifest(path, lock)).rejects.toThrow('Invalid bundled model manifest')
  })

  it.each(['missing', 'malformed', 'oversized'] as const)('fails closed for a %s bundled manifest', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-bundled-manifest-')); roots.push(root)
    const path = join(root, 'manifest.lock.json')
    if (kind === 'malformed') await writeFile(path, '{')
    if (kind === 'oversized') await writeFile(path, ' '.repeat(1_000_001))

    await expect(loadBundledModelManifest(path, lock)).rejects.toThrow('Invalid bundled model manifest')
  })
})

describe('atomic model promotion', () => {
  it('restores the prior directory when promotion fails after backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-promotion-')); roots.push(root)
    const destination = join(root, 'model')
    const temporary = join(root, 'partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'prior'), 'preserved')
    await writeFile(join(temporary, 'next'), 'verified')
    let renameCalls = 0

    await expect(replaceDirectoryAtomic(temporary, destination, {
      rename: async (from, to) => {
        renameCalls += 1
        if (renameCalls === 2) throw new Error('promotion denied')
        await rename(from, to)
      },
      rm,
      exists: async (path) => readdir(path).then(() => true, () => false),
    })).rejects.toThrow('Model promotion failed')

    await expect(readFile(join(destination, 'prior'), 'utf8')).resolves.toBe('preserved')
    await expect(readFile(join(destination, 'next'))).rejects.toThrow()
  })

  it('treats backup cleanup failure as best effort after successful promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-promotion-')); roots.push(root)
    const destination = join(root, 'model')
    const temporary = join(root, 'partial')
    await mkdir(destination); await mkdir(temporary)
    await writeFile(join(destination, 'prior'), 'old')
    await writeFile(join(temporary, 'next'), 'verified')

    await expect(replaceDirectoryAtomic(temporary, destination, {
      rename,
      rm: async () => { throw new Error('cleanup denied') },
      exists: async (path) => readdir(path).then(() => true, () => false),
    })).resolves.toBeUndefined()

    await expect(readFile(join(destination, 'next'), 'utf8')).resolves.toBe('verified')
    await expect(readFile(join(destination, 'prior'))).rejects.toThrow()
  })
})

describe('download redirect policy', () => {
  it('permits only bounded HTTPS redirects to the explicit Hugging Face delivery hosts', () => {
    expect(validateDownloadRedirect('https://huggingface.co/a', '/signed', 0).hostname).toBe('huggingface.co')
    expect(validateDownloadRedirect('https://huggingface.co/a', 'https://us.aws.cdn.hf.co/signed', 4).hostname).toBe('us.aws.cdn.hf.co')
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'http://us.aws.cdn.hf.co/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://evil.invalid/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://user:secret@cdn-lfs.huggingface.co/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', 'https://cdn-lfs.huggingface.co:444/signed', 0)).toThrow()
    expect(() => validateDownloadRedirect('https://huggingface.co/a', '/loop', 5)).toThrow()
  })

  it('streams an approved bounded redirect response to a private destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial', 'model.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 302, location: 'https://cdn-lfs.huggingface.co/signed' }],
      ['https://cdn-lfs.huggingface.co/signed', { status: 200, chunks: [Buffer.from('verified')] }],
    ]))

    await createHttpsDownloader(get)('https://huggingface.co/model', destination, 8)

    await expect(readFile(destination, 'utf8')).resolves.toBe('verified')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('rejects redirect loops and removes the partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/a', { status: 302, location: 'https://cdn-lfs.huggingface.co/b' }],
      ['https://cdn-lfs.huggingface.co/b', { status: 302, location: 'https://huggingface.co/a' }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/a', destination, 100))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('enforces the locked byte maximum while streaming and removes partial output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 200, chunks: [Buffer.alloc(5), Buffer.alloc(6)] }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('rejects a response shorter than the exact locked byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = fakeHttpsGet(new Map([
      ['https://huggingface.co/model', { status: 200, chunks: [Buffer.alloc(9)] }],
    ]))

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('enforces an overall wall-clock deadline even while the request is not idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = vi.fn((...args: Parameters<HttpsGet>): ReturnType<HttpsGet> => {
      expect(args).toHaveLength(2)
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(milliseconds: number, callback: () => void): void
        once(event: 'error', callback: (error: Error) => void): unknown
        destroy(error: Error): void
      }
      request.setTimeout = vi.fn()
      request.destroy = (error) => request.emit('error', error)
      return request
    })
    const clear = vi.fn()
    const attempt = createHttpsDownloader(get, {
      requestMs: 1_000,
      overallMs: 50,
      timer: {
        set(callback, milliseconds) { expect(milliseconds).toBe(50); queueMicrotask(callback); return 'deadline' },
        clear,
      },
    })('https://huggingface.co/model', destination, 10)

    await expect(attempt).rejects.toThrow('Model download failed')
    expect(clear).toHaveBeenCalledWith('deadline')
    await expect(readFile(destination)).rejects.toThrow()
  })

  it('times out stalled requests and removes partial output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-download-')); roots.push(root)
    const destination = join(root, 'partial.bin')
    const get = vi.fn((...args: Parameters<HttpsGet>): ReturnType<HttpsGet> => {
      expect(args).toHaveLength(2)
      const request = new EventEmitter() as EventEmitter & {
        setTimeout(milliseconds: number, callback: () => void): void
        destroy(error: Error): void
      }
      request.setTimeout = (milliseconds, callback) => {
        expect(milliseconds).toBe(30_000)
        queueMicrotask(callback)
      }
      request.destroy = (error) => request.emit('error', error)
      return request
    })

    await expect(createHttpsDownloader(get)('https://huggingface.co/model', destination, 10))
      .rejects.toThrow('Model download failed')
    await expect(readFile(destination)).rejects.toThrow()
  })
})

interface FakeResponse {
  readonly status: number
  readonly location?: string
  readonly chunks?: readonly Buffer[]
}

function fakeHttpsGet(routes: ReadonlyMap<string, FakeResponse>) {
  return vi.fn((url: URL, callback: Parameters<HttpsGet>[1]): ReturnType<HttpsGet> => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout(milliseconds: number, callback: () => void): void
      destroy(error: Error): void
    }
    request.setTimeout = vi.fn()
    request.destroy = (error) => request.emit('error', error)
    queueMicrotask(() => {
      const route = routes.get(url.href)
      if (route === undefined) {
        request.emit('error', new Error('unexpected URL'))
        return
      }
      const response = Readable.from(route.chunks ?? []) as Readable & {
        statusCode?: number
        headers: { location?: string; 'content-length'?: string }
      }
      response.statusCode = route.status
      response.headers = route.location === undefined ? {} : { location: route.location }
      callback(response)
    })
    return request
  })
}
