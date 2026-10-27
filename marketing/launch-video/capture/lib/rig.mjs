// Launching Sotto on the stage, driving it with real input, recording the screen, and scripting the fake clients.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { compile, fake, paths, stageEnvironment, VIDEO } from './stage.mjs'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
/** The screen is 2560x1600 at 150%; Sotto runs at scale factor 2, so its 1280x800 window fills it. */
export const SCALE = Number(process.env.SOTTO_VIDEO_SCALE ?? 2)
export const WINDOW = { width: 1280, height: 800 }
/** Where the cursor jumps to mark a take's sync point: the window's dark bottom-left corner. */
export const SYNC_POINT = { x: 12, y: 1588 }

let inputExe
/** Real mouse and keyboard input through capture/shim/Input.cs, rebuilt first if the source has changed. */
export function input(...args) { execFileSync(inputExe ??= compile('Input'), args.map(String), { stdio: 'ignore' }) }

export async function until(check, { timeout = 30_000, every = 100, what = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`)
    await sleep(every)
  }
}

/** Starts Sotto on the stage's profile in its normal (not e2e) mode. */
export async function launch({ extraArgs = [], env = {}, topmost = true } = {}) {
  const environment = stageEnvironment({ SOTTO_VIDEO_DESK: '1', SOTTO_VIDEO_PROFILE: paths.profile, SOTTO_VIDEO_PROJECT: paths.project, ...env })
  const app = await electron.launch({ args: [join(VIDEO, 'capture', 'deskMain.cjs'), `--force-device-scale-factor=${SCALE}`, ...extraArgs], env: environment, timeout: 60_000 })
  const main = await until(() => app.windows().find(page => page.url().endsWith('/index.html')), { what: 'the main window' })
  await main.waitForLoadState('domcontentloaded')
  await main.waitForFunction(() => Boolean(window.sotto?.agents))
  await main.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  const widget = () => app.windows().find(page => page.url().endsWith('/widget.html'))
  const rig = new Rig(app, main, widget)
  await rig.place()
  if (topmost) await rig.keepInFront()
  return rig
}

export class Rig {
  constructor(app, main, widget) { this.app = app; this.main = main; this.widget = widget; this.events = []; this.recorder = null }

  /** The main window at 1280x800 in the screen's top-left, in front. */
  async place(bounds = { x: 0, y: 0, ...WINDOW }) {
    await this.app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))
      window.setMinimumSize(800, 540)
      window.setBounds(bounds)
      window.show(); window.moveTop(); window.focus()
    }, bounds)
    await sleep(300)
  }

  /**
   * The window fills the screen, which normally puts it over the taskbar, until focus moves and the taskbar
   * comes forward over the bottom of the window. For the length of a take the window stays in front of it,
   * and the floating widget stays in front of the window.
   */
  async keepInFront() {
    await this.app.evaluate(({ BrowserWindow }) => {
      const hold = () => {
        const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
        const main = windows.find(w => w.webContents.getURL().endsWith('/index.html'))
        const widget = windows.find(w => w.webContents.getURL().endsWith('/widget.html'))
        if (!main || main.isMinimized()) return
        // Reordering only: neither call activates a window, so focus stays where the take put it.
        main.setAlwaysOnTop(true, 'screen-saver')
        if (widget?.isVisible()) widget.setAlwaysOnTop(true, 'screen-saver')
      }
      hold()
      globalThis.__videoFront = setInterval(hold, 250)
    })
  }

  async state() { return this.main.evaluate(async () => window.sotto.agents.get()) }
  async command(command) { return this.main.evaluate(async c => window.sotto.agents.command(c), command) }
  async settings(patch) { return this.main.evaluate(async p => window.sotto.updateSettings(p), patch) }
  thread(title) { return this.state().then(state => state.host.threads.find(thread => thread.title === title)) }

  /** A locator's centre in physical screen pixels. */
  async point(locator, { dx = 0.5, dy = 0.5 } = {}) {
    const box = await locator.boundingBox()
    if (!box) throw new Error('No box for locator')
    const content = await this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).getContentBounds())
    return { x: Math.round((content.x + box.x + box.width * dx) * SCALE), y: Math.round((content.y + box.y + box.height * dy) * SCALE) }
  }
  async moveTo(locator, ms = 500, offset) { const { x, y } = await this.point(locator, offset); input('move', x, y, ms); return { x, y } }
  async click(locator, { ms = 500, settle = 120, offset, shift = false } = {}) {
    await locator.waitFor({ state: 'visible' })
    await this.moveTo(locator, ms, offset); await sleep(settle)
    this.mark('click'); input('click', ...(shift ? ['shift'] : []))
  }
  async press(chord, { cap = true } = {}) { this.mark(cap ? 'keys' : 'keys-quiet', { chord }); input('keys', chord) }
  async type(text, delay = 35) { this.mark('type', { text }); input('type', text, delay) }

  mark(name, data = {}) { this.events.push({ at: now(), name, ...data }) }

  async record(name, { fps = 60, sync = SYNC_POINT } = {}) {
    mkdirSync(paths.takes, { recursive: true })
    const file = join(paths.takes, `${name}.mp4`)
    this.recordingName = name
    this.syncPoint = sync
    this.events = []
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-init_hw_device', 'd3d11va=dd', '-init_hw_device', 'qsv=qs@dd', '-filter_hw_device', 'dd',
      '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=1:dup_frames=1`, '-vf', 'hwmap=derive_device=qsv,format=qsv',
      '-c:v', 'h264_qsv', '-global_quality', '14', '-look_ahead', '0', '-g', String(fps), '-y', file], { stdio: ['pipe', 'ignore', 'inherit'] })
    this.recorder = { ffmpeg, file, closed: new Promise(resolve => ffmpeg.on('close', resolve)) }
    await sleep(1500)
    // The sync mark: the cursor jumps into a dark corner (the taskbar's when Sotto is in front), and the first frame showing it is this moment.
    input('move', sync.x, sync.y, 0); this.mark('sync'); await sleep(400)
    input('move', 1280, 900, 0); await sleep(200)
    return file
  }

  async stop() {
    if (!this.recorder) return
    await sleep(800)
    this.recorder.ffmpeg.stdin.write('q')
    await this.recorder.closed
    const log = { file: this.recorder.file, sync: this.syncPoint, scale: SCALE, events: this.events }
    writeFileSync(this.recorder.file.replace(/\.mp4$/u, '.events.json'), JSON.stringify(log, null, 2))
    this.recorder = null
  }

  /** Closes the app, and ends its process tree if it hasn't exited in 15 s (the terminal or browser can hold main open). */
  async close() {
    await this.stop()
    const pid = this.app.process().pid
    const closed = await Promise.race([this.app.close().then(() => true, () => true), sleep(15_000).then(() => false)])
    if (!closed && pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
}

// --- The fake clients -------------------------------------------------------------------------------------------

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
/** A thread's provider session key (threads.json), then that provider's own alias for it (<provider>-threads.json). */
function alias(provider, threadId) {
  const local = threadId.split(':').at(-1)
  const key = readJson(join(paths.profile, 'threads.json'), { bindings: [] }).bindings.find(b => b.threadId === local && b.provider === provider)?.sessionId
  return key ? { key, ...readJson(join(paths.profile, `${provider}-threads.json`), {})[key] } : undefined
}

export const claude = {
  session: threadId => { const a = alias('claude', threadId); return a && (a.sessionId ?? a.key) },
  async act(threadId, action) {
    const session = await until(() => claude.session(threadId), { what: 'the Claude session' })
    const file = join(fake.claude, `control-${session}.json`)
    await until(() => !existsSync(file), { what: 'the previous Claude action' })
    writeFileSync(file, JSON.stringify({ id: randomUUID(), ...action }))
    await until(() => !existsSync(file), { what: 'Claude to take the action' })
  },
  frame: (threadId, frame, persist = false) => claude.act(threadId, { type: 'raw', frame: { session_id: claude.session(threadId), ...frame }, persist }),
  /** Streams one assistant text message word by word, as Claude Code does, and records it in the session. */
  async say(threadId, text, { wordMs = 45 } = {}) {
    const id = randomUUID(), session = claude.session(threadId)
    await claude.frame(threadId, { type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant' } } })
    await claude.frame(threadId, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    const words = text.split(/(?<=\s)/u)
    for (let i = 0; i < words.length; i += 2) {
      await claude.frame(threadId, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words.slice(i, i + 2).join('') } } })
      await sleep(wordMs)
    }
    await claude.frame(threadId, { type: 'assistant', uuid: randomUUID(), message: { id, role: 'assistant', content: [{ type: 'text', text }] } }, true)
    return session
  },
  /** One tool call and its result, both in the session's history. */
  async tool(threadId, name, toolInput, result, { runMs = 400 } = {}) {
    const toolId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    await claude.frame(threadId, { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input: toolInput }] } }, true)
    await sleep(runMs)
    await claude.frame(threadId, { type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] } }, true)
    return toolId
  },
  async end(threadId, text = '') { await claude.frame(threadId, { type: 'result', subtype: 'success', is_error: false, result: text }) },
  /** The MCP endpoint Sotto gave this session for its browser, from the fake's record of its launch. */
  browserServer(threadId) {
    const session = claude.session(threadId)
    const launches = readFileSync(join(fake.claude, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => ['launch', 'resume'].includes(entry.method) && entry.params.frame.args.includes(session))
    const args = launches.at(-1)?.params.frame.args ?? []
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
    const [name, server] = Object.entries(config.mcpServers)[0]
    return { name, ...server }
  },
}

export const codex = {
  native: threadId => alias('codex', threadId)?.codexThreadId,
  async act(threadId, action) {
    const id = randomUUID(), threadIdNative = await until(() => codex.native(threadId), { what: 'the Codex thread' })
    writeFileSync(join(fake.codex, 'control.json'), JSON.stringify({ id, threadId: threadIdNative, ...action }))
    await until(() => (existsSync(join(fake.codex, 'actions.jsonl')) && readFileSync(join(fake.codex, 'actions.jsonl'), 'utf8').includes(id)), { what: 'Codex to take the action' })
  },
  turn(threadId) {
    const state = readJson(join(fake.codex, 'state.json'), { threads: {} })
    return state.threads[codex.native(threadId)]?.turns.at(-1)
  },
  notify: (threadId, method, params, persist = false) => codex.act(threadId, { type: 'notify', method, params: { turnId: codex.turn(threadId)?.id, ...params }, persist }),
  /** A command Codex runs, from start to its output. */
  async command(threadId, command, output, { runMs = 900, exitCode = 0 } = {}) {
    const item = { type: 'commandExecution', id: randomUUID(), command, cwd: '', status: 'inProgress', commandActions: [], aggregatedOutput: '' }
    await codex.notify(threadId, 'item/started', { item }, true)
    await sleep(runMs)
    await codex.notify(threadId, 'item/completed', { item: { ...item, status: exitCode ? 'failed' : 'completed', aggregatedOutput: output, exitCode, durationMs: runMs } }, true)
  },
  async edit(threadId, path, diff) {
    const item = { type: 'fileChange', id: randomUUID(), status: 'inProgress', changes: [{ path, kind: { type: 'update', move_path: null }, diff }] }
    await codex.notify(threadId, 'item/started', { item }, true)
    await sleep(300)
    await codex.notify(threadId, 'item/completed', { item: { ...item, status: 'completed' } }, true)
  },
  /** A commentary message streamed in, as Codex writes between its tool calls. */
  async say(threadId, text, { wordMs = 40 } = {}) {
    const item = { type: 'agentMessage', id: randomUUID(), text: '' }
    await codex.notify(threadId, 'item/started', { item })
    const words = text.split(/(?<=\s)/u)
    for (let i = 0; i < words.length; i += 2) { await codex.notify(threadId, 'item/agentMessage/delta', { itemId: item.id, delta: words.slice(i, i + 2).join('') }); await sleep(wordMs) }
    await codex.notify(threadId, 'item/completed', { item: { ...item, text } }, true)
  },
  complete: (threadId, text) => codex.act(threadId, { type: 'complete', text }),
}

export const grok = {
  native: threadId => alias('grok', threadId)?.grokSessionId,
  async act(threadId, action) {
    const sessionId = await until(() => grok.native(threadId), { what: 'the Grok session' })
    writeFileSync(join(fake.grok, 'control.json'), JSON.stringify({ id: randomUUID(), sessionId, ...action }))
    await sleep(120)
  },
  async say(threadId, text, { wordMs = 40 } = {}) {
    const words = text.split(/(?<=\s)/u)
    for (let i = 0; i < words.length; i += 2) { await grok.act(threadId, { type: 'chunk', text: words.slice(i, i + 2).join('') }); await sleep(wordMs) }
  },
  tool: (threadId, update) => grok.act(threadId, { type: 'activity', update }),
  complete: (threadId, text) => grok.act(threadId, { type: 'complete', text }),
}

export const devin = {
  native: threadId => { const a = alias('devin', threadId); return a && (a.devinSessionId ?? a.sessionId) },
  async act(threadId, action) {
    const session = await until(() => devin.native(threadId), { what: 'the Devin session' })
    writeFileSync(join(fake.devin, `control-${session}.json`), JSON.stringify({ id: randomUUID(), ...action }))
    await sleep(200)
  },
  complete: (threadId, text) => devin.act(threadId, { type: 'complete', text }),
}

/** What each client's side call writes next: a thread title, a branch name or a commit message (ADR-0026). */
export function sideAnswer(provider, text) {
  writeFileSync(join(fake[provider], 'oneshot.json'), JSON.stringify({ text }))
}
