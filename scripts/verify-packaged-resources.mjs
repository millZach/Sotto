import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

import { extractFile, listPackage } from '@electron/asar'
import { _electron as electron } from '@playwright/test'

import { verifyPreparedAssets } from './verify-model.mjs'
import { verifyThirdPartyNotices } from './verify-notices.mjs'
import { verifyExternalDependencyInventories } from './release-external-dependencies.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')

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

function asarText(asarPath, path) {
  const archivePath = path.replace(/^[/\\]/, '').replaceAll('/', sep).replaceAll('\\', sep)
  return extractFile(asarPath, archivePath).toString('utf8')
}

function productionModuleRoots(entries) {
  const roots = new Set()
  for (const entry of entries) {
    const match = /^\\node_modules\\((?:@[^\\]+\\)?[^\\]+)/.exec(entry)
    if (match?.[1]) roots.add(match[1].replaceAll('\\', '/'))
  }
  return [...roots].sort()
}

async function verifyNormalPackagedLaunch(target, asarPath, entries) {
  const executable = join(target, 'TalkType.exe')
  const workerEntry = entries.find((entry) =>
    /^\\out\\renderer\\assets\\worker-[^\\]+\.js$/.test(entry),
  )
  if (workerEntry === undefined) fail('transcription worker is missing from app.asar')
  const workerUrl = pathToFileURL(join(asarPath, workerEntry.slice(1))).href
  const profile = await mkdtemp(join(tmpdir(), 'talktype-packaged-smoke-'))
  const forbiddenE2EProfile = join(profile, 'forbidden-e2e-profile')
  const appData = join(profile, 'AppData', 'Roaming')
  const localAppData = join(profile, 'AppData', 'Local')
  await mkdir(appData, { recursive: true })
  await mkdir(localAppData, { recursive: true })

  let application
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${join(profile, 'Chromium')}`],
      env: {
        ...process.env,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        TALKTYPE_E2E: '1',
        TALKTYPE_E2E_SCENARIO: 'success',
        TALKTYPE_E2E_USER_DATA: forbiddenE2EProfile,
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
      if (response.url().startsWith('talktype-')) protocolLog.push(`${response.status()} ${response.url()}`)
    })
    page.on('requestfailed', (request) => {
      if (request.url().startsWith('talktype-')) protocolLog.push(`FAILED ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') consoleLog.push(message.text())
    })

    let result
    try {
      result = await page.evaluate(async ({ packagedWorkerUrl }) => {
      if (globalThis.talktype === undefined) throw new Error('normal preload bridge is unavailable')
      if (globalThis.talktypeE2E !== undefined) throw new Error('packaged build admitted the E2E bridge')

      const [settings, modelStatus, disclosures, modelResponse, runtimeResponse] = await Promise.all([
        globalThis.talktype.getSettings(),
        globalThis.talktype.getModelStatus('balanced'),
        globalThis.talktype.listModelDisclosures(),
        globalThis.fetch('talktype-model://model/Xenova/whisper-base/config.json'),
        globalThis.fetch('talktype-runtime://runtime/ort-wasm-simd-threaded.wasm'),
      ])
      if ('reason' in modelStatus || modelStatus.preset !== 'balanced' || modelStatus.state !== 'bundled') {
        throw new Error('bundled model is not available through the normal bridge')
      }
      if ('reason' in disclosures || disclosures.models.length !== 3) {
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
          preset: 'balanced',
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
    await rm(profile, { recursive: true, force: true })
  }
}

export async function verifyPackagedResources(input) {
  const target = requireInsideRepositoryRelease(input)
  const resources = join(target, 'resources')
  const asarPath = join(resources, 'app.asar')
  for (const required of [
    join(target, 'TalkType.exe'),
    asarPath,
    join(resources, 'README.md'),
    join(resources, 'THIRD_PARTY_NOTICES.md'),
  ]) {
    if (!existsSync(required)) fail(`missing ${relative(target, required)}`)
  }

  await verifyPreparedAssets({
    modelRoot: join(resources, 'models'),
    runtimeRoot: join(resources, 'runtime'),
  })

  const entries = listPackage(asarPath)
  for (const required of [
    '\\out\\main\\index.js',
    '\\out\\main\\external-dependencies.json',
    '\\out\\preload\\index.js',
    '\\out\\preload\\external-dependencies.json',
    '\\out\\renderer\\index.html',
    '\\out\\renderer\\audio-capture-worklet.js',
    '\\package.json',
  ]) {
    if (!entries.includes(required)) fail(`app.asar is missing ${required}`)
  }
  const roots = productionModuleRoots(entries)
  if (JSON.stringify(roots) !== JSON.stringify(['zod'])) {
    fail(`unexpected production modules: ${roots.join(', ') || '(none)'}`)
  }

  const packagedJson = JSON.parse(asarText(asarPath, 'package.json'))
  if (JSON.stringify(Object.keys(packagedJson.dependencies ?? {}).sort()) !== JSON.stringify(['zod'])) {
    fail('packaged dependency manifest is not minimal')
  }
  const externalInventories = {
    main: JSON.parse(asarText(asarPath, 'out/main/external-dependencies.json')),
    preload: JSON.parse(asarText(asarPath, 'out/preload/external-dependencies.json')),
  }
  try {
    verifyExternalDependencyInventories(externalInventories, roots)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const worklet = asarText(asarPath, 'out/renderer/audio-capture-worklet.js')
  if (!worklet.includes('talktype-audio-capture')) fail('packaged audio worklet is invalid')
  const rendererScripts = entries
    .filter((entry) => /^\\out\\renderer\\assets\\main-[^\\]+\.js$/.test(entry))
    .map((entry) => asarText(asarPath, entry.slice(1)))
    .join('\n')
  if (!rendererScripts.includes('audio-capture-worklet.js') || rendererScripts.includes('addModule("/audio-capture-worklet.js")')) {
    fail('renderer contains an unsafe root-relative worklet URL')
  }

  await verifyThirdPartyNotices({ packagedResources: resources, asarPath })
  const sourceNotices = await readFile(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'))
  const packagedNotices = await readFile(join(resources, 'THIRD_PARTY_NOTICES.md'))
  if (sha256(sourceNotices) !== sha256(packagedNotices)) fail('packaged notices differ from source')

  const smoke = await verifyNormalPackagedLaunch(target, asarPath, entries)
  const asarInfo = await stat(asarPath)
  const executableInfo = await stat(join(target, 'TalkType.exe'))
  return {
    target: basename(target),
    asarBytes: asarInfo.size,
    asarSha256: sha256(readFileSync(asarPath)),
    executableBytes: executableInfo.size,
    smoke,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2]
  if (!input) fail('expected the packaged directory argument')
  const result = await verifyPackagedResources(input)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
