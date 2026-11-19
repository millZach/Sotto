// Loaded into Sotto's Electron main process with NODE_OPTIONS=--require; nothing in Sotto's source changes. Adapted from
// ../../electron-baseline/bench-main.cjs. Two modes, from CREF_MODE:
//   prepare: one Claude thread with one finished exchange, through the fake Claude CLI, then quit.
//   drive:   wait; the harness drops main-process JavaScript in CREF_DIR/eval.cjs and reads eval-out.json. The code is
//            the body of an async function given { app, BrowserWindow, win, js, capture, fs, path, sleep, dir }.
if (process.type === 'browser') process.once('loaded', init)

function init() {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const { randomUUID } = require('node:crypto')

  const mode = process.env.CREF_MODE
  const dir = process.env.CREF_DIR
  const root = process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
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
  const win = () => BrowserWindow.getAllWindows().find(w => {
    const url = w.webContents.getURL()
    return !url.includes('widget') && /\/index\.html/u.test(url)
  })
  const js = async code => win().webContents.executeJavaScript(`(async () => { ${code} })()`, true)
  const capture = async (rect, file) => {
    const image = await win().webContents.capturePage(rect)
    fs.writeFileSync(file, image.toPNG())
    return image.getSize()
  }
  const loaded = () => poll(async () => { const w = win(); return w && !w.webContents.isLoading() && await js('return !!window.sotto?.agents') }, 60_000, 'window')
  const session = () => poll(() => {
    const name = fs.readdirSync(path.join(root, 'claude')).find(n => /^alive-.+\.json$/u.test(n))
    return name && name.slice(6, -5)
  }, 60_000, 'claude session')
  const control = async (sessionId, action) => {
    const file = path.join(root, 'claude', `control-${sessionId}.json`)
    fs.writeFileSync(file, JSON.stringify({ id: randomUUID(), ...action }))
    await poll(() => !fs.existsSync(file), 60_000, `control ${action.type}`)
  }
  const threads = () => js(`return (await window.sotto.agents.get()).host.threads.map(x => ({ id: x.id, status: x.status, messages: x.summary?.messageCount ?? null }))`)

  async function prepare() {
    await loaded()
    await js(`await window.sotto.updateSettings({ onboardingComplete: true, appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code' })
      const c = await window.sotto.agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'] } }); if (c.error) throw new Error(c.error)
      const k = await window.sotto.agents.command({ type: 'connect', provider: 'claude' }); if (k.error) throw new Error(k.error)`)
    win().webContents.reload()
    await sleep(500)
    await loaded()
    const project = path.join(root, 'project')
    const id = await js(`const agents = window.sotto.agents
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Shelf', path: ${JSON.stringify(project)}, useExisting: true })
      if (created.error) throw new Error(created.error)
      const projectId = created.host.projects.find(p => p.title === 'Shelf').id
      const model = (await agents.get()).host.models.find(m => m.providerId === 'claude' && m.ready)
      if (!model) throw new Error('no ready claude model')
      const t = await agents.command({ type: 'create-thread', projectId, title: 'Check the crash run', titleSource: 'user', modelId: model.id, workingCopy: 'shared' })
      if (t.error || !t.activeThreadId) throw new Error(t.error ?? 'no thread')
      const s = await agents.command({ type: 'manual-send', threadId: t.activeThreadId, text: 'Run the crash test again and save what it finds to crash-after.json.' })
      if (s.error) throw new Error(s.error)
      return t.activeThreadId`)
    log(`thread ${id}`)
    const sid = await session()
    await control(sid, { type: 'complete', text: 'Done. I ran the crash test five times and saved the results to `crash-after.json`. The worst run lost one entry; the other four lost none.' })
    await poll(async () => (await threads()).some(t => t.messages === 2 && t.status !== 'running'), 60_000, 'reply')
    await sleep(3000)
    write('prepared.json', { threads: await threads() })
    app.quit()
  }

  async function drive() {
    await loaded()
    write('window-ready', String(process.pid))
    log('window ready')
    setInterval(async () => {
      const file = path.join(dir, 'eval.cjs')
      if (!fs.existsSync(file)) return
      const code = fs.readFileSync(file, 'utf8')
      fs.unlinkSync(file)
      try {
        const run = new (Object.getPrototypeOf(async () => {}).constructor)('ctx', code)
        const ok = await run({ app, BrowserWindow, win, js, capture, fs, path, sleep, dir })
        write('eval-out.json', { ok: ok ?? null })
      } catch (error) { write('eval-out.json', { error: String(error?.stack ?? error) }) }
    }, 100)
  }

  app.whenReady().then(() => {
    const run = { prepare, drive }[mode]
    if (!run) return
    run().catch(error => { log(`error ${error.stack}`); write('error', String(error.stack)); setTimeout(() => app.exit(1), 300) })
  })
}
