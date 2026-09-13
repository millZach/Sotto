import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

import { _electron as electron } from '@playwright/test'

import { latestMigrationVersion } from '../src/main/memory/migrations.mjs'
import { listAsarEntries, readAsarText } from './asar-entries.mjs'
import { verifyPreparedAssets } from './verify-runtime.mjs'
import { verifyThirdPartyNotices } from './verify-notices.mjs'
import { verifyExternalDependencyInventories } from './release-external-dependencies.mjs'
import { releasePlatformProfile } from './release-platform-profile.mjs'
import {
  fileSha256,
  verifyBuildProvenance,
} from './release-provenance.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const profile = releasePlatformProfile()

function fail(message) {
  throw new Error(`Packaged release verification failed: ${message}`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function requireInsideRepositoryRelease(input) {
  const target = resolve(repositoryRoot, input)
  const releaseRoot = resolve(repositoryRoot, 'release')
  const child = relative(releaseRoot, target)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    fail('target must be a release subdirectory')
  }
  return target
}

function requireReleaseFile(input) {
  const target = resolve(repositoryRoot, input)
  const releaseRoot = resolve(repositoryRoot, 'release')
  const child = relative(releaseRoot, target)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    fail(`${profile.distributableLabel} must be a file inside release`)
  }
  if (!existsSync(target)) fail(`missing ${profile.distributableLabel} ${child}`)
  return target
}

export async function verifyInstallerAppAsar(installerInput, unpackedAsarPath) {
  const distributablePath = requireReleaseFile(installerInput)
  let embedded
  try {
    embedded = await profile.openDistributable(distributablePath, async (embeddedAsarPath) =>
      existsSync(embeddedAsarPath) ? await fileSha256(embeddedAsarPath) : null,
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (embedded === null) fail(`${profile.distributableLabel} does not contain resources/app.asar`)
  const unpacked = await fileSha256(unpackedAsarPath)
  if (JSON.stringify(embedded) !== JSON.stringify(unpacked)) {
    fail(`${profile.distributableLabel} embedded app.asar differs from verified ${profile.packagedDirName} app.asar`)
  }
  return { name: basename(distributablePath), ...embedded }
}

function productionModuleRoots(entries) {
  const roots = new Set()
  for (const entry of entries) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(entry)
    if (match?.[1]) roots.add(match[1])
  }
  return [...roots].sort()
}

export async function verifyPackagedMemoryStore(target) {
  const probeRoot = await mkdtemp(join(tmpdir(), 'sotto-packaged-memory-'))
  let application
  let timeout
  let stdout = ''
  let stderr = ''
  try {
    const smokeEnvironment = await profile.smokeEnvironment(probeRoot)
    application = await electron.launch({
      executablePath: profile.executablePath(target),
      args: [`--user-data-dir=${join(probeRoot, 'Chromium')}`],
      env: Object.fromEntries(Object.entries({
        ...process.env,
        ...smokeEnvironment,
        SOTTO_MEMORY_PROBE: '1',
        SOTTO_MEMORY_PROBE_USER_DATA: join(probeRoot, 'user-data'),
      }).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)),
      timeout: 45_000,
    })
    const child = application.process()
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-64 * 1024) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    // Resolve from the packaged app, not this verifier's node_modules. Loading the
    // addon and launching a child also verifies unpacked native/helper paths and ABI.
    const terminal = await application.evaluate(async ({ app }, cwd) => {
      const { createRequire } = await import('node:module')
      const { join } = await import('node:path')
      const pty = createRequire(join(app.getAppPath(), 'package.json'))('node-pty')
      return new Promise((resolveProbe, rejectProbe) => {
        let output = ''
        const child = pty.spawn(process.platform === 'win32' ? process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
          process.platform === 'win32' ? ['/d', '/c', 'echo SOTTO_PTY_PACKAGE_OK'] : ['-c', 'printf SOTTO_PTY_PACKAGE_OK'],
          { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } })
        const timeout = globalThis.setTimeout(() => { child.kill(); rejectProbe(new Error('packaged PTY timed out')) }, 10000)
        child.onData(data => { output = (output + data).slice(-4096) })
        child.onExit(({ exitCode }) => {
          globalThis.clearTimeout(timeout)
          if (exitCode !== 0 || !output.includes('SOTTO_PTY_PACKAGE_OK')) rejectProbe(new Error('packaged PTY output/exit mismatch'))
          else resolveProbe({ modules: process.versions.modules, napi: process.versions.napi, exitCode, output: 'SOTTO_PTY_PACKAGE_OK' })
        })
      })
    }, probeRoot)
    const exited = new Promise((resolveExit, rejectExit) => {
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolveExit()
        else rejectExit(new Error(`packaged app exited with code ${code}, signal ${signal}`))
      })
      timeout = globalThis.setTimeout(() => rejectExit(new Error('packaged app probe timed out')), 60_000)
    })
    // The startup flag installs this one-shot handler only in probe mode. The
    // process may exit before evaluate's reply; its exit code/output are decisive.
    void application.evaluate(({ app }) => app.quit()).catch(() => undefined)
    await exited
    let result
    try {
      result = JSON.parse(stdout.trim())
    } catch {
      throw new Error('invalid JSON evidence')
    }
    if (typeof result?.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(result.sqliteVersion) ||
        result.migrationVersion !== latestMigrationVersion || result.matchedId !== 'memory-probe' || result.fts5 !== true) {
      throw new Error('invalid store evidence')
    }
    return { ...result, terminal }
  } catch (error) {
    fail(`memory store probe failed: ${error.message}; stderr=${stderr}; stdout=${stdout.slice(-4000)}`)
  } finally {
    globalThis.clearTimeout(timeout)
    await application?.close().catch(() => undefined)
    await rm(probeRoot, { recursive: true, force: true })
  }
}

async function verifyNormalPackagedLaunch(target) {
  const executable = profile.executablePath(target)
  const smokeRoot = await mkdtemp(join(tmpdir(), 'sotto-packaged-smoke-'))
  const forbiddenE2EProfile = join(smokeRoot, 'forbidden-e2e-profile')
  const smokeEnvironment = await profile.smokeEnvironment(smokeRoot)

  let application
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${join(smokeRoot, 'Chromium')}`],
      env: Object.fromEntries(Object.entries({
        ...process.env,
        ...smokeEnvironment,
        SOTTO_E2E: '1',
        SOTTO_E2E_SCENARIO: 'success',
        SOTTO_E2E_USER_DATA: forbiddenE2EProfile,
      }).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)),
      timeout: 45_000,
    })
    const first = await application.firstWindow({ timeout: 45_000 })
    const windows = application.windows()
    const page = windows.find((candidate) => /(?:^|\/)index\.html$/.test(new URL(candidate.url()).pathname)) ?? first
    await page.waitForLoadState('domcontentloaded')
    const protocolLog = []
    const consoleLog = []
    page.on('response', (response) => {
      if (response.url().startsWith('sotto-')) protocolLog.push(`${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', (request) => {
      if (request.url().startsWith('sotto-')) protocolLog.push(`FAILED ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') consoleLog.push(message.text())
    })

    let result
    try {
      result = await page.evaluate(async () => {
      if (globalThis.sotto === undefined) throw new Error('normal preload bridge is unavailable')
      if (globalThis.sottoE2E !== undefined) throw new Error('packaged build admitted the E2E bridge')

      const [settings, runtimeResponse] = await Promise.all([
        globalThis.sotto.getSettings(),
        globalThis.fetch('sotto-runtime://runtime/ort-wasm-simd-threaded.wasm'),
      ])
      for (const method of ['transcribe', 'cancelTranscription', 'checkTranscriptionKey']) {
        if (typeof globalThis.sotto[method] !== 'function') throw new Error('transcription bridge is unavailable')
      }
      if (!runtimeResponse.ok) throw new Error(`local runtime protocol failed (${runtimeResponse.status})`)
      const runtimeHeader = new Uint8Array(await runtimeResponse.arrayBuffer(), 0, 4)
      if (runtimeHeader.join(',') !== '0,97,115,109') throw new Error('local runtime protocol returned invalid WASM')

      const context = new globalThis.AudioContext()
      const workletUrl = new globalThis.URL('audio-capture-worklet.js', globalThis.document.baseURI).href
      try {
        await context.audioWorklet.addModule(workletUrl)
      } finally {
        await context.close()
      }

      return { language: settings.language, workletUrl }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail(`${message}; protocols=${protocolLog.slice(-20).join(' | ')}; console=${consoleLog.slice(-10).join(' | ')}`)
    }

    if (!result.workletUrl.endsWith('/out/renderer/audio-capture-worklet.js')) {
      fail('worklet did not resolve relative to the packaged renderer')
    }
    if (existsSync(forbiddenE2EProfile)) fail('packaged build created the forbidden E2E profile')
    return result
  } finally {
    await application?.close().catch(() => undefined)
    await rm(smokeRoot, { recursive: true, force: true })
  }
}

export async function verifyPackagedResources(input, options = {}) {
  const target = requireInsideRepositoryRelease(input)
  const resources = profile.resourcesPath(target)
  const asarPath = join(resources, 'app.asar')
  if (existsSync(join(resources, 'runtime', 'kws'))) fail('unreviewed wake runtime must not be bundled; use an explicitly supplied local runtime')
  for (const required of [
    profile.executablePath(target),
    asarPath,
    join(resources, 'README.md'),
    join(resources, 'THIRD_PARTY_NOTICES.md'),
    // The menu-bar template icons are macOS-only extraResources.
    ...(profile.key === 'darwin'
      ? [join(resources, 'tray', 'sottoTemplate.png'), join(resources, 'tray', 'sottoTemplate@2x.png')]
      : []),
  ]) {
    if (!existsSync(required)) fail(`missing ${relative(target, required)}`)
  }

  await verifyPreparedAssets({
    runtimeRoot: join(resources, 'runtime'),
  })

  const entries = listAsarEntries(asarPath)
  for (const required of [
    'out/main/index.js',
    'out/main/wakeWorker.js',
    'out/main/external-dependencies.json',
    'out/preload/index.js',
    'out/preload/external-dependencies.json',
    'out/build-provenance.json',
    'out/renderer/index.html',
    'out/renderer/audio-capture-worklet.js',
    'package.json',
  ]) {
    if (!entries.includes(required)) fail(`app.asar is missing ${required}`)
  }
  let provenance
  try {
    provenance = await verifyBuildProvenance({
      outRoot: join(repositoryRoot, 'out'),
      asarPath,
      repositoryRoot,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const roots = productionModuleRoots(entries)
  if (JSON.stringify(roots) !== JSON.stringify(['node-addon-api', 'node-pty', 'zod'])) {
    fail(`unexpected production modules: ${roots.join(', ') || '(none)'}`)
  }

  const packagedJson = JSON.parse(readAsarText(asarPath, 'package.json'))
  if (JSON.stringify(Object.keys(packagedJson.dependencies ?? {}).sort()) !== JSON.stringify(['node-pty', 'zod'])) {
    fail('packaged dependency manifest is not minimal')
  }
  const externalInventories = {
    main: JSON.parse(readAsarText(asarPath, 'out/main/external-dependencies.json')),
    preload: JSON.parse(readAsarText(asarPath, 'out/preload/external-dependencies.json')),
  }
  try {
    verifyExternalDependencyInventories(externalInventories, roots)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const worklet = readAsarText(asarPath, 'out/renderer/audio-capture-worklet.js')
  if (!worklet.includes('sotto-audio-capture')) fail('packaged audio worklet is invalid')
  // The chunk holding audioRecorder moves as the module graph changes (it lives
  // in accelerator-*.js as of 3.4.0), so scan every renderer chunk rather than
  // pinning the check to main-*.js.
  const rendererScripts = entries
    .filter((entry) => /^out\/renderer\/assets\/[^/]+\.js$/.test(entry))
    .map((entry) => readAsarText(asarPath, entry))
    .join('\n')
  if (!rendererScripts.includes('audio-capture-worklet.js') || rendererScripts.includes('addModule("/audio-capture-worklet.js")')) {
    fail('renderer contains an unsafe root-relative worklet URL')
  }

  await verifyThirdPartyNotices({ licenseRoot: profile.licenseRoot(target), asarPath })
  const sourceNotices = await readFile(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'))
  const packagedNotices = await readFile(join(resources, 'THIRD_PARTY_NOTICES.md'))
  if (sha256(sourceNotices) !== sha256(packagedNotices)) fail('packaged notices differ from source')

  const installer = options.installer === undefined
    ? undefined
    : await verifyInstallerAppAsar(options.installer, asarPath)
  const memoryStore = await verifyPackagedMemoryStore(target)
  const smoke = await verifyNormalPackagedLaunch(target)
  const asarInfo = await stat(asarPath)
  const executableInfo = await stat(profile.executablePath(target))
  return {
    platform: profile.key,
    target: basename(target),
    asarBytes: asarInfo.size,
    asarSha256: sha256(readFileSync(asarPath)),
    executableBytes: executableInfo.size,
    provenance: {
      sourceCommit: provenance.sourceCommit,
      buildInputsRevision: provenance.buildInputsRevision,
      buildSha256: provenance.buildSha256,
      artifactCount: provenance.artifacts.length,
    },
    ...(installer === undefined ? {} : { installer }),
    memoryStore,
    smoke,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2]
  if (!input) fail('expected the packaged directory argument')
  const installerFlag = process.argv[3]
  const installer = process.argv[4]
  if ((installerFlag === undefined) !== (installer === undefined) ||
      (installerFlag !== undefined && installerFlag !== '--installer')) {
    fail(`expected optional --installer <release ${profile.distributableLabel}>`)
  }
  const result = await verifyPackagedResources(input, {
    ...(installer === undefined ? {} : { installer }),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
