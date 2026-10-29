// Measures what the speech model costs the main process with dictation on, after it is turned off and after it is
// turned back on (#1787). Runs the built app (`npm run build`) on a throwaway profile, chooses the model the way
// Settings does, transcribes a 16.6-second clip at each step, and prints one JSON object of memory readings from
// app.getAppMetrics(), process.memoryUsage() and, on Linux, /proc. Nothing is sent anywhere but GitHub, and only when
// the model is not already in the profile.
//
//   node scripts/measure-dictation-memory.mjs [--model parakeet-ultra-int8] [--profile <dir>] [--out <file>] [-- <electron args>]
//
// --profile keeps the profile, and the model downloaded into it, for the next run. On Linux without a display, pass
// `-- --ozone-platform=headless`.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { _electron as electron } from '@playwright/test'

const split = process.argv.indexOf('--')
const { values } = parseArgs({
  args: process.argv.slice(2, split === -1 ? undefined : split),
  options: { model: { type: 'string', default: 'parakeet-ultra-int8' }, profile: { type: 'string' }, out: { type: 'string' } },
})
const extraArgs = split === -1 ? [] : process.argv.slice(split + 1)
const profile = values.profile === undefined ? mkdtempSync(join(tmpdir(), 'sotto-dictation-memory-')) : resolve(values.profile)
const clip = canonicalWav(readFileSync(resolve('scripts/asr-bench/fixtures/speech-long.wav')))
const MB = 1024 * 1024

/**
 * The clip's 16 kHz mono PCM16 samples behind the canonical 44-byte header, the only shape main's transcriber takes
 * (`decodeWavPcm16`); the fixture's own header carries an extra fmt field.
 */
function canonicalWav(file) {
  let offset = 12
  while (offset + 8 <= file.length && file.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + file.readUInt32LE(offset + 4)
  const pcm = file.subarray(offset + 8, offset + 8 + file.readUInt32LE(offset + 4))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Whether the ONNX Runtime library is mapped into the process, read from outside it: /proc on Linux, PowerShell's
 * module list on Windows. Asking main itself (process.report) corrupted its heap on Windows (October 29 CI run).
 */
function onnxruntimeLoaded(pid) {
  try {
    if (process.platform === 'linux') return /onnxruntime/i.test(readFileSync(`/proc/${pid}/maps`, 'utf8'))
    if (process.platform === 'win32') {
      const modules = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Modules | ForEach-Object { $_.ModuleName }`], { encoding: 'utf8' })
      return /onnxruntime/i.test(modules)
    }
  } catch {
    // The process has gone, or the platform has no way to list what it loaded.
  }
  return null
}

/** Resident and anonymous (private) memory from /proc on Linux, in MB; null elsewhere or once the process is gone. */
function procMemory(pid) {
  if (process.platform !== 'linux') return null
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const field = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(status)?.[1] ?? NaN) / 1024
    return { rssMB: field('VmRSS'), rssAnonMB: field('RssAnon'), hwmMB: field('VmHWM') }
  } catch {
    return null
  }
}

const application = await electron.launch({
  args: [resolve('out/main/index.js'), `--user-data-dir=${profile}`, ...extraArgs],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('SOTTO_E2E'))),
  timeout: 120_000,
})
// How main ended, if it ends before the measurement does: a crash shows here as an exit code or signal.
let mainExit = null
application.process().once('exit', (code, signal) => { mainExit = { code, signal } })

async function reading(step) {
  const main = await application.evaluate(({ app }) => {
    const metrics = app.getAppMetrics()
    const browser = metrics.find((metric) => metric.type === 'Browser')
    const helper = metrics.find((metric) => metric.type === 'Utility' && (metric.serviceName === 'Sotto speech model' || metric.name === 'Sotto speech model'))
    const memory = process.memoryUsage()
    return { pid: process.pid, browser, helper: helper ?? null, memory, userData: app.getPath('userData') }
  })
  const toMB = (kb) => (typeof kb === 'number' ? Math.round((kb / 1024) * 10) / 10 : null)
  return {
    step,
    main: {
      workingSetMB: toMB(main.browser?.memory.workingSetSize),
      peakWorkingSetMB: toMB(main.browser?.memory.peakWorkingSetSize),
      privateMB: toMB(main.browser?.memory.privateBytes),
      rssMB: Math.round((main.memory.rss / MB) * 10) / 10,
      heapUsedMB: Math.round((main.memory.heapUsed / MB) * 10) / 10,
      proc: procMemory(main.pid),
      onnxruntimeLoaded: onnxruntimeLoaded(main.pid),
    },
    helper: main.helper === null ? null : {
      pid: main.helper.pid,
      workingSetMB: toMB(main.helper.memory.workingSetSize),
      privateMB: toMB(main.helper.memory.privateBytes),
      proc: procMemory(main.helper.pid),
    },
    userData: main.userData,
  }
}

/** The main window, not the widget: only the main window may change settings. */
async function mainWindow() {
  const deadline = Date.now() + 60_000
  for (;;) {
    const found = application.windows().find((page) => /\/index\.html/.test(page.url()))
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error('the main window did not open')
    await sleep(250)
  }
}
/** The main window once its bridge is up and main trusts it; until then a settings change is refused. */
async function readyWindow() {
  const page = await mainWindow()
  await page.waitForFunction(() => typeof globalThis.sotto?.chooseSpeechModel === 'function', undefined, { timeout: 60_000 })
  for (const deadline = Date.now() + 60_000; ;) {
    const trusted = await page.evaluate(() => globalThis.sotto.getSettings().then(() => true, () => false))
    if (trusted) return page
    if (Date.now() > deadline) throw new Error('main never trusted the main window')
    await sleep(500)
  }
}
let window

/** Waits for the speech model's state, up to `ms`; a download of 670 MB gets ten minutes. */
async function modelState(wanted, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const status = await window.evaluate(() => globalThis.sotto.getSpeechModelStatus())
    if (status.state === wanted) return status
    if (status.state === 'failed') throw new Error(`speech model failed: ${status.reason}`)
    if (Date.now() > deadline) throw new Error(`speech model is ${status.state}, not ${wanted}`)
    await sleep(500)
  }
}

async function transcribe(label) {
  const started = Date.now()
  const result = await window.evaluate(async ({ bytes, id }) => globalThis.sotto.transcribe({
    requestId: id, wav: new Uint8Array(bytes).buffer, timeoutMs: 30_000,
  }), { bytes: [...clip], id: `measure-${label}` })
  // Only whether it worked and how long it took: the words are not printed.
  return { ok: result.ok, words: result.ok ? result.text.split(/\s+/).filter(Boolean).length : 0, reason: result.ok ? undefined : result.reason, ms: Date.now() - started }
}

async function helperGone(ms) {
  const deadline = Date.now() + ms
  while ((await reading('poll')).helper !== null) {
    if (Date.now() > deadline) return false
    await sleep(250)
  }
  return true
}

const results = { platform: `${process.platform}-${process.arch}`, model: values.model, steps: [] }
// Each reading also goes to stderr as it is taken, so a run that stops part way still shows how far it got.
const push = results.steps.push.bind(results.steps)
results.steps.push = (step) => { process.stderr.write(`${JSON.stringify(step)}\n`); return push(step) }
try {
  window = await readyWindow()
  results.steps.push(await reading('started'))
  await window.evaluate((id) => globalThis.sotto.updateSettings({ dictationEnabled: true }).then(() => globalThis.sotto.chooseSpeechModel(id)), values.model)
  await modelState('ready', 600_000)
  results.steps.push({ ...(await reading('model loaded')), transcription: await transcribe('loaded') })
  results.steps.push(await reading('loaded, after one transcription'))

  await window.evaluate(() => globalThis.sotto.updateSettings({ dictationEnabled: false }))
  results.helperEndedAfterOff = await helperGone(10_000)
  await sleep(5_000)
  results.steps.push(await reading('dictation off, 5 s later'))

  await window.evaluate(() => globalThis.sotto.updateSettings({ dictationEnabled: true }))
  await modelState('ready', 120_000)
  results.steps.push({ ...(await reading('dictation back on, model loaded')), transcription: await transcribe('reloaded') })
  results.steps.push(await reading('reloaded, after one transcription'))
} catch (error) {
  // Give the process a moment to report its exit, so the error says whether main crashed.
  await sleep(1_000)
  results.error = { message: error instanceof Error ? error.message.split('\n')[0] : String(error), mainExit }
  process.exitCode = 1
} finally {
  await application.close().catch(() => undefined)
  if (values.profile === undefined) rmSync(profile, { recursive: true, force: true })
}

const output = JSON.stringify(results, null, 2)
if (values.out !== undefined) writeFileSync(values.out, `${output}\n`)
process.stdout.write(`${output}\n`)
