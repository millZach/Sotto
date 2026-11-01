// Drives the app from inside its own main process for run.mjs: no Playwright and no DevTools connection, which keep a
// covered or minimized window drawing. Written on the Windows laptop for #993 (November 1, 2026).
// OCCLUSION_DRIVE=cpu: the phase3-workspace scenario on Threads at 1280x800, two panes each streaming one reply at 20
//   updates a second through main's e2e handler (a sliding window of the last 400 words, so each update costs the same),
//   through six window states, each a 5 s settle and a 25 s sample of every process's CPU.
// OCCLUSION_DRIVE=capture: the success scenario; Workshop opens a local probe page with the agent browser tool and
//   captures it with browser_action screenshot in every window state, shown in the browser pane and hidden.
// The result goes to OCCLUSION_OUT as JSON, and the app exits.
'use strict'
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { writeFileSync } = require('node:fs')
const os = require('node:os')

const SETTLE_MS = Number(process.env.OCCLUSION_SETTLE_MS ?? 5_000)
const SAMPLE_MS = Number(process.env.OCCLUSION_SAMPLE_MS ?? 25_000)
const PANES = [['visual-gate', 'Visual gate flake'], ['footer-links', 'Footer links']]
const UPDATES_PER_SECOND = 20
const WINDOW_WORDS = 400
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { mode: process.env.OCCLUSION_DRIVE, side: process.env.OCCLUSION_SIDE, run: process.env.OCCLUSION_RUN, settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, log: [] }
const note = text => { report.log.push(`${new Date().toISOString()} ${text}`) }

let cover = null, external = null, timer = null
const mainWindow = () => BrowserWindow.getAllWindows().find(item => item !== cover && !item.isDestroyed() && item.webContents.getURL().endsWith('/index.html'))

async function waitFor(check, ms, label) {
  const deadline = Date.now() + ms
  for (;;) {
    try { const value = await check(); if (value) return value } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(200)
  }
}
const js = (code, ms = 30_000) => Promise.race([mainWindow().webContents.executeJavaScript(code, true), sleep(ms).then(() => { throw new Error(`The window did not answer in ${ms} ms.`) })])

function systemTimes() {
  return os.cpus().reduce((sum, core) => ({ idle: sum.idle + core.times.idle, total: sum.total + core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq }), { idle: 0, total: 0 })
}

function uncover() {
  if (cover && !cover.isDestroyed()) cover.destroy()
  cover = null
  if (external && external.exitCode === null) external.kill()
  external = null
}

/** Puts the main window in a state. `visible` raises it above everything, so the user's own windows cannot cover it. */
async function enter(state) {
  const win = mainWindow()
  uncover()
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(false)
  if (state === 'visible') {
    win.setAlwaysOnTop(true, 'floating'); win.moveTop(); win.focus()
    // Moving the bounds makes Windows report a location change, so Chromium works occlusion out again.
    const bounds = win.getBounds(); win.setBounds({ ...bounds, x: bounds.x + 1 }); win.setBounds(bounds)
  }
  if (state === 'covered') {
    const display = screen.getDisplayMatching(win.getBounds())
    cover = new BrowserWindow({ ...display.bounds, frame: false, show: false, backgroundColor: '#202020', skipTaskbar: true, resizable: false, movable: false, hasShadow: false, title: 'occlusion cover' })
    cover.setAlwaysOnTop(true, 'screen-saver'); cover.show(); cover.focus()
  }
  if (state === 'covered-external') {
    // Another process's window: a topmost WinForms form over the primary display, where the Sotto window sits.
    const script = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $f = New-Object System.Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.BackColor = [System.Drawing.Color]::DimGray; $f.Text = 'occlusion external cover'; [System.Windows.Forms.Application]::Run($f)"
    external = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
    note(`external cover pid ${external.pid}`)
  }
  if (state === 'minimized') win.minimize()
  if (state === 'hidden') win.hide()
}

async function restore() {
  uncover()
  const win = mainWindow()
  if (!win) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(false)
}

async function describeWindow() {
  const win = mainWindow()
  const native = { isVisible: win.isVisible(), isMinimized: win.isMinimized(), isFocused: win.isFocused(), bounds: win.getBounds() }
  const page = await js(`new Promise(resolve => { let frames = 0, counting = true; const frame = () => { if (!counting) return; frames++; requestAnimationFrame(frame) }; requestAnimationFrame(frame); setTimeout(() => { counting = false; resolve({ framesInOneSecond: frames, visibilityState: document.visibilityState }) }, 1000) })`, 6_000)
    .catch(error => ({ framesInOneSecond: null, visibilityState: `no answer: ${error.message}` }))
  return { ...native, ...page }
}

/** Each process's CPU over `ms`, as a percentage of one core: cumulative CPU time over wall time. */
async function sample(ms) {
  const win = mainWindow()
  const rendererPid = win.webContents.getOSProcessId()
  const system = systemTimes(), started = performance.now(), startedAt = new Date().toISOString()
  const startUpdates = report.stream?.updates ?? 0
  const before = new Map(app.getAppMetrics().map(metric => [metric.pid, metric.cpu.cumulativeCPUUsage]))
  await sleep(ms)
  const metrics = app.getAppMetrics()
  const seconds = (performance.now() - started) / 1000
  const after = systemTimes()
  const row = metric => ({ pid: metric.pid, type: metric.type, percentCPUUsage: Math.round(metric.cpu.percentCPUUsage * 100) / 100,
    cumulativePercent: metric.cpu.cumulativeCPUUsage === undefined || before.get(metric.pid) === undefined ? null
      : Math.round(((metric.cpu.cumulativeCPUUsage - before.get(metric.pid)) / seconds) * 10_000) / 100 })
  const rows = metrics.map(row)
  return { startedAt, seconds: Math.round(seconds * 100) / 100,
    systemPercent: Math.round((1 - (after.idle - system.idle) / (after.total - system.total)) * 1000) / 10,
    updatesEmitted: (report.stream?.updates ?? 0) - startUpdates,
    renderer: rows.find(item => item.pid === rendererPid) ?? null, main: rows.find(item => item.type === 'Browser') ?? null,
    gpu: rows.find(item => item.type === 'GPU') ?? null, all: rows }
}

async function setUp() {
  await waitFor(() => { const win = mainWindow(); return win && !win.webContents.isLoading() }, 60_000, 'the main window')
  await waitFor(() => js('Boolean(window.sotto && window.sotto.agents)', 5_000), 30_000, 'the preload bridge')
  await js(`(async () => { await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark' }); await window.sotto.agents.command({ type: 'configure', patch: { enabled: true } }); await window.sotto.agents.command({ type: 'connect' }) })()`)
  const win = mainWindow()
  win.webContents.reload()
  await sleep(500)
  await waitFor(() => { const current = mainWindow(); return current && !current.webContents.isLoading() }, 60_000, 'the reload')
  await waitFor(() => js('Boolean(window.sotto && window.sotto.agents)', 5_000), 30_000, 'the bridge after the reload')
  win.setMinimumSize(800, 540); win.setContentSize(1280, 800)
  win.setAlwaysOnTop(true, 'floating'); win.moveTop()
  await waitFor(() => js(`(() => { if (document.querySelector('.threads-view')) return true; const link = [...document.querySelectorAll('a,[role=tab]')].find(item => item.textContent.trim() === 'Threads' && !item.closest('[aria-label="Settings sections"]')); link?.click(); return false })()`, 5_000), 30_000, 'the Threads page')
  await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Thread sidebar"]'))`, 5_000), 30_000, 'the thread sidebar')
}

const clickSidebar = title => js(`(() => { const sidebar = document.querySelector('[aria-label="Thread sidebar"]'); const button = [...sidebar.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent.trim()) === ${JSON.stringify(title)} || item.textContent.trim() === ${JSON.stringify(title)}); if (!button) return false; button.click(); return true })()`)

function startStreaming() {
  // Main's own e2e handler, reached without a renderer round trip; it exists only under SOTTO_E2E.
  const handler = ipcMain._invokeHandlers?.get('sotto:e2e:agents')
  if (typeof handler !== 'function') throw new Error('The e2e agents handler is not reachable from main.')
  const win = mainWindow()
  const words = Object.fromEntries(PANES.map(([id]) => [id, []]))
  report.stream = { updates: 0, errors: 0, lastError: '' }
  timer = setInterval(() => {
    const n = report.stream.updates++
    for (const [id] of PANES) {
      const list = words[id]
      list.push(n % 40 === 39 ? `word-${n}.\n\n` : `word-${n}`)
      if (list.length > WINDOW_WORDS) list.shift()
      Promise.resolve().then(() => handler({ sender: win.webContents }, { type: 'stream', threadId: id, messageId: `occlusion-${id}`, text: `Synthetic streaming reply. ${list.join(' ')}`, status: 'running' }))
        .catch(error => { report.stream.errors++; report.stream.lastError = String(error?.message ?? error) })
    }
  }, 1000 / UPDATES_PER_SECOND)
}

async function driveCpu() {
  await setUp()
  await waitFor(() => clickSidebar(PANES[0][1]), 30_000, 'the first pane')
  await waitFor(() => js(`(() => { const button = document.querySelector('[aria-label="Open ${PANES[1][1]} beside"]'); button?.click(); return document.querySelectorAll('section.thread-pane:not([data-hidden])').length === 2 })()`, 5_000), 30_000, 'the second pane')
  startStreaming()
  await waitFor(() => js(`[...document.querySelectorAll('section.thread-pane:not([data-hidden])')].every(pane => pane.textContent.includes('word-'))`, 5_000), 30_000, 'streamed text in both panes')
  report.states = []
  const sequence = ['visible', 'covered', 'covered-external', 'minimized', 'hidden', 'visible']
  for (const [index, state] of sequence.entries()) {
    await enter(state)
    await sleep(SETTLE_MS)
    const measured = await sample(SAMPLE_MS)
    const window = await describeWindow()
    report.states.push({ state: index === sequence.length - 1 ? 'visible-again' : state, window, ...measured })
    note(`${state}: renderer ${measured.renderer?.cumulativePercent}% main ${measured.main?.cumulativePercent}% system ${measured.systemPercent}% frames ${window.framesInOneSecond}`)
    await restore()
  }
  clearInterval(timer)
}

const PROBE_PAGE = '<!doctype html><html><head><title>Occlusion probe</title><style>html,body{margin:0;height:100%;background:#ff00ff}div{position:absolute;left:10%;top:10%;width:40%;height:40%;background:#00c000}</style></head><body><div></div></body></html>'

/** One screenshot through the agent browser tool, passing when the picture is the probe page rather than a blank surface. */
async function probeCapture(target) {
  const started = Date.now()
  let value
  try {
    value = await js(`window.sottoE2E.browserAgent(${JSON.stringify({ threadId: 'workshop', name: 'browser_action', arguments: { ...target, action: { type: 'screenshot' } } })})`, 40_000)
  } catch (error) { return { ok: false, ms: Date.now() - started, error: String(error?.message ?? error) } }
  const ms = Date.now() - started
  const image = value.content.find(item => item.type === 'image')
  const text = value.content.find(item => item.type === 'text')?.text?.slice(0, 300) ?? null
  if (value.isError || !image?.data) return { ok: false, ms, isError: value.isError ?? false, text }
  const picture = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
  const { width, height } = picture.getSize()
  const bitmap = picture.toBitmap()
  let magenta = 0, green = 0, total = 0
  for (let offset = 0; offset < bitmap.length; offset += 4 * 7) {
    const b = bitmap[offset], g = bitmap[offset + 1], r = bitmap[offset + 2]
    total++
    if (r > 200 && b > 200 && g < 60) magenta++
    else if (g > 150 && r < 60 && b < 60) green++
  }
  const magentaShare = Math.round((magenta / total) * 1000) / 1000, greenShare = Math.round((green / total) * 1000) / 1000
  return { ok: magentaShare > 0.3 && greenShare > 0.05, ms, width, height, magentaShare, greenShare }
}

async function driveCapture() {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(PROBE_PAGE) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  try {
    await setUp()
    await waitFor(() => clickSidebar('Workshop'), 30_000, 'the Workshop thread')
    const opened = await js(`window.sottoE2E.browserAgent(${JSON.stringify({ threadId: 'workshop', name: 'browser_open', arguments: { url, description: 'Occlusion probe' } })})`, 40_000)
    if (opened.isError) throw new Error(`browser_open failed: ${JSON.stringify(opened)}`)
    const task = JSON.parse(opened.content[0].text).task
    const target = { taskId: task.id, pageId: task.pageId }
    await waitFor(() => js(`Boolean(document.querySelector('[aria-label="Browser for Workshop"]'))`, 5_000), 30_000, 'the browser player')
    await sleep(1_000)
    report.results = []
    for (const placement of ['shown in the browser pane', 'hidden (Hide the browser)']) {
      if (placement.startsWith('hidden')) {
        await restore()
        await js(`document.querySelector('[aria-label="Hide the browser; the agent keeps working"]').click(); true`)
        await waitFor(() => js(`!document.querySelector('[aria-label="Browser for Workshop"]')`, 5_000), 30_000, 'the player to hide')
        await sleep(1_000)
      }
      for (const state of ['visible', 'covered', 'covered-external', 'minimized', 'hidden']) {
        await enter(state)
        await sleep(3_000)
        const window = await describeWindow()
        const capture = await probeCapture(target)
        report.results.push({ placement, state, window, capture })
        note(`${placement} / ${state}: ${capture.ok ? 'PASS' : 'FAIL'} ${capture.ms} ms frames ${window.framesInOneSecond}`)
        await restore()
        await sleep(1_000)
      }
    }
  } finally { server.close() }
}

app.whenReady().then(async () => {
  report.environment = { electron: process.versions.electron, chrome: process.versions.chrome,
    disableFeatures: app.commandLine.getSwitchValue('disable-features'), enableFeatures: app.commandLine.getSwitchValue('enable-features'),
    displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id })),
    logicalCpus: os.cpus().length }
  try {
    if (process.env.OCCLUSION_DRIVE === 'cpu') await driveCpu()
    else await driveCapture()
    report.ok = true
  } catch (error) {
    report.ok = false; report.error = String(error?.stack ?? error)
  } finally {
    if (timer) clearInterval(timer)
    await restore().catch(() => undefined)
    writeFileSync(process.env.OCCLUSION_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    app.exit(0)
  }
})
