// Loaded into Sotto's Electron main process with NODE_OPTIONS=--require (nothing in Sotto's source changes). It registers
// bench-preload.cjs on every session and drives one benchmark mode from BENCH_MODE, talking to the window only through
// window.sotto (the same bridge Sotto's own Playwright journeys use) and to the harness through files in BENCH_DIR.
//   prepare: seed the thread with history.json's 200 messages through the fake Claude CLI, then quit.
//   stream:  send a prompt, focus the composer, arm the recorders, stream reply.md, wait for the harness's memory
//            sample, collect the renderer's records, write them, exit.
//   launch:  write the epoch of the first rAF after the thread is on screen, then exit (or stay, for hmr).
// 'electron' resolves only once Electron has loaded its own initialisation, which is after the main script's first
// synchronous pass and before the app is ready, so the hook starts on 'loaded'.
if (process.type === 'browser') process.once('loaded', init)

function init() {
  const { app, ipcMain, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const { randomUUID } = require('node:crypto')

  const mode = process.env.BENCH_MODE
  const dir = process.env.BENCH_DIR
  const root = process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
  const history = JSON.parse(fs.readFileSync(process.env.BENCH_HISTORY, 'utf8'))
  const snippet = process.env.BENCH_SNIPPET
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 1))
  const log = line => fs.appendFileSync(path.join(dir, 'hook.log'), `${new Date().toISOString()} ${line}\n`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function poll(fn, timeoutMs, label) {
    const until = Date.now() + timeoutMs
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > until) throw new Error(`timed out: ${label}`)
      await sleep(50)
    }
  }

  const registered = new WeakSet()
  const register = session => {
    if (registered.has(session)) return
    registered.add(session)
    session.registerPreloadScript({ type: 'frame', id: 'sotto-bench', filePath: path.join(__dirname, 'bench-preload.cjs') })
  }
  app.on('session-created', register)
  ipcMain.on('bench:config', event => { event.returnValue = { mode, snippet: ['launch', 'hmr'].includes(mode) ? snippet : null } })
  ipcMain.on('bench:launch', (_event, data) => {
    const epoch = ms => data.origin + ms
    write('launch.json', { ...data, foundEpochMs: epoch(data.foundAt), rafEpochMs: epoch(data.rafTs), rafCallbackEpochMs: epoch(data.rafNow), paintEpochMs: epoch(data.paint) })
    log('launch frame recorded')
    if (mode === 'launch') setTimeout(() => app.exit(0), 300)
  })

  const mainWindow = () => BrowserWindow.getAllWindows().find(w => {
    const url = w.webContents.getURL()
    return !url.includes('widget') && (/\/index\.html/u.test(url) || /^https?:\/\/localhost/u.test(url))
  })
  const js = async code => mainWindow().webContents.executeJavaScript(`(async () => { ${code} })()`, true)
  const loaded = () => poll(async () => { const w = mainWindow(); return w && !w.webContents.isLoading() && await js('return !!window.sotto?.agents') }, 60_000, 'window')
  const session = () => poll(() => {
    const name = fs.readdirSync(path.join(root, 'claude')).find(n => /^alive-.+\.json$/u.test(n))
    return name && name.slice(6, -5)
  }, 60_000, 'claude session')
  const control = async (sessionId, action) => {
    const file = path.join(root, 'claude', `control-${sessionId}.json`)
    fs.writeFileSync(file, JSON.stringify({ id: randomUUID(), ...action }))
    await poll(() => !fs.existsSync(file), 60_000, `control ${action.type}`)
  }
  const thread = () => js(`const t = (await window.sotto.agents.get()).host.threads; return t.map(x => ({ id: x.id, status: x.status, messages: x.summary?.messageCount ?? null }))`)
  const gpu = () => ({ versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }, gpu: app.getGPUFeatureStatus(),
    ozone: app.commandLine.getSwitchValue('ozone-platform') || null, mainWindowRendererPid: mainWindow()?.webContents.getOSProcessId() ?? null, metrics: app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name ?? null, serviceName: m.serviceName ?? null })) })

  async function prepare() {
    await loaded()
    log('window loaded')
    await js(`await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const c = await window.sotto.agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } }); if (c.error) throw new Error(c.error)
      const k = await window.sotto.agents.command({ type: 'connect', provider: 'claude' }); if (k.error) throw new Error(k.error)`)
    mainWindow().webContents.reload()
    await sleep(500)
    await loaded()
    const project = path.join(root, 'project')
    const id = await js(`const agents = window.sotto.agents
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Shelf', path: ${JSON.stringify(project)}, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(p => p.title === 'Shelf').id
      const model = (await agents.get()).host.models.find(m => m.providerId === 'claude' && m.ready)
      if (!model) throw new Error('no ready claude model')
      const t = await agents.command({ type: 'create-thread', projectId, title: 'Fix the shelf', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (t.error || !t.activeThreadId) throw new Error(t.error ?? 'no thread')
      const s = await agents.command({ type: 'manual-send', threadId: t.activeThreadId, text: ${JSON.stringify(history[0].text)} })
      if (s.error) throw new Error(s.error)
      return t.activeThreadId`)
    log(`thread ${id}`)
    const sid = await session()
    const frames = history.slice(1, -1).map(m => m.role === 'user'
      ? { type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: m.text } }
      : { type: 'assistant', uuid: randomUUID(), session_id: sid, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: m.text }] } })
    await control(sid, { type: 'raw-burst', persist: true, frames })
    await control(sid, { type: 'complete', text: history.at(-1).text })
    await poll(async () => (await thread()).some(t => t.messages === history.length && t.status !== 'running'), 60_000, '200 messages')
    log(`seeded ${JSON.stringify(await thread())}`)
    await sleep(3000)
    write('prepared.json', { thread: await thread(), ...gpu() })
    app.quit()
  }

  async function stream() {
    await loaded()
    await poll(() => js(`return !!document.querySelector('.thread-pane')?.textContent.includes(${JSON.stringify(snippet)})`), 60_000, 'thread on screen')
    write('window-ready', String(process.pid))
    await poll(() => fs.existsSync(path.join(dir, 'sized')), 60_000, 'harness sized the window')
    await sleep(1000)
    const [t] = await thread()
    const prompt = await js(`const s = await window.sotto.agents.command({ type: 'manual-send', threadId: ${JSON.stringify(t.id)}, text: 'Write up what you found and what you changed.' }); return s.error ?? null`)
    if (prompt) throw new Error(prompt)
    await poll(async () => (await thread())[0].messages === history.length + 1, 30_000, 'prompt echoed')
    await sleep(1500)
    mainWindow().focus()
    const focused = await js(`const ed = document.querySelector('.thread-pane [contenteditable="true"]'); ed?.focus(); return document.activeElement === ed && !!ed`)
    if (!focused) throw new Error('composer not focused')
    const armed = new Promise(resolve => ipcMain.once('bench:armed', (_e, data) => resolve(data)))
    mainWindow().webContents.send('bench:arm')
    write('armed.json', await armed)
    await sleep(1000)
    const sid = await session()
    fs.writeFileSync(path.join(root, 'claude', `stream-${sid}.json`), JSON.stringify({ reply: process.env.BENCH_REPLY, outDir: dir, chunk: 20, intervalMs: 16 }))
    log('stream requested')
    await poll(() => fs.existsSync(path.join(dir, 'stream-times.json')), 90_000, 'stream end')
    write('stream-ended', String(JSON.parse(fs.readFileSync(path.join(dir, 'stream-times.json'), 'utf8')).endEpochMs))
    log('stream ended')
    await poll(() => fs.existsSync(path.join(dir, 'memory-done')), 60_000, 'memory sample')
    const data = new Promise(resolve => ipcMain.once('bench:data', (_e, d) => resolve(d)))
    mainWindow().webContents.send('bench:collect')
    write('renderer.json', await data)
    write('main.json', { thread: await thread(), ...gpu() })
    write('done', '1')
    log('done')
    setTimeout(() => app.exit(0), 300)
  }

  app.whenReady().then(() => {
    for (const w of [require('electron').session.defaultSession]) register(w)
    const run = { prepare, stream }[mode]
    if (!run) return
    run().catch(error => { log(`error ${error.stack}`); write('error', String(error.stack)); setTimeout(() => app.exit(1), 300) })
  })
  if (mode === 'hmr' || mode === 'explore') {
    // Dev mode and exploration: report the composer's box once the thread is on screen, for the harness's pixel poll.
    app.whenReady().then(async () => {
      await loaded()
      await poll(() => js(`return !!document.querySelector('.thread-pane')?.textContent.includes(${JSON.stringify(snippet)})`), 120_000, 'thread on screen')
      write('window-ready', String(process.pid))
    }).catch(error => write('error', String(error.stack)))
  }
  if (mode === 'hmr' || mode === 'explore') {
    // Not used during measured stream or launch runs: the harness drops JavaScript in eval.js and reads eval-out.json.
    setInterval(async () => {
      const file = path.join(dir, 'eval.js')
      if (!fs.existsSync(file)) return
      const code = fs.readFileSync(file, 'utf8')
      fs.unlinkSync(file)
      try { write('eval-out.json', { ok: await js(code) }) } catch (error) { write('eval-out.json', { error: String(error) }) }
    }, 100)
  }
}
