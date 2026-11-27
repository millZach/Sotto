import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, toggleTools, type LaunchedSotto } from './support/sottoLaunch'
import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

// Sotto's browser does what T3 Code's does (ADR-0220, an Owl feature): an agent reads a page as an accessibility tree
// with refs, acts by ref, selector or point, answers dialogs and file choosers, selects, drags, uploads, waits, evaluates,
// emulates a colour scheme and devices, saves a screenshot, records a video that plays, and opens, lists and closes
// pages. Everything runs in the built app against a page this test serves on loopback.

const SHOTS = evidenceDirectory('artifacts/browser-parity')
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Parity bench</title><style>
body{font:16px system-ui;margin:16px} #box{height:80px;overflow:auto;border:1px solid #888} #box div{height:400px}
#lane{width:200px;height:60px;border:2px dashed #888;margin:8px 0} #card{width:80px;padding:8px;background:#cde}
#tip{display:none} #hoverme:hover + #tip{display:inline} @media (prefers-color-scheme: dark){ #scheme::after{content:'dark'} }
@media (prefers-color-scheme: light){ #scheme::after{content:'light'} } button,select,input{display:block;margin:6px 0;font:inherit}
</style></head><body>
<h1>Parity bench</h1>
<button id="confirm" onclick="document.title = 'confirmed:' + confirm('Ship it?')">Confirm</button>
<button id="alert" onclick="alert('Saved'); document.title = 'alerted'">Alert</button>
<label for="fruit">Fruit</label><select id="fruit"><option value="apple">Apple</option><option value="banana">Banana</option></select>
<div id="card" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','card')">Card</div>
<div id="lane" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.appendChild(document.getElementById(event.dataTransfer.getData('text/plain')))"></div>
<label for="file">Attachment</label><input id="file" type="file" onchange="document.body.dataset.file = this.files.length ? this.files[0].name : ''">
<label for="name">Name</label><input id="name" value="">
<span id="hoverme">Hover me</span><span id="tip">Tip shown</span>
<div id="box"><div>Scroll inside</div></div>
<button id="ctx" oncontextmenu="event.preventDefault(); this.dataset.n = (+this.dataset.n || 0) + 1">Context</button>
<button id="dbl" ondblclick="this.dataset.n = (+this.dataset.n || 0) + 1">Double</button>
<p id="scheme">Scheme: </p>
<script>setTimeout(() => { const late = document.createElement('p'); late.id = 'late'; late.textContent = 'Arrived late'; document.body.appendChild(late) }, 700)
console.log('bench ready')</script>
</body></html>`

async function launch(userData?: string): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'browser-parity=1'
  try { return await launchSotto('success', userData) } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}
type ToolReply = { content: { type: string; text?: string | undefined; data?: string | undefined }[]; isError?: boolean | undefined }
const body = (reply: ToolReply): Record<string, unknown> => JSON.parse(reply.content.find(item => item.type === 'text')!.text!) as Record<string, unknown>
const output = (reply: ToolReply): string => String(body(reply).output ?? body(reply).message ?? '')

test('an agent drives Sotto\'s browser with the full catalog: refs, dialogs, uploads, drags, waits, devices and a recording that plays', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(request.url === '/second' ? '<!doctype html><title>Second tab</title><p>Second</p>' : PAGE) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bench server unavailable')
  const launched = await launch().catch(error => { server.close(); throw error })
  const { page, app } = launched
  // Playwright attaches to every page Sotto opens and dismisses dialogs nobody listens for; a listener leaves them to Sotto.
  const leaveDialogs = (window: Page): void => { window.on('dialog', () => undefined) }
  app.windows().forEach(leaveDialogs)
  app.on('window', leaveDialogs)
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resizeContentWindow(launched, 1280, 800, [800, 540]); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = async (name: string, args: unknown): Promise<ToolReply> => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args }) as Promise<ToolReply>

    // A server on loopback by its port; the call returns once the page has loaded.
    const opened = await agent('browser_open', { port: address.port, path: '/', description: 'Check the parity bench' })
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
    expect(output(opened)).toMatch(/^Loaded http:\/\/localhost:\d+\/ in \d+ ms\.$/u)
    const task = body(opened).task as { id: string; pageId: string }
    const act = (action: unknown): Promise<ToolReply> => agent('browser_action', { taskId: task.id, pageId: task.pageId, action })
    const evaluate = async (expression: string): Promise<unknown> => JSON.parse(output(await act({ type: 'evaluate', expression }))) as unknown
    // The floating player draws the page small; a size of its own keeps every element inside the visible area.
    expect((await act({ type: 'viewport', width: 1024, height: 900 })).isError).not.toBe(true)

    // A snapshot names elements with refs, and an action by ref reaches the one it named.
    const snapshot = output(await act({ type: 'snapshot' }))
    expect(snapshot).toContain('Title: Parity bench')
    expect(snapshot).toContain('[log] bench ready')
    const confirmRef = /- button "Confirm" \[ref=(e\d+)\]/u.exec(snapshot)?.[1]
    expect(confirmRef, snapshot).toBeTruthy()

    // A confirm the page opens holds the click until it is answered; the dialog action answers it.
    expect(output(await act({ type: 'click', ref: confirmRef }))).toContain('The page opened a confirm dialog: "Ship it?"')
    const listedDialog = await page.evaluate(async () => { const listed = await window.sotto!.browser!.list({ threadId: 'workshop' }); return listed.ok ? listed.value.pages[0]?.dialog : null })
    expect(listedDialog).toEqual({ type: 'confirm', message: 'Ship it?' })
    expect((await act({ type: 'snapshot' })).isError).toBe(true)
    expect(output(await act({ type: 'dialog', accept: true }))).toBe('Accepted the confirm dialog.')
    await expect.poll(() => evaluate('document.title')).toBe('confirmed:true')
    await act({ type: 'click', selector: '#alert' })
    expect(output(await act({ type: 'dialog', accept: false }))).toBe('Dismissed the alert dialog.')
    await expect.poll(() => evaluate('document.title')).toBe('alerted')

    // A native select by label; a drag the page reads as an HTML drag and drop.
    expect(output(await act({ type: 'select', selector: '#fruit', values: ['Banana'] }))).toContain('Selected ["Banana"]')
    expect(await evaluate('document.querySelector("#fruit").value')).toBe('banana')
    expect(output(await act({ type: 'drag', from: { selector: '#card' }, to: { selector: '#lane' } }))).toContain('Dragged')
    expect(await evaluate('document.querySelector("#lane").contains(document.querySelector("#card"))')).toBe(true)

    // Files from the thread's folder: by selector, and through the file chooser a click opens. Upload always asks.
    const folder = await page.evaluate(async () => { const listed = await window.sotto!.browser!.list({ threadId: 'workshop' }); if (!listed.ok) throw new Error(listed.error.message); return listed.value.workspace.workingDirectory })
    await writeFile(join(folder, 'parity-upload.txt'), 'upload me')
    const answerUpload = async (action: unknown): Promise<ToolReply> => {
      await page.evaluate(request => { (window as unknown as { pendingUpload?: Promise<unknown> }).pendingUpload = window.sottoE2E!.browserAgent!(request) }, { threadId: 'workshop', name: 'browser_action', arguments: { taskId: task.id, pageId: task.pageId, action } })
      const pendingAction = () => page.evaluate(async taskId => { const tasks = await window.sotto!.browser!.tasks({ threadId: 'workshop' }); return tasks.ok ? tasks.value.find(entry => entry.id === taskId)?.pendingAction ?? null : null }, task.id)
      await expect.poll(pendingAction).not.toBeNull()
      const pending = await pendingAction()
      expect(pending!.description).toContain('parity-upload.txt')
      const listing = await page.evaluate(async () => { const listed = await window.sotto!.browser!.list({ threadId: 'workshop' }); return listed.ok ? listed.value.workspace.workspaceId : '' })
      await page.evaluate(async request => window.sotto!.browser!.answerAction(request), { threadId: 'workshop', workspaceId: listing, pageId: task.pageId, taskId: task.id, actionId: pending!.id, allow: true })
      return page.evaluate(async () => await (window as unknown as { pendingUpload: Promise<unknown> }).pendingUpload) as Promise<ToolReply>
    }
    expect(output(await answerUpload({ type: 'upload', selector: '#file', paths: ['parity-upload.txt'] }))).toBe('Gave the input 1 file.')
    expect(await evaluate('document.body.dataset.file')).toBe('parity-upload.txt')
    await evaluate('document.querySelector("#file").value = ""; document.body.dataset.file = ""')
    expect(output(await act({ type: 'click', selector: '#file' }))).toContain('The page opened a file chooser.')
    expect(output(await answerUpload({ type: 'upload', paths: [join(folder, 'parity-upload.txt')] }))).toBe('Gave the input 1 file.')
    expect(await evaluate('document.body.dataset.file')).toBe('parity-upload.txt')
    // A file outside the thread's folder is refused before anyone is asked.
    const outside = await act({ type: 'upload', selector: '#file', paths: [join(launched.userData, '..', 'elsewhere.txt')] })
    expect(outside.isError).toBe(true)

    // Waiting, evaluating, hovering, keys with modifiers, scrolling one container, and other buttons and counts.
    expect(output(await act({ type: 'wait_for', selector: '#late', timeoutMs: 5000 }))).toMatch(/^Seen after \d+ ms\.$/u)
    expect(JSON.parse(output(await act({ type: 'evaluate', expression: 'new Promise(done => setTimeout(() => done(6 * 7), 50))', awaitPromise: true })))).toBe(42)
    await act({ type: 'hover', selector: '#hoverme' })
    expect(await evaluate('getComputedStyle(document.querySelector("#tip")).display')).toBe('inline')
    await act({ type: 'type', selector: '#name', text: 'Rez' })
    expect(await evaluate('document.querySelector("#name").value')).toBe('Rez')
    await act({ type: 'key', key: 'a', modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await act({ type: 'key', key: 'Delete' })
    expect(await evaluate('document.querySelector("#name").value')).toBe('')
    await act({ type: 'type', selector: '#name', text: 'Zach', clear: true })
    expect(await evaluate('document.querySelector("#name").value')).toBe('Zach')
    expect(output(await act({ type: 'scroll', selector: '#box', deltaX: 0, deltaY: 200 }))).toBe('scroll completed. Scrolled its container by 0, 200.')
    await expect.poll(() => evaluate('document.querySelector("#box").scrollTop')).toBeGreaterThan(0)
    await act({ type: 'click', selector: '#ctx', button: 'right' })
    expect(await evaluate('document.querySelector("#ctx").dataset.n')).toBe('1')
    await act({ type: 'click', selector: '#dbl', clickCount: 2 })
    expect(await evaluate('document.querySelector("#dbl").dataset.n')).toBe('1')

    // The page's colour scheme, and device presets in both orientations.
    await act({ type: 'appearance', colorScheme: 'light' })
    expect(await evaluate('getComputedStyle(document.querySelector("#scheme"), "::after").content')).toBe('"light"')
    await act({ type: 'appearance', colorScheme: 'dark' })
    expect(await evaluate('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(true)
    await act({ type: 'viewport', preset: 'iphone-12-pro', orientation: 'landscape' })
    expect(await evaluate('[innerWidth, innerHeight]')).toEqual([844, 390])
    await act({ type: 'viewport', preset: 'ipad-mini' })
    expect(await evaluate('[innerWidth, innerHeight]')).toEqual([768, 1024])
    const listedViewport = await page.evaluate(async () => { const listed = await window.sotto!.browser!.list({ threadId: 'workshop' }); return listed.ok ? listed.value.pages[0]?.viewport : null })
    expect(listedViewport).toEqual({ width: 768, height: 1024, preset: 'ipad-mini', orientation: 'portrait' })
    await act({ type: 'viewport', width: 1024, height: 900 })

    // A screenshot kept as a file, and a recording that plays.
    const saved = JSON.parse(output(await act({ type: 'screenshot', save: true }))) as { path: string }
    expect((await readFile(saved.path)).subarray(1, 4).toString()).toBe('PNG')
    expect(output(await act({ type: 'record_start' }))).toContain('Recording.')
    for (const deltaY of [120, -120, 120]) { await act({ type: 'scroll', deltaX: 0, deltaY }); await page.waitForTimeout(400) }
    await act({ type: 'hover', selector: '#hoverme' }); await page.waitForTimeout(1200)
    const recorded = JSON.parse(output(await act({ type: 'record_stop' }))) as { path: string }
    expect(recorded.path).toMatch(/recording-.*\.webm$/u)
    expect((await stat(recorded.path)).size).toBeGreaterThan(1000)
    const played = await app.evaluate(async ({ BrowserWindow }, path) => {
      const { readFileSync } = process.mainModule!.require('node:fs') as typeof import('node:fs')
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await window.loadURL('data:text/html,<video muted></video>')
        return await window.webContents.executeJavaScript(`new Promise(done => { const video = document.querySelector('video'); const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(path).toString('base64'))}), c => c.charCodeAt(0)); video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })); video.onloadeddata = () => { video.play().then(() => setTimeout(() => done({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime }), 600), () => done({ error: 'play' })) }; video.onerror = () => done({ error: 'decode' }) })`) as { width?: number; height?: number; time?: number; error?: string }
      } finally { window.destroy() }
    }, recorded.path)
    expect(played.error).toBeUndefined()
    expect(played.width).toBeGreaterThan(0)
    expect(played.time).toBeGreaterThan(0)

    // Tabs: a second page in the background, listed, then closed by the agent that opened it.
    const second = await agent('browser_open', { port: address.port, path: '/second', background: true, description: 'Open a second tab' })
    const secondTask = body(second).task as { pageId: string }
    const pages = await agent('browser_pages', {})
    expect((body(pages).pages as unknown[]).length).toBe(2)
    const backgrounded = await page.evaluate(async pageId => { const listed = await window.sotto!.browser!.list({ threadId: 'workshop' }); return listed.ok ? listed.value.pages.find(entry => entry.id === pageId)?.background : null }, secondTask.pageId)
    expect(backgrounded).toBe(true)
    expect(body(await agent('browser_close', { pageId: secondTask.pageId }))).toEqual({ closed: secondTask.pageId })
    expect((body(await agent('browser_pages', {})).pages as unknown[]).length).toBe(1)
    // Servers started from Sotto: this test's own server was not, so it is not listed or asked.
    const servers = body(await agent('browser_servers', {})).servers as { port: number }[]
    expect(servers.some(entry => entry.port === address.port)).toBe(false)

    // Navigation waits for its readiness, and says when it ran out of time.
    expect(output(await act({ type: 'navigate', url: `http://localhost:${address.port}/second`, waitUntil: 'domContentLoaded', timeoutMs: 10_000 }))).toMatch(/^Loaded /u)
    expect(existsSync(saved.path)).toBe(true)
  } finally {
    server.close()
    await closeSotto(launched)
  }
})

/** The window at a content size; a maximized or minimized window ignores a new size, so it is restored first. */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      if (window.isFullScreen()) window.setFullScreen(false)
      if (window.isMaximized()) window.unmaximize()
      if (window.isMinimized()) window.restore()
    })
    try { await resizeContentWindow(launched, width, height, [800, 540]); return } catch (error) { if (attempt >= 3) throw error }
  }
}
async function appearance(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}
/** The window's own pixels, the native page included, as the pane shows it. */
async function shot(launched: LaunchedSotto, name: string): Promise<void> {
  await launched.page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.timeline instanceof DocumentTimeline && animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
  await captureSotto(launched, join(SHOTS, `${name}.png`), { mode: 'native-window', title: `Sotto browser parity ${name}`, retries: 9, retryDelayMs: 500 })
}
/** Nothing in the pane's row or strips runs past the panel, and the window does not scroll sideways. */
async function fits(page: Page, panel: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const box = (await panel.boundingBox())!
  for (const part of await panel.locator('.browser-pane__row, .browser-pane__strip').all()) {
    const rect = (await part.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(box.x - 1); expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1)
  }
}

test('the pane answers a page\'s dialog, shows a recording with Stop, takes devices and colours from More, and hands the page back', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(PAGE) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bench server unavailable')
  const launched = await launch().catch(error => { server.close(); throw error })
  const { page, app } = launched
  const leaveDialogs = (window: Page): void => { window.on('dialog', () => undefined) }
  app.windows().forEach(leaveDialogs)
  app.on('window', leaveDialogs)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const report: Record<string, unknown> = {}
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await size(launched, 1280, 800); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = async (name: string, args: unknown): Promise<ToolReply> => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args }) as Promise<ToolReply>
    await toggleTools(page)
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Browser' }).click()

    // No page: the servers Sotto started. The test's own server was not started from Sotto, so none is listed.
    await expect(panel.getByRole('heading', { name: 'Servers started from Sotto' })).toBeVisible()
    await expect(panel.getByText('No web server started from Sotto is answering.', { exact: false })).toBeVisible()
    for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(launched, `empty-servers-1280x800-${mode}`) }
    await appearance(page, 'dark')

    const opened = await agent('browser_open', { port: address.port, path: '/', description: 'Check the parity bench in the pane' })
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
    const task = body(opened).task as { id: string; pageId: string }
    const act = (action: unknown): Promise<ToolReply> => agent('browser_action', { taskId: task.id, pageId: task.pageId, action })
    const evaluate = async (expression: string): Promise<unknown> => JSON.parse(output(await act({ type: 'evaluate', expression }))) as unknown
    await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(`http://localhost:${address.port}/`)

    // A confirm the page opens shows as a card at the page's foot, where the user answers it.
    expect(output(await act({ type: 'click', selector: '#confirm' }))).toContain('The page opened a confirm dialog')
    const dialog = panel.locator('.browser-parity__dialog')
    await expect(dialog).toContainText('The page asks')
    await expect(dialog).toContainText('Ship it?')
    await expect(dialog.getByRole('button', { name: 'OK' })).toBeFocused()
    // The card sits under the page, which stays drawn: main shows one native view while it waits.
    await expect.poll(() => app.evaluate(({ BrowserWindow, WebContentsView }) => { const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; return host.contentView.children.filter(view => view instanceof WebContentsView).length })).toBe(1)
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await size(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await appearance(page, mode)
        await fits(page, panel)
        await shot(launched, `dialog-${width}x${height}-${mode}`)
      }
    }
    await size(launched, 1280, 800); await appearance(page, 'dark')
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    report.dialogDotAnimation = await dialog.locator('.browser-pane__dot').evaluate(element => getComputedStyle(element).animationName)
    expect(report.dialogDotAnimation).toBe('none')
    await shot(launched, 'dialog-reduced-motion-1280x800-dark')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await evaluate('document.title')).toBe('confirmed:true')

    // A recording shows as a line with its time and Stop; Stop keeps the video, which the agent's record_stop names.
    expect(output(await act({ type: 'record_start' }))).toContain('Recording.')
    const recording = panel.locator('.browser-parity__recording')
    await expect(recording).toContainText('Recording this page')
    report.recordingDotAnimation = await recording.locator('.browser-pane__dot').evaluate(element => getComputedStyle(element).animationName)
    expect(report.recordingDotAnimation).toBe('none')
    await shot(launched, 'recording-reduced-motion-1280x800-dark')
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await act({ type: 'scroll', deltaX: 0, deltaY: 200 }); await page.waitForTimeout(1200)
    for (const [width, height, mode] of [[1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark'], [1600, 1000, 'light']] as const) {
      await size(launched, width, height); await appearance(page, mode)
      await fits(page, panel)
      await shot(launched, `recording-${width}x${height}-${mode}`)
    }
    await size(launched, 1280, 800); await appearance(page, 'dark')
    await recording.getByRole('button', { name: 'Stop' }).click()
    await expect(recording).toHaveCount(0)
    const kept = JSON.parse(output(await act({ type: 'record_stop' }))) as { path: string }
    expect(kept.path).toMatch(/recording-.*\.webm$/u)
    report.recordingBytes = (await stat(kept.path)).size

    // More: devices with Rotate, and the page's colours.
    const more = panel.getByRole('button', { name: 'More browser actions' })
    await more.click()
    await expect(page.getByRole('menuitemradio', { name: 'Show as iPhone 12 Pro' })).toBeVisible()
    await shot(launched, 'more-menu-1280x800-dark')
    await page.getByRole('menuitemradio', { name: 'Show as iPhone 12 Pro' }).click()
    await expect.poll(() => evaluate('[innerWidth, innerHeight]')).toEqual([390, 844])
    await more.click()
    await expect(page.getByRole('menuitemradio', { name: 'Show as iPhone 12 Pro' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('menuitemradio', { name: 'Show at 390 x 844' })).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('menuitem', { name: 'Rotate to landscape' }).click()
    await expect.poll(() => evaluate('[innerWidth, innerHeight]')).toEqual([844, 390])
    await more.click()
    await page.getByRole('menuitemradio', { name: 'Page in light colours' }).click()
    await expect.poll(() => evaluate('getComputedStyle(document.querySelector("#scheme"), "::after").content')).toBe('"light"')
    await more.click()
    await expect(page.getByRole('menuitemradio', { name: 'Page in light colours' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await shot(launched, 'device-landscape-1280x800-dark')
    const listed = await page.evaluate(async () => { const result = await window.sotto!.browser!.list({ threadId: 'workshop' }); return result.ok ? result.value.pages[0] : null })
    expect(listed?.viewport).toEqual({ width: 844, height: 390, preset: 'iphone-12-pro', orientation: 'landscape' })
    expect(listed?.appearance).toBe('light')

    // Take over pauses the agent and says the page is the user's; Hand back gives it back.
    const strip = panel.locator('.browser-pane__strip')
    await strip.getByRole('button', { name: 'Take over' }).click()
    await expect(strip).toContainText('You have the page. The agent waits until you hand it back')
    for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(launched, `taken-over-1280x800-${mode}`) }
    await appearance(page, 'dark')
    const refused = await act({ type: 'click', selector: '#ctx' })
    expect(refused.isError).toBe(true)
    expect(output(refused)).toContain('paused')
    await strip.getByRole('button', { name: 'Hand back' }).click()
    await expect(strip.getByRole('button', { name: 'Take over' })).toBeVisible()
    expect((await act({ type: 'click', selector: '#ctx', button: 'right' })).isError).not.toBe(true)
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'verification.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`)
  } finally {
    server.close()
    await closeSotto(launched)
  }
})

/** A Firefox profile folder, as Firefox leaves it, holding one sign-in cookie for the bench on localhost. */
async function firefoxFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-firefox-'))
  const folder = join(root, 'Profiles', 'bench.default-release')
  await mkdir(folder, { recursive: true })
  await writeFile(join(root, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/bench.default-release\nDefault=1\n')
  const database = new DatabaseSync(join(folder, 'cookies.sqlite'))
  database.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT \'\', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)')
  database.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('sid', 'from-firefox', 'localhost', '/', Math.floor(Date.now() / 1000) + 86_400, 0, 0, 1)
  database.close()
  return root
}
/** The cookie the page at this port sees, read in main as a test reads it; the agent is never asked. */
const cookieAt = (launched: LaunchedSotto, port: number, ordinal = 0): Promise<string | null> => launched.app.evaluate(async ({ webContents }, request) => {
  const pages = webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(`http://localhost:${request.port}/`))
  const contents = pages[request.ordinal]
  return contents ? String(await contents.executeJavaScript('document.cookie')) : null
}, { port, ordinal })

test('a browser profile the user adds keeps its sign-ins across a restart, opens private, and never reaches an agent\'s own page', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const importRoot = await firefoxFixture()
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Signed-in bench</title><p id="who">Bench</p><script>document.getElementById("who").textContent = document.cookie || "signed out"</script>') })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bench server unavailable')
  const previous = process.env.SOTTO_E2E_IMPORT_ROOT
  process.env.SOTTO_E2E_IMPORT_ROOT = importRoot
  let launched: LaunchedSotto | null = null
  const report: Record<string, unknown> = {}
  try {
    launched = await launch()
    const errors: string[] = []
    const ready = async (current: LaunchedSotto): Promise<Locator> => {
      const { page } = current
      page.on('pageerror', error => errors.push(error.message))
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
        await window.sotto!.agents!.command({ type: 'connect' })
      })
      await page.reload(); await size(current, 1280, 800); await openThreads(page)
      await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
      await toggleTools(page)
      const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
      await panel.getByRole('tab', { name: 'Browser' }).click()
      return panel
    }
    const first = launched
    const { page } = first
    const agent = async (name: string, args: unknown): Promise<ToolReply> => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args }) as Promise<ToolReply>
    let panel = await ready(first)

    // No profile yet: new pages are fresh. Add one, copying the Firefox profile's sign-ins once.
    const choice = panel.getByRole('radiogroup', { name: 'Open new pages in' })
    await expect(choice.getByRole('radio', { name: /A fresh page/u })).toBeChecked()
    await expect(panel.getByText('No web server started from Sotto is answering.', { exact: false })).toBeVisible()
    await panel.getByRole('button', { name: 'Add a profile that keeps sign-ins' }).click()
    await expect(panel.getByRole('textbox', { name: 'Profile name' })).toBeFocused()
    await panel.getByRole('textbox', { name: 'Profile name' }).fill('Work')
    await panel.getByRole('combobox', { name: 'Copy sign-ins from' }).selectOption({ label: 'Firefox · default-release' })
    for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(first, `profiles-add-1280x800-${mode}`) }
    await appearance(page, 'dark')
    await panel.getByRole('button', { name: 'Add profile' }).click()
    await expect(panel.getByText('Added Work and copied its sign-ins (1 cookie)', { exact: false })).toBeVisible()
    await expect(choice.getByRole('radio', { name: /Work/u })).toBeChecked()
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await size(first, width, height)
      for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(first, `profiles-${width}x${height}-${mode}`) }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' }); await shot(first, 'profiles-1280x800-dark-reduced-motion'); await page.emulateMedia({ reducedMotion: null })
    await size(first, 1280, 800); await appearance(page, 'dark')

    // The page opens in Work, says so beside the address, and starts private even though the grant is on.
    const addressField = panel.getByRole('textbox', { name: 'Address for a new page' })
    await addressField.fill(`localhost:${address.port}`); await addressField.press('Enter')
    await expect(panel.getByTitle(/Open in the profile Work/u)).toBeVisible()
    await expect(panel.getByText('This page is private. The agent cannot see it')).toBeVisible()
    await expect.poll(() => cookieAt(first, address.port)).toBe('sid=from-firefox')
    const hidden = body(await agent('browser_pages', {})).pages as { pageId: string; shared: boolean; url?: string }[]
    expect(hidden).toHaveLength(1)
    expect(hidden[0]).toEqual({ pageId: hidden[0]!.pageId, shared: false })
    for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(first, `profile-page-private-1280x800-${mode}`) }
    await appearance(page, 'dark')

    // Developer tools are the user's, from More, in a window of their own.
    await panel.getByRole('button', { name: 'More browser actions' }).click()
    await page.getByRole('menuitem', { name: 'Open developer tools' }).click()
    // Under Playwright's own debugging connection Electron reports isDevToolsOpened() false, so the test looks for the window.
    const devtools = (close: boolean) => first.app.evaluate(({ webContents }, request) => {
      if (request.close) webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://localhost:${request.port}/`))!.closeDevTools()
      return webContents.getAllWebContents().filter(item => !item.isDestroyed() && item.getURL().startsWith('devtools://')).length
    }, { port: address.port, close })
    await expect.poll(() => devtools(false)).toBe(1)
    await expect.poll(() => devtools(true)).toBe(0)
    report.devtoolsOpened = true

    // An agent's own page at the same address is in the thread's session, which has no sign-in.
    const opened = await agent('browser_open', { port: address.port, path: '/', description: 'Open the bench fresh' })
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
    const own = body(opened).task as { id: string; pageId: string }
    expect(output(await agent('browser_action', { taskId: own.id, pageId: own.pageId, action: { type: 'evaluate', expression: 'document.cookie' } }))).toBe('""')
    report.agentPageCookie = ''

    // The user shares the profile's page; only then does the agent see it.
    await panel.getByRole('tab', { name: /Signed-in bench/u }).first().click()
    await panel.getByRole('button', { name: 'Share with agent' }).click()
    const shared = (body(await agent('browser_pages', {})).pages as { pageId: string; shared: boolean }[]).filter(item => item.shared)
    expect(shared).toHaveLength(2)

    // A restart keeps the profile and its sign-in.
    await first.app.close()
    launched = await launch(first.userData)
    const second = launched
    panel = await ready(second)
    const again = panel.getByRole('radiogroup', { name: 'Open new pages in' })
    await again.getByRole('radio', { name: /Work/u }).check()
    const nextAddress = panel.getByRole('textbox', { name: 'Address for a new page' })
    await nextAddress.fill(`localhost:${address.port}`); await nextAddress.press('Enter')
    await expect(panel.getByTitle(/Open in the profile Work/u)).toBeVisible()
    await expect.poll(() => cookieAt(second, address.port)).toBe('sid=from-firefox')
    report.cookieAfterRestart = 'sid=from-firefox'

    // Remove asks first, closes the profile's page and deletes its sign-ins.
    await panel.getByRole('button', { name: 'More browser actions' }).click()
    await second.page.getByRole('menuitem', { name: 'New page' }).click()
    await panel.getByRole('button', { name: 'Remove Work' }).click()
    await expect(panel.getByRole('button', { name: 'Keep', exact: true })).toBeFocused()
    await expect(panel.getByText('No web server started from Sotto is answering.', { exact: false })).toBeVisible()
    for (const mode of ['dark', 'light'] as const) { await appearance(second.page, mode); await shot(second, `profiles-remove-1280x800-${mode}`) }
    await appearance(second.page, 'dark')
    await panel.getByRole('button', { name: 'Delete sign-ins' }).click()
    await expect(panel.getByText('Removed Work and deleted its sign-ins.')).toBeVisible()
    await expect(panel.getByRole('radio', { name: /Work/u })).toHaveCount(0)
    await expect.poll(() => cookieAt(second, address.port)).toBeNull()
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'profiles-verification.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`)
  } finally {
    if (previous === undefined) delete process.env.SOTTO_E2E_IMPORT_ROOT; else process.env.SOTTO_E2E_IMPORT_ROOT = previous
    server.close()
    if (launched) await closeSotto({ ...launched, ownsUserData: true })
    await rm(importRoot, { recursive: true, force: true })
  }
})
