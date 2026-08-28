import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

import { _electron as electron } from '@playwright/test'

import { listAsarEntries, readAsarText } from './asar-entries.mjs'
import { verifyPreparedAssets } from './verify-model.mjs'
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

async function verifyNormalPackagedLaunch(target, asarPath, entries) {
  const executable = profile.executablePath(target)
  const workerEntry = entries.find((entry) =>
    /^out\/renderer\/assets\/worker-[^/]+\.js$/.test(entry),
  )
  if (workerEntry === undefined) fail('transcription worker is missing from app.asar')
  const workerUrl = pathToFileURL(join(asarPath, workerEntry)).href
  const smokeRoot = await mkdtemp(join(tmpdir(), 'sotto-packaged-smoke-'))
  const forbiddenE2EProfile = join(smokeRoot, 'forbidden-e2e-profile')
  const smokeEnvironment = await profile.smokeEnvironment(smokeRoot)

  let application
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${join(smokeRoot, 'Chromium')}`],
      env: {
        ...process.env,
        ...smokeEnvironment,
        SOTTO_E2E: '1',
        SOTTO_E2E_SCENARIO: 'success',
        SOTTO_E2E_USER_DATA: forbiddenE2EProfile,
      },
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
      result = await page.evaluate(async ({ packagedWorkerUrl }) => {
      if (globalThis.sotto === undefined) throw new Error('normal preload bridge is unavailable')
      if (globalThis.sottoE2E !== undefined) throw new Error('packaged build admitted the E2E bridge')

      const [settings, modelStatus, disclosures, modelResponse, runtimeResponse] = await Promise.all([
        globalThis.sotto.getSettings(),
        globalThis.sotto.getModelStatus('instant'),
        globalThis.sotto.listModelDisclosures(),
        globalThis.fetch('sotto-model://model/onnx-community/moonshine-base-ONNX/config.json'),
        globalThis.fetch('sotto-runtime://runtime/ort-wasm-simd-threaded.wasm'),
      ])
      if ('reason' in modelStatus || modelStatus.preset !== 'instant' || modelStatus.state !== 'bundled') {
        throw new Error('bundled model is not available through the normal bridge')
      }
      if ('reason' in disclosures || disclosures.models.length !== 2) {
        throw new Error('model disclosure bridge failed')
      }
      if (!modelResponse.ok || !runtimeResponse.ok) {
        throw new Error(`local asset protocol failed (model ${modelResponse.status}, runtime ${runtimeResponse.status})`)
      }
      await modelResponse.json()
      const runtimeHeader = new Uint8Array(await runtimeResponse.arrayBuffer(), 0, 4)
      if (runtimeHeader.join(',') !== '0,97,115,109') throw new Error('local runtime protocol returned invalid WASM')

      const context = new globalThis.AudioContext()
      const workletUrl = new globalThis.URL('audio-capture-worklet.js', globalThis.document.baseURI).href
      try {
        await context.audioWorklet.addModule(workletUrl)
      } finally {
        await context.close()
      }

      const workerResult = await new Promise((resolveResult, rejectResult) => {
        const worker = new globalThis.Worker(packagedWorkerUrl, { type: 'module' })
        const timeout = globalThis.setTimeout(() => {
          worker.terminate()
          rejectResult(new Error('local transcription worker load timed out'))
        }, 180_000)
        worker.addEventListener('error', (event) => {
          globalThis.clearTimeout(timeout)
          worker.terminate()
          rejectResult(new Error(event.message || 'local transcription worker failed'))
        }, { once: true })
        worker.addEventListener('message', (event) => {
          const message = event.data
          if (message?.requestId !== 'packaged-smoke' || message?.type === 'progress') return
          globalThis.clearTimeout(timeout)
          worker.terminate()
          if (message?.type === 'ready') resolveResult(message)
          else rejectResult(new Error(`local transcription worker returned ${String(message?.code ?? message?.type)}`))
        })
        worker.postMessage({
          type: 'load',
          requestId: 'packaged-smoke',
          preset: 'instant',
          inferencePreference: 'wasm',
        })
      })

      return {
        theme: settings.theme,
        modelState: modelStatus.state,
        workletUrl,
        workerDevice: workerResult.device,
      }
      }, { packagedWorkerUrl: workerUrl })
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
    modelRoot: join(resources, 'models'),
    runtimeRoot: join(resources, 'runtime'),
  })

  const entries = listAsarEntries(asarPath)
  for (const required of [
    'out/main/index.js',
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
  if (JSON.stringify(roots) !== JSON.stringify(['zod'])) {
    fail(`unexpected production modules: ${roots.join(', ') || '(none)'}`)
  }

  const packagedJson = JSON.parse(readAsarText(asarPath, 'package.json'))
  if (JSON.stringify(Object.keys(packagedJson.dependencies ?? {}).sort()) !== JSON.stringify(['zod'])) {
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
  const smoke = await verifyNormalPackagedLaunch(target, asarPath, entries)
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
