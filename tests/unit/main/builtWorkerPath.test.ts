// @vitest-environment node
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { build } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILT_PICTURE_WORKER, PictureMaker } from '../../../src/host/pictureMaker'
import { BUILT_GIT_LAUNCHER_WORKER } from '../../../src/main/agents/git/gitLauncher'
import { BUILT_STORE_WORKER } from '../../../src/main/agents/storeWorker'
import { BUILT_USAGE_STORE_WORKER } from '../../../src/main/agents/usageStoreClient'
import { asarUnpackedWorkerPath, resolveBuiltWorkerPath } from '../../../src/main/builtWorkerPath'
import { builtPictureWorker } from '../../fixtures/pictureWorker'
import { dataUrl, screenshotPng } from '../../fixtures/syntheticPictures'

const WORKER_FILES = [
  'threadStoreWorker.js',
  'usageStoreWorker.js',
  'gitLauncherWorker.js',
  'pictureWorker.js',
] as const

const root = resolve(import.meta.dirname, '../../..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeLayout(base: string, subdirs: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sotto-${base}-`))
  temporaryRoots.push(dir)
  for (const subdir of subdirs) await mkdir(join(dir, subdir), { recursive: true })
  return dir
}

describe('resolveBuiltWorkerPath', () => {
  it('resolves all four workers from out/main/ directly and from Rollup out/main/chunks/', async () => {
    const dir = await makeLayout('worker-layout', ['out/main/chunks'])
    const outMain = join(dir, 'out', 'main')
    const outChunks = join(outMain, 'chunks')
    for (const file of WORKER_FILES) await writeFile(join(outMain, file), '// built worker\n')

    for (const file of WORKER_FILES) {
      const expected = join(outMain, file)
      expect(resolveBuiltWorkerPath(file, outMain)).toBe(expected)
      expect(resolveBuiltWorkerPath(file, outChunks)).toBe(expected)
      expect(resolveBuiltWorkerPath(file, `${outChunks}/`)).toBe(expected)
      expect(existsSync(resolveBuiltWorkerPath(file, outChunks))).toBe(true)
    }
  })

  it('resolves workers in an unchunked or chunked headless out/host/ layout', async () => {
    const dir = await makeLayout('host-worker-layout', ['out/host/chunks'])
    const outHost = join(dir, 'out', 'host')
    const outHostChunks = join(outHost, 'chunks')
    for (const file of WORKER_FILES) await writeFile(join(outHost, file), '// host worker\n')

    for (const file of WORKER_FILES) {
      const expected = join(outHost, file)
      expect(resolveBuiltWorkerPath(file, outHost)).toBe(expected)
      expect(resolveBuiltWorkerPath(file, outHostChunks)).toBe(expected)
    }
  })

  it('prefers a direct sibling even inside a chunks directory when present', async () => {
    const dir = await makeLayout('direct-in-chunks', ['out/main/chunks'])
    const outMain = join(dir, 'out', 'main')
    const outChunks = join(outMain, 'chunks')
    const direct = join(outChunks, 'threadStoreWorker.js')
    await writeFile(join(outMain, 'threadStoreWorker.js'), '// parent\n')
    await writeFile(direct, '// direct\n')

    expect(resolveBuiltWorkerPath('threadStoreWorker.js', outChunks)).toBe(direct)
  })

  it('points out/main/chunks/ at the parent out/main/ path even before the worker file is written', () => {
    const base = join(tmpdir(), 'sotto-missing-layout', 'out', 'main', 'chunks')
    expect(resolveBuiltWorkerPath('threadStoreWorker.js', base, () => false)).toBe(
      join(tmpdir(), 'sotto-missing-layout', 'out', 'main', 'threadStoreWorker.js'),
    )
  })

  it('does not climb out of source directories under Vitest so in-process test fallbacks remain intact', () => {
    for (const resolved of [BUILT_STORE_WORKER, BUILT_USAGE_STORE_WORKER, BUILT_GIT_LAUNCHER_WORKER, BUILT_PICTURE_WORKER]) {
      expect(existsSync(resolved)).toBe(false)
    }
    const sourceDir = join(root, 'src', 'main', 'agents')
    expect(resolveBuiltWorkerPath('threadStoreWorker.js', sourceDir, () => false)).toBe(
      join(sourceDir, 'threadStoreWorker.js'),
    )
  })

  it('wires all four worker modules through resolveBuiltWorkerPath rather than raw join(__dirname, ...)', async () => {
    const files = [
      'src/main/agents/storeWorker.ts',
      'src/main/agents/usageStoreClient.ts',
      'src/main/agents/git/gitLauncher.ts',
      'src/host/pictureMaker.ts',
    ]
    for (const rel of files) {
      const source = await readFile(join(root, rel), 'utf8')
      expect(source).toContain('resolveBuiltWorkerPath(')
      expect(source).not.toMatch(/join\(__dirname,\s*['"][^'"]+Worker\.js['"]\)/u)
    }
  })

  it('resolves all four built worker paths cleanly when Rollup extracts shared modules into out/main/chunks/', async () => {
    const dir = await makeLayout('rollup-chunks', ['src', 'out/main'])
    const outMain = join(dir, 'out', 'main')
    const entryA = join(dir, 'src', 'entryA.ts')
    const entryB = join(dir, 'src', 'entryB.ts')
    const sharedExports = [
      `export { BUILT_STORE_WORKER } from ${JSON.stringify(join(root, 'src', 'main', 'agents', 'storeWorker.ts'))}`,
      `export { BUILT_USAGE_STORE_WORKER } from ${JSON.stringify(join(root, 'src', 'main', 'agents', 'usageStoreClient.ts'))}`,
      `export { BUILT_GIT_LAUNCHER_WORKER } from ${JSON.stringify(join(root, 'src', 'main', 'agents', 'git', 'gitLauncher.ts'))}`,
      `export { BUILT_PICTURE_WORKER } from ${JSON.stringify(join(root, 'src', 'host', 'pictureMaker.ts'))}`,
    ].join('\n')
    await writeFile(entryA, `${sharedExports}\nexport const entry = 'index'\n`)
    await writeFile(entryB, `${sharedExports}\nexport const entry = 'engineProcess'\n`)

    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        ssr: true,
        target: 'node24',
        outDir: outMain,
        emptyOutDir: true,
        minify: false,
        copyPublicDir: false,
        rollupOptions: {
          input: { index: entryA, engineProcess: entryB },
          external: id => isBuiltin(id),
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },
    })

    // Confirm Rollup actually placed the shared worker-path definitions inside out/main/chunks/.
    const chunksDir = join(outMain, 'chunks')
    const chunkFiles = (await readdir(chunksDir)).filter(name => name.endsWith('.js'))
    expect(chunkFiles.length).toBeGreaterThan(0)
    const chunkText = (await Promise.all(chunkFiles.map(name => readFile(join(chunksDir, name), 'utf8')))).join('\n')
    for (const file of WORKER_FILES) expect(chunkText).toContain(file)

    // Emit the four built worker scripts beside index.js / engineProcess.js, as electron.vite.config.ts does.
    for (const file of WORKER_FILES) await writeFile(join(outMain, file), '// built worker\n')

    const loadBuilt = createRequire(join(outMain, 'engineProcess.js'))
    const engineExports = loadBuilt(join(outMain, 'engineProcess.js')) as {
      BUILT_STORE_WORKER: string
      BUILT_USAGE_STORE_WORKER: string
      BUILT_GIT_LAUNCHER_WORKER: string
      BUILT_PICTURE_WORKER: string
    }

    expect(engineExports.BUILT_STORE_WORKER).toBe(join(outMain, 'threadStoreWorker.js'))
    expect(engineExports.BUILT_USAGE_STORE_WORKER).toBe(join(outMain, 'usageStoreWorker.js'))
    expect(engineExports.BUILT_GIT_LAUNCHER_WORKER).toBe(join(outMain, 'gitLauncherWorker.js'))
    expect(engineExports.BUILT_PICTURE_WORKER).toBe(join(outMain, 'pictureWorker.js'))
    for (const resolved of [
      engineExports.BUILT_STORE_WORKER,
      engineExports.BUILT_USAGE_STORE_WORKER,
      engineExports.BUILT_GIT_LAUNCHER_WORKER,
      engineExports.BUILT_PICTURE_WORKER,
    ]) {
      expect(existsSync(resolved)).toBe(true)
    }
  }, 30_000)

  it('prefers app.asar.unpacked for unpacked workers in both direct and Rollup chunk paths while leaving packed workers inside app.asar', () => {
    expect(asarUnpackedWorkerPath('C:\\Program Files\\Sotto\\resources\\app.asar\\out\\main\\pictureWorker.js')).toBe(
      'C:\\Program Files\\Sotto\\resources\\app.asar.unpacked\\out\\main\\pictureWorker.js',
    )
    expect(asarUnpackedWorkerPath('/opt/sotto/resources/app.asar/out/main/pictureWorker.js')).toBe(
      '/opt/sotto/resources/app.asar.unpacked/out/main/pictureWorker.js',
    )
    expect(asarUnpackedWorkerPath('/opt/sotto/resources/app.asar.unpacked/out/main/pictureWorker.js')).toBeUndefined()

    const asarMain = join(tmpdir(), 'sotto-packaged', 'resources', 'app.asar', 'out', 'main')
    const asarChunks = join(asarMain, 'chunks')
    const unpackedPictureWorker = join(tmpdir(), 'sotto-packaged', 'resources', 'app.asar.unpacked', 'out', 'main', 'pictureWorker.js')
    const packedPictureWorker = join(asarMain, 'pictureWorker.js')
    const packedStoreWorker = join(asarMain, 'threadStoreWorker.js')
    const known = new Set([unpackedPictureWorker, packedPictureWorker, packedStoreWorker])
    const exists = (candidate: string): boolean => known.has(candidate)

    // Even though Electron's ASAR fs reports the virtual app.asar path as existing, the unpacked sibling must win.
    expect(resolveBuiltWorkerPath('pictureWorker.js', asarMain, exists)).toBe(unpackedPictureWorker)
    expect(resolveBuiltWorkerPath('pictureWorker.js', asarChunks, exists)).toBe(unpackedPictureWorker)
    // Workers not in asarUnpack stay inside app.asar.
    expect(resolveBuiltWorkerPath('threadStoreWorker.js', asarMain, exists)).toBe(packedStoreWorker)
    expect(resolveBuiltWorkerPath('threadStoreWorker.js', asarChunks, exists)).toBe(packedStoreWorker)
  })

  it('resolves an ASAR-unpacked pictureWorker.js and resizes a PNG at edge=640 in a child process', async () => {
    const dir = await makeLayout('packaged-picture-worker', ['stage/out/main/chunks', 'resources'])
    const built = await builtPictureWorker()
    const makers: PictureMaker[] = []
    try {
      await copyFile(built.path, join(dir, 'stage', 'out', 'main', 'pictureWorker.js'))
      await writeFile(join(dir, 'stage', 'out', 'main', 'chunks', 'shared.js'), '// chunk\n')
      await writeFile(join(dir, 'stage', 'package.json'), '{}')
      const asarPath = join(dir, 'resources', 'app.asar')
      await createPackageWithOptions(join(dir, 'stage'), asarPath, { unpack: 'pictureWorker.js' })

      const chunkDirInsideAsar = join(asarPath, 'out', 'main', 'chunks')
      const resolvedWorker = resolveBuiltWorkerPath('pictureWorker.js', chunkDirInsideAsar)
      const expectedUnpacked = join(dir, 'resources', 'app.asar.unpacked', 'out', 'main', 'pictureWorker.js')
      expect(resolvedWorker).toBe(expectedUnpacked)
      expect(PictureMaker.available(resolvedWorker)).toBe(true)

      const pngBytes = await screenshotPng()
      const original = dataUrl('image/png', pngBytes)
      const maker = new PictureMaker(resolvedWorker)
      makers.push(maker)
      const reduced = await maker.reduce(original, 640)
      expect(reduced).not.toBeNull()
      expect(reduced!.startsWith('data:image/jpeg;base64,')).toBe(true)
      expect(reduced!.length).toBeLessThan(original.length / 4)
      expect(maker.made).toBe(1)
      expect(maker.lastFailure).toBeUndefined()
    } finally {
      await Promise.all(makers.map(maker => maker.close()))
      await built.dispose()
    }
  }, 30_000)
})
