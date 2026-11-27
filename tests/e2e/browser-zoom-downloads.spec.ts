import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, toggleTools, type LaunchedSotto } from './support/sottoLaunch'
import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

// ADR-0222, in the built app against a page this test serves on loopback: the page zooms with Ctrl and = - 0 and from
// More while an agent's clicks by point and by ref still land at 50%, 100% and 175%; a download is placed by the user,
// whether the page or an agent's action started it; the agent's cursor is drawn by Chromium's overlay, never in the
// agent's own screenshots; the user draws on a frozen picture of the page and sends it with a comment; and a passkey
// is made and used in Sotto's page with no bridge.

const SHOTS = evidenceDirectory('artifacts/browser-zoom-downloads')
const PAGE = `<!doctype html><html><head><title>Zoom bench</title><style>
body{margin:0;font:16px system-ui;background:#fff;color:#111} .grid{display:grid;grid-template-columns:repeat(4,200px);gap:20px;padding:20px}
button{height:60px;font:inherit} a{display:block;margin:0 20px}
</style></head><body>
<div class="grid">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<button id="b${n}" onclick="hit(${n})">Target ${n}</button>`).join('')}</div>
<a id="file" href="/file.txt">Get the notes</a>
<script>function hit(n) { document.body.dataset.hit = String(n); document.body.dataset.count = String((+document.body.dataset.count || 0) + 1) }</script>
</body></html>`

async function launch(): Promise<LaunchedSotto> {
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'browser-parity=1'
  try { return await launchSotto('success') } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
}
type ToolReply = { content: { type: string; text?: string | undefined; data?: string | undefined }[]; isError?: boolean | undefined }
const body = (reply: ToolReply): Record<string, unknown> => JSON.parse(reply.content.find(item => item.type === 'text')!.text!) as Record<string, unknown>
const output = (reply: ToolReply): string => String(body(reply).output ?? body(reply).message ?? '')

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
async function shot(launched: LaunchedSotto, name: string): Promise<void> {
  await launched.page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.timeline instanceof DocumentTimeline && animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
  await captureSotto(launched, join(SHOTS, `${name}.png`), { mode: 'native-window', title: `Sotto zoom and downloads ${name}`, retries: 9, retryDelayMs: 500 })
}
/** Nothing in the pane's row or strips runs past the panel, and the window does not scroll sideways. */
async function fits(page: Page, panel: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const box = (await panel.boundingBox())!
  for (const part of await panel.locator('.browser-pane__row, .browser-pane__strip').all()) {
    if (!await part.isVisible()) continue
    const rect = (await part.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(box.x - 1); expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1)
  }
  // The row's controls, the zoom chip among them, stay clear of the window's own buttons at every size.
  const controls = page.locator('.threads-view__winctl')
  if (await controls.isVisible()) {
    const edge = (await controls.boundingBox())!.x
    const more = (await panel.getByRole('button', { name: 'More browser actions' }).boundingBox())!
    expect(more.x + more.width).toBeLessThanOrEqual(edge + 1)
  }
}
/** Every size and colour mode, and reduced motion, for one state of the pane. */
async function captures(launched: LaunchedSotto, panel: Locator, name: string): Promise<void> {
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await size(launched, width, height)
    for (const mode of ['dark', 'light'] as const) { await appearance(launched.page, mode); await fits(launched.page, panel); await shot(launched, `${name}-${width}x${height}-${mode}`) }
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await launched.page.emulateMedia({ reducedMotion: 'reduce' })
    await appearance(launched.page, 'dark')
    await shot(launched, `${name}-${width}x${height}-dark-reduced-motion`)
    await launched.page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await launched.page.emulateMedia({ reducedMotion: null })
  }
  await size(launched, 1280, 800); await appearance(launched.page, 'dark')
}

test('zoom keeps the agent exact, downloads are placed by the user, the cursor stays out of screenshots, drawings reach the draft, and passkeys work', async () => {
  test.setTimeout(600_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((request, response) => {
    if (request.url === '/file.txt') { response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="bench-notes.txt"' }); response.end('bench notes'); return }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(PAGE)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Bench server unavailable')
  const launched = await launch().catch(error => { server.close(); throw error })
  const { page, app } = launched
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
    await toggleTools(page)
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Browser' }).click()
    const agent = async (name: string, args: unknown): Promise<ToolReply> => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args }) as Promise<ToolReply>
    const opened = await agent('browser_open', { port: address.port, path: '/', description: 'Check the zoom bench' })
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true)
    const task = body(opened).task as { id: string; pageId: string }
    const act = (action: unknown): Promise<ToolReply> => agent('browser_action', { taskId: task.id, pageId: task.pageId, action })
    const evaluate = async (expression: string): Promise<unknown> => JSON.parse(output(await act({ type: 'evaluate', expression }))) as unknown
    const listed = async () => page.evaluate(async () => { const result = await window.sotto!.browser!.list({ threadId: 'workshop' }); if (!result.ok) throw new Error(result.error.message); return result.value })
    const { workspace } = await listed()
    const request = { threadId: 'workshop', workspaceId: workspace.workspaceId, pageId: task.pageId }
    const zoomed = async () => (await listed()).pages.find(item => item.id === task.pageId)?.zoom
    const zoom = (step: 'in' | 'out' | 'reset') => page.evaluate(async payload => { const result = await window.sotto!.browser!.zoom!(payload); if (!result.ok) throw new Error(result.error.message) }, { ...request, zoom: step })
    expect((await act({ type: 'viewport', width: 1000, height: 600 })).isError).not.toBe(true)

    // At 50%, 100% and 175% the agent's viewport stays 1000 by 600 CSS pixels, and a click by ref and by point lands.
    const landings: Record<string, unknown> = {}
    for (const [target, steps] of [[0.5, ['out', 'out', 'out', 'out', 'out']], [1, []], [1.75, ['in', 'in', 'in', 'in']]] as const) {
      await zoom('reset')
      for (const step of steps) await zoom(step)
      await expect.poll(zoomed).toBe(target)
      await expect.poll(() => evaluate('[innerWidth, innerHeight]')).toEqual([1000, 600])
      const snapshot = output(await act({ type: 'snapshot' }))
      const ref = /- button "Target 6" \[ref=(e\d+)\]/u.exec(snapshot)?.[1]
      expect(ref, snapshot).toBeTruthy()
      expect((await act({ type: 'click', ref })).isError).not.toBe(true)
      expect(await evaluate('document.body.dataset.hit')).toBe('6')
      const box = await evaluate('(() => { const r = document.querySelector("#b3").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()') as { x: number; y: number }
      expect((await act({ type: 'click', x: Math.round(box.x), y: Math.round(box.y) })).isError).not.toBe(true)
      expect(await evaluate('document.body.dataset.hit')).toBe('3')
      const shotSize = JSON.parse(output(await act({ type: 'screenshot' }))) as { width: number; height: number }
      expect(shotSize).toMatchObject({ width: 1000, height: 600 })
      landings[String(target)] = { ref: 'Target 6', point: [Math.round(box.x), Math.round(box.y)], screenshot: shotSize }
    }
    report.zoomLandings = landings

    // Ctrl with = and 0 from the page itself zooms as Chrome's keys do.
    await zoom('reset')
    const press = (keyCode: string) => app.evaluate(({ webContents }, payload) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://localhost:${payload.port}/`))!
      contents.sendInputEvent({ type: 'keyDown', keyCode: payload.keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode: payload.keyCode, modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] })
    }, { port: address.port, keyCode })
    await press('='); await expect.poll(zoomed).toBe(1.1)
    await press('='); await expect.poll(zoomed).toBe(1.25)
    await expect(panel.getByRole('button', { name: 'Zoom 125%. Back to 100%' })).toBeVisible()
    await press('0'); await expect.poll(zoomed).toBe(1)
    await expect(panel.getByRole('button', { name: /^Zoom \d+%/u })).toHaveCount(0)
    // From More, with the keys named.
    await panel.getByRole('button', { name: 'More browser actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Zoom in' })).toBeVisible()
    await shot(launched, 'zoom-menu-1280x800-dark')
    await page.getByRole('menuitem', { name: 'Zoom in' }).click()
    await expect.poll(zoomed).toBe(1.1)
    report.zoomKeys = 'Ctrl+= twice gave 125%, Ctrl+0 gave 100%, More > Zoom in gave 110%'

    // The agent's cursor: Chromium's overlay draws it where the agent acts; the agent's own screenshot never shows it.
    await zoom('reset')
    // The page as Chromium draws it, overlay included. A clipped capture is drawn again for the clip, without it.
    const pixelAt = (point: { x: number; y: number }) => app.evaluate(async ({ webContents, nativeImage }, payload) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://localhost:${payload.port}/`))!
      const shot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }) as { data: string }
      const picture = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
      const at = (payload.y * picture.getSize().width + payload.x) * 4, bitmap = picture.toBitmap()
      return { b: bitmap[at]!, g: bitmap[at + 1]!, r: bitmap[at + 2]! }
    }, { port: address.port, ...point })
    const empty = { x: 950, y: 400 }
    const inside = { x: empty.x + 2, y: empty.y + 8 }
    const before = await pixelAt(inside)
    expect(before).toEqual({ r: 255, g: 255, b: 255 })
    await act({ type: 'hover', x: empty.x, y: empty.y })
    const drawn = await pixelAt(inside)
    report.cursorPixel = drawn
    expect(drawn).not.toEqual({ r: 255, g: 255, b: 255 })
    // As the user sees it, over the page in the pane: taken straight after a hover, inside the moment the cursor stays.
    await act({ type: 'hover', x: 360, y: 64 })
    await shot(launched, 'agent-cursor-1280x800-dark')
    await act({ type: 'hover', x: empty.x, y: empty.y })
    const agentShot = await act({ type: 'screenshot' })
    const image = agentShot.content.find(item => item.type === 'image')?.data
    expect(image).toBeTruthy()
    const inAgentShot = await app.evaluate(({ nativeImage }, payload) => {
      const picture = nativeImage.createFromBuffer(Buffer.from(payload.image, 'base64'))
      const { width } = picture.getSize()
      const bitmap = picture.toBitmap()
      const at = (payload.y * width + payload.x) * 4
      return { b: bitmap[at]!, g: bitmap[at + 1]!, r: bitmap[at + 2]! }
    }, { image: image!, ...inside })
    expect(inAgentShot).toEqual({ r: 255, g: 255, b: 255 })
    report.cursorInAgentScreenshot = false
    // A recording takes the page as Chromium draws it, the cursor included: only the cursor is coloured in the blank
    // band it crosses, from 55% to 95% across and 65% to 73% down.
    expect(output(await act({ type: 'record_start' }))).toContain('Recording.')
    for (const x of [600, 700, 800, 900]) { await act({ type: 'hover', x, y: 400 }); await page.waitForTimeout(250) }
    const recorded = JSON.parse(output(await act({ type: 'record_stop' }))) as { path: string }
    report.recordingShowsCursor = await app.evaluate(async ({ BrowserWindow }, path) => {
      const { readFileSync } = process.mainModule!.require('node:fs') as typeof import('node:fs')
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await window.loadURL('data:text/html,<video muted></video><canvas></canvas>')
        return await window.webContents.executeJavaScript(`new Promise(done => { const video = document.querySelector('video'); const canvas = document.querySelector('canvas'); const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(path).toString('base64'))}), c => c.charCodeAt(0)); video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
          let coloured = 0; const look = () => { canvas.width = video.videoWidth; canvas.height = video.videoHeight; const context = canvas.getContext('2d'); context.drawImage(video, 0, 0); const top = Math.floor(canvas.height * 0.65), left = Math.floor(canvas.width * 0.55); const data = context.getImageData(left, top, Math.floor(canvas.width * 0.4), Math.floor(canvas.height * 0.08)).data; for (let i = 0; i < data.length; i += 4) { const r = data[i], g = data[i + 1], b = data[i + 2]; if (Math.max(r, g, b) - Math.min(r, g, b) > 60) coloured++ } };
          video.ontimeupdate = look; video.onended = () => done(coloured > 20); video.onerror = () => done(null); video.play().catch(() => done(null)); setTimeout(() => done(coloured > 20), 8000) })`) as boolean | null
      } finally { window.destroy() }
    }, recorded.path)
    expect(report.recordingShowsCursor).toBe(true)

    // A download the page starts asks where it goes; nothing is in Downloads until the user answers.
    await page.waitForTimeout(3500)
    const downloads = join(launched.userData, 'e2e-downloads')
    await app.evaluate(({ webContents }, port) => { void webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://localhost:${port}/`))!.executeJavaScript('document.getElementById("file").click()', true) }, address.port)
    const strip = panel.locator('.browser-parity__download')
    await expect(strip).toContainText(`localhost:${address.port} wants to download a file. Where should it go?`)
    await expect(strip).toContainText('bench-notes.txt')
    expect(existsSync(join(downloads, 'bench-notes.txt'))).toBe(false)
    await zoom('in'); await zoom('in')
    await captures(launched, panel, 'download-asking')
    await strip.getByRole('button', { name: 'Save to Downloads' }).click()
    await expect(strip).toContainText('Saved bench-notes.txt')
    await expect(strip).toContainText('in e2e-downloads')
    expect(await readFile(join(downloads, 'bench-notes.txt'), 'utf8')).toBe('bench notes')
    await captures(launched, panel, 'download-saved')
    await strip.getByRole('button', { name: 'Show in folder' }).click()
    await strip.getByRole('button', { name: 'Open' }).click()
    const files = await page.evaluate(async () => { const taken = await window.sottoE2E!.snapshot(); return { opened: taken.openedFiles ?? [], shown: taken.shownFiles ?? [] } })
    expect(files.shown).toContain(join(downloads, 'bench-notes.txt'))
    expect(files.opened).toContain(join(downloads, 'bench-notes.txt'))
    await strip.getByRole('button', { name: 'Hide bench-notes.txt' }).click()
    await zoom('reset')

    // A download an agent's click starts says so; Save as puts it in the thread's folder, so the agent may read it there.
    const into = join(workspace.workingDirectory, 'downloads')
    await app.evaluate((_electron, folder) => { process.env.SOTTO_E2E_SAVE_AS_DIR = folder }, into)
    const clicked = await act({ type: 'click', selector: '#file' })
    expect(output(clicked)).toContain('The page started downloading "bench-notes.txt". Sotto asks the user where to save it')
    await expect(strip).toContainText(`The agent's action started a download from localhost:${address.port}. Where should it go?`)
    await shot(launched, 'download-by-agent-1280x800-dark')
    await strip.getByRole('button', { name: 'Save as…' }).click()
    await expect(strip).toContainText('Saved bench-notes.txt')
    expect(await readFile(join(into, 'bench-notes.txt'), 'utf8')).toBe('bench notes')
    const told = body(await agent('browser_pages', {})).downloads as { file: string; state: string; byAgent: boolean; path?: string }[]
    expect(told).toContainEqual({ file: 'bench-notes.txt', state: 'saved', byAgent: true, path: 'downloads/bench-notes.txt' })
    expect(told).toContainEqual({ file: 'bench-notes.txt', state: 'saved', byAgent: false })
    expect(JSON.stringify(told)).not.toContain(downloads.replace(/\\/gu, '\\\\'))
    report.agentToldOfDownloads = told
    // The link that downloaded never left the page, so the page shows its own address again and is not loading.
    await expect.poll(async () => (await listed()).pages.find(item => item.id === task.pageId)).toMatchObject({ url: `http://localhost:${address.port}/`, status: 'ready' })

    // The empty pane lists this session's downloads.
    await panel.getByRole('button', { name: 'More browser actions' }).click()
    await page.getByRole('menuitem', { name: 'New page' }).click()
    await expect(panel.getByRole('heading', { name: 'Downloads this session' })).toBeVisible()
    await captures(launched, panel, 'downloads-list')
    // With one page there are no tabs: Escape in the new page's address goes back to it.
    await panel.getByRole('textbox', { name: 'Address for a new page' }).press('Escape')
    await expect(panel.getByRole('heading', { name: 'Downloads this session' })).toHaveCount(0)

    // Draw on the page: a frozen picture in the page's place, a comment the focus starts in, and Add to message.
    await panel.getByRole('button', { name: 'Draw on the page' }).click()
    const comment = panel.getByRole('textbox', { name: 'Comment' })
    await expect(comment).toBeFocused()
    await expect(panel.getByText('Dictation types here while this field has the focus.')).toBeVisible()
    // The page's native view is hidden while its picture stands in for it.
    await expect.poll(() => app.evaluate(({ BrowserWindow, WebContentsView }) => { const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; return host.contentView.children.filter(view => view instanceof WebContentsView && view.getVisible()).length })).toBe(0)
    await comment.fill('Target 3 should be the first button.')
    await panel.getByRole('button', { name: 'Box' }).click()
    const picture = panel.getByRole('application', { name: /Picture to mark up/u })
    const area = (await picture.boundingBox())!
    await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.1)
    await page.mouse.down()
    await page.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.25, { steps: 6 })
    await page.mouse.up()
    await captures(launched, panel, 'draw-on-page')
    await panel.getByRole('button', { name: 'Add to message' }).click()
    await expect(panel.locator('.tools-panel__status')).toHaveText(/^Added to the draft for /u)
    const readDraft = () => page.evaluate(async () => { const state = await window.sotto!.agents!.get(); const id = state.hostId === undefined ? 'workshop' : `host:${state.hostId}:workshop`; return state.threadDrafts?.find(item => item.threadId === id) })
    await expect.poll(async () => (await readDraft())?.attachments.length).toBe(1)
    const draft = await readDraft()
    expect(draft?.attachments[0]).toMatchObject({ name: 'Drawing on Zoom bench', browserFeedback: { label: 'Drawing on Zoom bench', comment: 'Target 3 should be the first button.' } })
    expect(draft?.attachments[0]?.browserFeedback?.context).toContain('The user drew on this screenshot to show what they mean.')
    expect(draft?.text ?? '').toBe('')
    report.drawing = { attachment: draft?.attachments[0]?.name, comment: draft?.attachments[0]?.browserFeedback?.comment }
    await expect(panel.getByRole('button', { name: 'Draw on the page' })).toBeFocused()

    // Passkeys: Chromium's own WebAuthn in Sotto's page, with no bridge, makes and uses a credential.
    report.passkeys = await app.evaluate(async ({ webContents }, port) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith(`http://localhost:${port}/`))!
      const platform = await contents.executeJavaScript('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()') as boolean
      await contents.debugger.sendCommand('WebAuthn.enable', { enableUI: false })
      const { authenticatorId } = await contents.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }) as { authenticatorId: string }
      try {
        const made = await contents.executeJavaScript(`navigator.credentials.create({ publicKey: { rp: { name: 'Bench', id: 'localhost' }, user: { id: new Uint8Array([1, 2, 3, 4]), name: 'rez', displayName: 'Rez' }, challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' } } }).then(credential => { window.benchCredential = credential.rawId; return { id: credential.id, type: credential.type } }, error => ({ error: error.name }))`, true) as { id?: string; type?: string; error?: string }
        const used = made.id ? await contents.executeJavaScript(`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: window.benchCredential }], userVerification: 'preferred' } }).then(credential => ({ id: credential.id }), error => ({ error: error.name }))`, true) as { id?: string; error?: string } : null
        return { platformAuthenticator: platform, made, used }
      } finally {
        await contents.debugger.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined)
        await contents.debugger.sendCommand('WebAuthn.disable').catch(() => undefined)
      }
    }, address.port)
    const passkeys = report.passkeys as { made: { id?: string; type?: string }; used: { id?: string } | null }
    expect(passkeys.made.type).toBe('public-key')
    expect(passkeys.used?.id).toBe(passkeys.made.id)

    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'verification.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`)
  } finally {
    server.close()
    await closeSotto(launched)
  }
})
