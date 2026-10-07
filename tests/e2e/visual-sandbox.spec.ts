import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import type { AgentMessage } from '../../src/shared/agents'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

// An interactive visual runs in a sealed page (ADR-0057, #794), in the running app. The page an agent sends draws, runs
// its script and follows Sotto's step and theme messages; an ordinary fetch, an ordinary image and an ordinary link aimed
// at a listener on this computer reach nothing. These are ordinary loads, not a catalogue of ways out: the ADR says what
// this does not prove.
const SHOTS = resolve('artifacts/interactive-visual')
const START = Date.now() - 60_000
const at = (second: number): string => new Date(START + second * 1000).toISOString()
const HISTORY: AgentMessage[] = [
  { id: 'page-prompt', role: 'user', text: 'Show me how the queue fills up.', createdAt: at(0) },
  { id: 'page-before', role: 'assistant', text: 'Here is the queue as a page you can try.', createdAt: at(5) },
]

/** The agent's page: a small chart drawn by its own script, which also records what it was sent and what it tried. */
function page(port: number): string {
  const listener = `http://127.0.0.1:${port}`
  return `<!doctype html>
<html lang="en"><head><title>Queue</title>
<style>
  body { margin: 0; padding: 20px 24px; height: 260px; box-sizing: border-box; font: 15px/1.5 var(--sotto-font); }
  h1 { margin: 0 0 8px; font-size: 17px; }
  .bars { display: flex; gap: 8px; align-items: flex-end; height: 120px; }
  .bar { width: 36px; background: var(--sotto-accent); border-radius: 4px 4px 0 0; }
  a { color: var(--sotto-accent); margin-right: 16px; }
</style></head>
<body>
  <h1>Queue depth</h1>
  <div class="bars" id="bars"></div>
  <p id="state">Waiting for Sotto.</p>
  <a id="away" href="${listener}/next">Next page</a><a id="popup" href="${listener}/new" target="_blank">New window</a>
  <img id="remote" alt="" width="1" height="1" src="${listener}/chart.png">
  <script>
    const record = document.body.dataset
    record.script = 'ran'
    record.sotto = typeof window.sotto
    record.steps = '[]'
    record.blocked = '[]'
    for (const depth of [3, 5, 8, 4, 2]) {
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.height = depth * 14 + 'px'
      document.getElementById('bars').append(bar)
    }
    document.addEventListener('securitypolicyviolation', event => {
      record.blocked = JSON.stringify([...JSON.parse(record.blocked), event.violatedDirective])
    })
    addEventListener('message', event => {
      const message = event.data
      if (message && message.type === 'sotto-visual-step') {
        record.steps = JSON.stringify([...JSON.parse(record.steps), { step: message.step, total: message.total }])
        document.getElementById('state').textContent = 'Step ' + message.step + ' of ' + message.total
      }
      if (message && message.type === 'sotto-visual-theme') { record.theme = message.mode + ' ' + message.tokens['--sotto-background']; record.reduced = String(message.reducedMotion) }
    })
    fetch('${listener}/data.json').then(() => { record.fetch = 'answered' }, () => { record.fetch = 'failed' })
  </script>
</body></html>`
}
const TALL = '<!doctype html><body style="margin:0"><div style="height:2000px">A tall page.</div><script>document.body.dataset.script = "ran"</script></body>'
// A page whose body fills the frame, with 300 pixels of content: Sotto measures the content, not the frame.
const FULL = '<!doctype html><style>html, body { height: 100%; margin: 0 }</style><div style="height:300px">A full-height page.</div>'

type ToolReply = { content: { type: string; text?: string }[]; isError?: boolean }
const visualize = (target: Page, args: unknown): Promise<ToolReply> => target.evaluate(request => window.sottoE2E!.visualTool!(request), { threadId: 'workshop', arguments: args }) as Promise<ToolReply>

/** A TCP listener on loopback that counts every connection it is offered. */
async function listen(): Promise<{ server: Server; port: number; connections: () => number }> {
  let count = 0
  const server = createServer(socket => { count++; socket.destroy() })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return { server, port: (server.address() as AddressInfo).port, connections: () => count }
}

interface Observed { guests: number; navigations: string[]; popups: number; downloads: number; failed: { url: string; error: string }[]; completed: string[] }

/** Records, in main, what the visual session and its guests do, alongside Sotto's own listeners. */
async function observe(launched: LaunchedSotto): Promise<void> {
  await launched.app.evaluate(({ app, session }) => {
    const record: Observed = { guests: 0, navigations: [], popups: 0, downloads: 0, failed: [], completed: [] }
    Object.assign(globalThis, { visualObserved: record })
    const visual = session.fromPartition('sotto-visual')
    // Sotto's seal uses onBeforeRequest; these are separate events, so recording them changes nothing it does.
    visual.webRequest.onErrorOccurred(details => { record.failed.push({ url: details.url, error: details.error }) })
    visual.webRequest.onCompleted(details => { record.completed.push(details.url) })
    visual.on('will-download', () => { record.downloads++ })
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      record.guests++
      // What a page committed to, in any frame. A navigation Sotto refuses starts and is stopped before any request.
      contents.on('did-frame-navigate', (_navigation, url) => { record.navigations.push(url) })
      contents.on('did-create-window', () => { record.popups++ })
    })
  })
}
const observed = (launched: LaunchedSotto): Promise<Observed> => launched.app.evaluate(() => (globalThis as unknown as { visualObserved: Observed }).visualObserved)

/** The page's own record of itself, read in main from the guest that shows it. */
async function guestRecord(launched: LaunchedSotto, index = 0): Promise<Record<string, string>> {
  return launched.app.evaluate(async ({ webContents }, which) => {
    const guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed()).sort((a, b) => a.id - b.id)
    const guest = guests[which]
    if (!guest) return {}
    return guest.executeJavaScript('({ ...document.body.dataset, url: location.href, background: getComputedStyle(document.documentElement).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, still: String(document.getElementById("sotto-visual-theme").textContent.includes("animation-duration:0s")) })') as Promise<Record<string, string>>
  }, index)
}
const inGuest = (launched: LaunchedSotto, script: string): Promise<unknown> => launched.app.evaluate(async ({ webContents }, code) => {
  const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && !contents.isDestroyed())
  return guest?.executeJavaScript(code)
}, script)

async function openWorkshop(launched: LaunchedSotto): Promise<Locator> {
  const { page: view } = launched
  await view.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await view.reload()
  await resizeWindow(launched, 1280, 800)
  await openThreads(view)
  await view.getByRole('button', { name: 'Workshop', exact: true }).first().click()
  const log = view.getByRole('log', { name: 'Thread transcript' })
  await expect(log).toBeVisible()
  return log
}

async function scrollTo(locator: Locator, offset = 80): Promise<void> {
  await locator.evaluate((element, gap) => {
    const transcript = element.closest('.thread-workspace__transcript')!
    transcript.scrollTop += element.getBoundingClientRect().top - transcript.getBoundingClientRect().top - gap
  }, offset)
}

test('an interactive visual runs sealed: it draws and follows Sotto, and ordinary loads reach nothing', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const listener = await listen()
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-visual-sandbox-'))
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page: view } = launched
    const errors: string[] = []; view.on('pageerror', error => errors.push(error.message))
    await observe(launched)
    const log = await openWorkshop(launched)
    await view.evaluate(value => window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'workshop', text: '', messages: value }), HISTORY)
    await expect(log).toContainText('Here is the queue as a page you can try.')

    const shown = await visualize(view, { title: 'How the queue fills', kind: 'interactive', source: page(listener.port),
      intro: 'Each bar is a minute of sends waiting for the provider.', steps: [{ text: 'The queue grows while Codex is busy.', highlight: ['bars'] }, { text: 'It drains once the turn ends.' }] })
    expect(shown.isError).not.toBe(true)
    expect(shown.content[0]?.text).toBe('Shown in the thread as "How the queue fills": an interactive page with 2 steps, under your last message. Do not repeat the steps in your reply.')

    const card = log.getByRole('region', { name: 'Visual: How the queue fills' })
    await expect(card).toBeVisible()
    await expect(card.locator('.visual-card__kind')).toHaveText('Interactive page')
    const frame = card.locator('.interactive-visual')
    await expect(frame).toHaveAttribute('data-state', 'running', { timeout: 15_000 })

    // The page drew and ran its script, cannot see Sotto's bridge, and was given the read-all step and the theme.
    await expect.poll(async () => (await guestRecord(launched!)).script).toBe('ran')
    // Sent once the page's script has run and again once its load finished: each time step 0 of 2, every step shown.
    await expect.poll(async () => (JSON.parse((await guestRecord(launched!)).steps ?? '[]') as unknown[]).length).toBeGreaterThan(0)
    const steps = JSON.parse((await guestRecord(launched)).steps!) as unknown[]
    for (const step of steps) expect(step).toEqual({ step: 0, total: 2 })
    await expect.poll(async () => (await guestRecord(launched!)).theme ?? '').toMatch(/^dark #[0-9a-f]{6}$/u)
    const first = await guestRecord(launched)
    expect(first.sotto).toBe('undefined')
    expect(await inGuest(launched, '[typeof require, typeof process, typeof module, typeof electron].join()')).toBe('undefined,undefined,undefined,undefined')
    expect(first.scheme).toBe('dark')
    // Sotto measured the page's own 260 pixels and sized the frame to it.
    await expect.poll(() => frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(260)

    // An ordinary fetch and an ordinary image reached nothing: the page saw them blocked, the listener saw nothing.
    await expect.poll(async () => (await guestRecord(launched!)).fetch).toBe('failed')
    const blocked = JSON.parse((await guestRecord(launched)).blocked ?? '[]') as string[]
    expect(blocked).toEqual(expect.arrayContaining(['connect-src', 'img-src']))

    // An ordinary link and an ordinary new-window link go nowhere: the page stays, and no window opens.
    const url = first.url!
    expect(url).toMatch(/^sotto-visual:\/\/page\/[A-Za-z0-9_-]{43}$/u)
    await inGuest(launched, 'document.getElementById("away").click(); document.getElementById("popup").click(); true')
    await view.waitForTimeout(500)
    expect((await guestRecord(launched)).url).toBe(url)

    // An ordinary fetch made by the session itself, outside any page's policy, is cancelled before it leaves.
    const sessionFetch = await launched.app.evaluate(async ({ session }, target) => {
      try { await session.fromPartition('sotto-visual').fetch(target); return 'answered' } catch (error) { return String((error as Error).message) }
    }, `http://127.0.0.1:${listener.port}/from-session`)
    expect(sessionFetch).toContain('ERR_BLOCKED_BY_CLIENT')

    // The session sends a loopback address to its proxy, never directly, and the guest's WebRTC may use only the proxy.
    const sealing = await launched.app.evaluate(async ({ session, webContents }, port) => ({
      proxy: await session.fromPartition('sotto-visual').resolveProxy(`http://127.0.0.1:${port}/`),
      webrtc: webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed()).map(contents => contents.getWebRTCIPHandlingPolicy()),
    }), listener.port)
    expect(sealing.proxy).not.toContain('DIRECT')
    expect(sealing.proxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/u)
    expect(sealing.webrtc).toEqual(['disable_non_proxied_udp'])

    // The page's address was good for one load: asked again, it is gone.
    const again = await launched.app.evaluate(async ({ session }, target) => {
      try { const response = await session.fromPartition('sotto-visual').fetch(target); return response.status } catch { return 'refused' }
    }, url)
    expect(again).not.toBe(200)

    // An Escape the page makes itself moves nothing.
    await view.locator('.interactive-visual__page').focus()
    await inGuest(launched, 'for (let i = 0; i < 20; i++) dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true')
    await view.waitForTimeout(300)
    await expect(card).not.toBeFocused()
    await expect(view.locator('.interactive-visual__page')).toBeFocused()

    // The user's Escape inside the page gives focus back to the card, with its ring showing where focus went. The key
    // is pressed in the guest itself, as a key typed while the page has focus reaches it.
    await launched.app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && !contents.isDestroyed())!
      guest.focus()
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    })
    await expect(card).toBeFocused()
    await expect(card).toHaveCSS('outline-style', 'solid')

    // Show source shows the page's HTML in place of the page, and back; Expand opens it over the window and Escape
    // closes it, back on Expand. The page runs once at a time: the card's stops while Expand shows it.
    const showSource = card.getByRole('button', { name: 'Show source' })
    await showSource.press('Enter')
    await expect(showSource).toHaveAttribute('aria-pressed', 'true')
    await expect(card.getByLabel('How the queue fills source')).toContainText('<h1>Queue depth</h1>')
    await showSource.press('Enter')
    await expect(frame).toHaveAttribute('data-state', 'running', { timeout: 15_000 })
    const expand = card.getByRole('button', { name: 'Expand How the queue fills' })
    await expand.press('Enter')
    const viewer = view.getByRole('dialog', { name: 'Interactive page: How the queue fills' })
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('.interactive-visual')).toHaveAttribute('data-state', 'running', { timeout: 15_000 })
    await expect(card.locator('.interactive-visual[data-state="expanded"]')).toHaveCount(1)
    await expect.poll(() => launched!.app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === 'webview' && !contents.isDestroyed()).length)).toBe(1)
    await view.screenshot({ path: join(SHOTS, 'expanded-1280x800-dark.png'), animations: 'disabled' })
    await view.keyboard.press('Escape')
    await expect(viewer).toBeHidden()
    await expect(expand).toBeFocused()
    await expect(frame).toHaveAttribute('data-state', 'running', { timeout: 15_000 })

    // Light and dark at the sizes the window supports; the theme reaches the page by message and by its style.
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const mode of ['light', 'dark'] as const) {
        await view.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), mode)
        await expect(view.locator('html')).toHaveAttribute('data-theme', mode)
        await expect.poll(async () => (await guestRecord(launched!)).theme ?? '', { timeout: 15_000 }).toMatch(new RegExp(`^${mode} `, 'u'))
        await expect.poll(async () => (await guestRecord(launched!)).scheme).toBe(mode)
        await scrollTo(card)
        const fits = await card.evaluate(element => ({ right: element.getBoundingClientRect().right <= innerWidth, page: document.documentElement.scrollWidth <= innerWidth,
          overflow: element.scrollWidth <= element.clientWidth + 1 }))
        expect(fits).toEqual({ right: true, page: true, overflow: true })
        await view.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await view.screenshot({ path: join(SHOTS, `page-${width}x${height}-${mode}.png`), animations: 'disabled' })
      }
    }

    // With Reduce motion on, the page is told and its style stops movement.
    await resizeWindow(launched, 1280, 800)
    await view.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect.poll(async () => (await guestRecord(launched!)).reduced, { timeout: 15_000 }).toBe('true')
    expect((await guestRecord(launched)).still).toBe('true')
    await scrollTo(card)
    await view.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await view.screenshot({ path: join(SHOTS, 'page-1280x800-dark-reduced-motion.png'), animations: 'disabled' })
    await view.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await expect.poll(async () => (await guestRecord(launched!)).reduced, { timeout: 15_000 }).toBe('false')

    // A page taller than 640 pixels is held to 640 and scrolls inside.
    expect((await visualize(view, { title: 'A tall page', kind: 'interactive', source: TALL })).isError).not.toBe(true)
    const tall = log.getByRole('region', { name: 'Visual: A tall page' }).locator('.interactive-visual')
    await scrollTo(tall)
    await expect.poll(() => tall.evaluate(element => Math.round(element.getBoundingClientRect().height)), { timeout: 15_000 }).toBe(640)

    // A page whose body fills the frame grows to its 300 pixels of content rather than staying at the frame's 160.
    expect((await visualize(view, { title: 'A full-height page', kind: 'interactive', source: FULL })).isError).not.toBe(true)
    const full = log.getByRole('region', { name: 'Visual: A full-height page' }).locator('.interactive-visual')
    await scrollTo(full)
    await expect.poll(() => full.evaluate(element => Math.round(element.getBoundingClientRect().height)), { timeout: 15_000 }).toBe(300)

    // Nothing left the session: every request it saw that was not a page failed, none completed but the pages, no page
    // navigated after its load, no window opened and nothing downloaded. And the listener was never reached.
    const seen = await observed(launched)
    expect(seen.completed.every(item => item.startsWith('sotto-visual://page/'))).toBe(true)
    const toListener = seen.failed.filter(item => item.url.includes(`127.0.0.1:${listener.port}`))
    expect(toListener.length).toBeGreaterThan(0)
    expect(toListener.every(item => item.error === 'net::ERR_BLOCKED_BY_CLIENT')).toBe(true)
    expect(seen.navigations.every(item => item.startsWith('sotto-visual://page/'))).toBe(true)
    expect(seen.navigations.length).toBe(seen.guests)
    expect(seen.popups).toBe(0)
    expect(await launched.app.evaluate(({ webContents }, port) => webContents.getAllWebContents().filter(contents => contents.getURL().includes(`127.0.0.1:${port}`)).length, listener.port)).toBe(0)
    expect(seen.downloads).toBe(0)
    expect(listener.connections()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    listener.server.close()
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
