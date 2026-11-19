// Electron baseline for the native-UI bake-off (issue #2689).
//
// Drives today's built Sotto (out/) the way the GPUI prototype is driven: 200 earlier messages and the last ask in
// one thread, then the reply streamed as 20-character chunks on a 16 ms schedule. Measures frame intervals over the
// whole stream with a requestAnimationFrame loop, Long Animation Frames, and memory of the whole process tree three
// seconds after the stream ends.
//
// Run from the repository root, after `npm run build`:
//   node native-ui-gpui/electron-baseline/measure.mjs            one measured run, writes result.json
//   node native-ui-gpui/electron-baseline/measure.mjs --screenshot   also restarts the stream once and saves mid-stream.png
//   node native-ui-gpui/electron-baseline/measure.mjs --hold      streams in a loop until electron-baseline/stop exists
//
// Options: --out <file.json>, --probe <probe.exe>, --profile-keep (default) / --profile-fresh.

import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback }

const HOLD = flag('--hold')
const SCREENSHOT = flag('--screenshot')
const OUT = resolve(option('--out', join(here, 'result.json')))
const STOP = join(here, 'stop')
const WIDTH = 1600, HEIGHT = 1000
const CHUNK_CHARS = 20, CHUNK_MS = 16
const THREAD = 'workshop' // a thread the e2e 'success' scenario already has
const REPLY_ID = 'baseline-reply'
const END_MARKER = 'checklist before merging'
const probeExe = option('--probe', ['release', 'debug'].map(kind => `D:\\sotto-cargo-target\\${kind}\\probe.exe`).find(existsSync))
// A fixed owned profile (the e2e policy's sotto-e2e-* name in the temp folder), kept after the run so the plain
// launch command below opens the same settings.
const PROFILE = join(tmpdir(), 'sotto-e2e-electron-baseline')
const electronExe = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainEntry = join(repo, 'out', 'main', 'index.js')

const content = join(here, 'content')
const reply = readFileSync(join(content, 'reply.md'), 'utf8')
const earlier = JSON.parse(readFileSync(join(content, 'earlier.json'), 'utf8'))
const lastAsk = readFileSync(join(content, 'last-ask.txt'), 'utf8').trim()

/** "8:04 am" on a fixed day, so the transcript's times read the same as the GPUI build's. */
function createdAt(time, index) {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/iu.exec(String(time ?? '').trim())
  const day = Date.UTC(2026, 10, 18, 0, 0, 0)
  if (!match) return new Date(day + index * 60_000).toISOString()
  let hours = Number(match[1]) % 12
  if (match[3].toLowerCase() === 'pm') hours += 12
  return new Date(day + (hours * 60 + Number(match[2])) * 60_000 + index).toISOString()
}

const history = [
  ...earlier.map((message, index) => ({ id: `baseline-${index}`, role: message.role, text: message.text, createdAt: createdAt(message.time, index) })),
  { id: 'baseline-ask', role: 'user', text: lastAsk, createdAt: new Date(Date.parse(createdAt(earlier.at(-1)?.time, earlier.length)) + 60_000).toISOString() },
]

function environment() {
  const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: PROFILE }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function memoryOf(pid) {
  if (!probeExe) return { error: 'probe.exe not found' }
  const line = execFileSync(probeExe, ['mem', '--tree', String(pid)], { encoding: 'utf8' }).trim()
  const match = /processes: (\d+), working set: ([\d.]+) MB, private bytes: ([\d.]+) MB/u.exec(line)
  return match ? { processes: Number(match[1]), working_set_mb: Number(match[2]), private_mb: Number(match[3]), probe: line } : { probe: line }
}

async function mainWindow(app) {
  const ready = page => page.url().endsWith('/index.html')
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  if (ready(first)) return first
  return app.windows().find(ready) ?? app.waitForEvent('window', { predicate: async page => { await page.waitForLoadState('domcontentloaded'); return ready(page) } })
}

async function until(check, what, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise(done => setTimeout(done, 100))
  }
}

/**
 * Runs in the renderer: replaces the thread's history (earlier messages and the last ask), then streams the reply and,
 * when `measure` is set, records frame intervals and Long Animation Frames from the first chunk until the reply's end
 * is on screen. The generator runs on the renderer's own timers; the e2e `stream` event carries the message's whole
 * text so far, which main's fake provider stores and pushes back to the renderer through the coordinator, the way a
 * provider's update reaches it. A chunk due while the previous update is still in flight is folded into the next one,
 * as the GPUI build drains its channel.
 */
async function streamInPage(page, { measure }) {
  return page.evaluate(async ({ thread, replyId, history, reply, chunkChars, chunkMs, endMarker, measure }) => {
    const e2e = window.sottoE2E
    await e2e.agentEvent({ type: 'history', threadId: thread, text: '', messages: history, status: 'idle' })
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    const chars = Array.from(reply)
    const chunks = Math.ceil(chars.length / chunkChars)
    const frames = []
    const loaf = []
    let observer = null
    if (measure && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration, render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : null }) })
      observer.observe({ type: 'long-animation-frame', buffered: false })
    }
    const messageText = () => document.querySelector(`.thread-message[data-message-id$="${replyId}"]`)?.textContent ?? ''
    let running = true
    let shownAt = null
    let lastSendDone = false
    const tick = now => {
      frames.push(now)
      if (lastSendDone && shownAt === null && messageText().includes(endMarker)) shownAt = now
      if (running) requestAnimationFrame(tick)
    }
    const t0 = performance.now()
    if (measure) requestAnimationFrame(tick)
    let due = 0 // chunks due so far
    let sent = 0 // chunks already in an update
    let updates = 0
    let late = 0 // chunks sent more than one interval after they were due
    let inFlight = null
    const send = async () => {
      while (sent < due) {
        const upto = due
        if (performance.now() - (t0 + (upto - 1) * chunkMs) > chunkMs) late += upto - sent
        sent = upto
        updates += 1
        const done = sent >= chunks
        await e2e.agentEvent({ type: 'stream', threadId: thread, messageId: replyId, text: chars.slice(0, Math.min(chars.length, sent * chunkChars)).join(''), status: done ? 'idle' : 'running' })
      }
      inFlight = null
    }
    await new Promise(finish => {
      const step = () => {
        due = Math.min(chunks, Math.floor((performance.now() - t0) / chunkMs) + 1)
        if (!inFlight && sent < due) inFlight = send()
        if (sent >= chunks && !inFlight) { finish(); return }
        const next = t0 + due * chunkMs
        setTimeout(step, Math.max(0, next - performance.now()))
      }
      step()
    })
    const streamSentMs = performance.now() - t0
    lastSendDone = true
    if (!measure) return { chunks, updates }
    const deadline = performance.now() + 15_000
    while (shownAt === null && performance.now() < deadline) await new Promise(done => setTimeout(done, 16))
    running = false
    observer?.disconnect()
    const end = shownAt ?? performance.now()
    const during = frames.filter(at => at >= t0 && at <= end)
    const intervals = during.slice(1).map((at, i) => at - during[i])
    const summary = values => {
      if (!values.length) return null
      const sorted = [...values].sort((a, b) => a - b)
      const pick = q => sorted[Math.round((sorted.length - 1) * q)]
      const round = v => Math.round(v * 100) / 100
      return { count: sorted.length, median: round(pick(0.5)), p95: round(pick(0.95)), p99: round(pick(0.99)), max: round(sorted.at(-1)) }
    }
    const loafDuring = loaf.filter(entry => entry.start >= t0 && entry.start <= end)
    return {
      chunks, updates, late_chunks: late,
      stream_sent_ms: Math.round(streamSentMs), stream_ms: Math.round(end - t0), end_shown: shownAt !== null,
      frames: during.length,
      frame_interval_ms: summary(intervals),
      frames_over_16_7ms: intervals.filter(v => v > 16.7).length,
      frames_over_33ms: intervals.filter(v => v > 33.4).length,
      long_animation_frames: observer ? {
        count: loafDuring.length,
        duration_ms: summary(loafDuring.map(entry => entry.duration)),
        blocking_ms: summary(loafDuring.map(entry => entry.blocking)),
        total_ms: Math.round(loafDuring.reduce((sum, entry) => sum + entry.duration, 0)),
      } : 'unsupported',
      device_pixel_ratio: devicePixelRatio,
      inner: [innerWidth, innerHeight],
    }
  }, { thread: THREAD, replyId: REPLY_ID, history, reply, chunkChars: CHUNK_CHARS, chunkMs: CHUNK_MS, endMarker: END_MARKER, measure })
}

/** The window's title and the composer's centre in physical pixels from the window's top-left (frame included). */
async function composerSpot(app, page, threadKey) {
  const box = await page.locator(`section.thread-pane[data-thread-id="${threadKey}"] .prompt-editor`).first().boundingBox()
  const win = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))
    const outer = window.getBounds(), inner = window.getContentBounds()
    return { title: window.getTitle(), scale: screen.getDisplayMatching(outer).scaleFactor, outer, inner }
  })
  const dx = win.inner.x - win.outer.x, dy = win.inner.y - win.outer.y
  const at = (x, y) => [Math.round((dx + x) * win.scale), Math.round((dy + y) * win.scale)]
  return { title: win.title, scale: win.scale, window_dip: win.outer, content_dip: win.inner,
    composer_box_dip: box, composer_centre_px: box ? at(box.x + box.width / 2, box.y + box.height / 2) : null,
    composer_left_px: box ? at(box.x + 24, box.y + box.height / 2) : null }
}

async function main() {
  if (!existsSync(mainEntry)) throw new Error('out/main/index.js is missing. Run `npm run build` first.')
  if (existsSync(STOP)) rmSync(STOP)
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(PROFILE, { recursive: true })

  const launchStarted = Date.now()
  const app = await electron.launch({ args: [mainEntry], cwd: repo, env: environment() })
  const pid = app.process().pid
  try {
    let page = await mainWindow(app)
    const launchToWindowMs = Date.now() - launchStarted
    await page.evaluate(async () => {
      await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto.agents.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto.agents.command({ type: 'connect' })
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.threads-view').waitFor({ state: 'visible', timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))
      window.setContentSize(size.width, size.height)
    }, { width: WIDTH, height: HEIGHT })
    await until(() => page.evaluate(([w, h]) => innerWidth === w && Math.abs(innerHeight - h) <= 2, [WIDTH, HEIGHT]), 'the window to reach 1600x1000')
    const hostId = await page.evaluate(async () => (await window.sotto.agents.get()).hostId)
    const threadKey = hostId === undefined ? THREAD : `host:${hostId}:${THREAD}`
    await page.evaluate(async ({ thread, history }) => window.sottoE2E.agentEvent({ type: 'history', threadId: thread, text: '', messages: history, status: 'idle' }), { thread: THREAD, history })
    await page.evaluate(async id => { await window.sotto.agents.command({ type: 'select-thread', threadId: id }) }, threadKey)
    const pane = page.locator(`section.thread-pane[data-thread-id="${threadKey}"]`)
    await pane.waitFor({ state: 'visible', timeout: 30_000 })
    await pane.locator('.thread-message[data-message-id$="baseline-ask"]').waitFor({ state: 'visible', timeout: 30_000 })
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())

    const plain = `$env:SOTTO_E2E='1'; $env:SOTTO_E2E_SCENARIO='success'; $env:SOTTO_E2E_USER_DATA='${PROFILE}'; & '${electronExe}' '${mainEntry}'`

    if (HOLD) {
      const spot = await composerSpot(app, page, threadKey)
      console.log(JSON.stringify({ hold: true, pid, ...spot, stop_file: STOP }, null, 2))
      console.log(`Streaming in a loop. Create ${STOP} to stop.`)
      let round = 0
      while (!existsSync(STOP)) {
        round += 1
        const shown = await streamInPage(page, { measure: false })
        console.log(`round ${round}: ${shown.chunks} chunks in ${shown.updates} updates`)
      }
      rmSync(STOP)
      return
    }

    const stream = await streamInPage(page, { measure: true })
    await new Promise(done => setTimeout(done, 3_000))
    const memory = memoryOf(pid)
    const electronMetrics = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, working_set_mb: Math.round(metric.memory.workingSetSize / 102.4) / 10, private_mb: metric.memory.privateBytes === undefined ? null : Math.round(metric.memory.privateBytes / 102.4) / 10 })))
    const versions = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }))

    let screenshot = null
    if (SCREENSHOT) {
      const half = streamInPage(page, { measure: false })
      await new Promise(done => setTimeout(done, 10_000))
      screenshot = join(here, 'mid-stream.png')
      await page.screenshot({ path: screenshot })
      await half
    }

    const result = {
      build: 'electron', when: new Date().toISOString(), versions,
      window: { width: WIDTH, height: HEIGHT, theme: 'dark' },
      history_messages: history.length, reply_chars: Array.from(reply).length,
      launch_to_window_ms_playwright: launchToWindowMs,
      ...stream,
      memory_3s_after: memory,
      electron_app_metrics: electronMetrics,
      screenshot,
      plain_launch: plain,
    }
    writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await app.close().catch(() => undefined)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
