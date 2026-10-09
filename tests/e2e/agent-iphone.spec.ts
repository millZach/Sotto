import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { BrowserTask } from '../../src/shared/browser'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const SHOTS = resolve('artifacts/test-iphone')
// A small phone app, like an Expo web build: a list taller than the screen, a field and a button that answer touch.
const APP = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daybook</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f3f8;color:#1d1b29;font:16px system-ui}main{padding:56px 22px 40px}h1{font-size:32px;margin:0 0 4px;letter-spacing:-.02em}small{color:#6e6b80;letter-spacing:.1em;text-transform:uppercase;font-size:11px}#habit{display:block;width:100%;margin:22px 0 10px;padding:12px 14px;border:2px solid #7b5cc2;border-radius:14px;font:inherit;background:#fff}#add{width:100%;padding:13px;border:0;border-radius:14px;background:#7b5cc2;color:#fff;font:600 16px system-ui}ul{list-style:none;padding:0;margin:22px 0 0}li{background:#fff;border-radius:14px;padding:16px;margin-bottom:10px}</style></head><body><main><h1>Daybook</h1><small>Your routines</small><input id="habit" placeholder="New habit" aria-label="New habit"><button id="add" ontouchend="window.touched=true">Add habit</button><ul id="list">${Array.from({ length: 12 }, (_, index) => `<li>Routine ${index + 1}</li>`).join('')}</ul></main><script>const add=()=>{const v=document.querySelector('#habit').value.trim();if(!v)return;const li=document.createElement('li');li.textContent=v;document.querySelector('#list').prepend(li);document.querySelector('#habit').value=''};document.querySelector('#add').addEventListener('click',add);document.querySelector('#habit').addEventListener('keydown',e=>{if(e.key==='Enter')add()})</script></body></html>`

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540); host.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
/** The window as the user sees it, native pages included: a page screenshot alone would show the phone's screen empty. */
async function screenshot(launched: LaunchedSotto, name: string): Promise<void> {
  const title = `Sotto test iPhone ${name}`
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; host.setTitle(title); host.show()
  }, title)
  const png = await launched.app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, title) => {
    const bounds = BrowserWindow.getAllWindows().find(item => item.getTitle() === title)!.getBounds()
    const scale = screen.getDisplayMatching(bounds).scaleFactor
    // The OS window manager can be slow to register the retitled window under load; a reached deadline costs nothing.
    for (let attempt = 0; ; attempt++) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } })
      const source = sources.find(item => item.name === title)
      if (source) return source.thumbnail.toPNG().toString('base64')
      if (attempt >= 9) throw new Error('Native window capture unavailable')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }, title)
  await writeFile(join(SHOTS, `${name}.png`), Buffer.from(png, 'base64'))
}
/** The native pages drawn in the main window: each one's address and rectangle. */
async function nativeViews(launched: LaunchedSotto): Promise<{ url: string; bounds: { x: number; y: number; width: number; height: number }; zoom: number }[]> {
  return launched.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => {
      const contents = (view as Electron.WebContentsView).webContents
      return { url: contents.getURL(), bounds: view.getBounds(), zoom: contents.getZoomFactor() }
    })
  })
}

test('an agent tests a web build on the test iPhone while the user watches it float over the thread', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(APP) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('App server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      // The ADR-0029 default stays on: the phone runs without asking, the way a user first meets it.
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
    const tasks = () => page.evaluate(async () => { const result = await window.sotto!.browser!.tasks({ threadId: 'workshop' }); return result.ok ? result.value : [] })

    const opened = await agent('iphone_open', { url, description: 'Checking that a habit can be added on a phone' })
    expect(opened.isError).not.toBe(true)
    const phone = page.getByRole('complementary', { name: 'Test iPhone for Workshop' })
    await expect(phone).toBeVisible()
    // The Browser player never shows a phone task; the phone floats on its own.
    await expect(page.getByRole('complementary', { name: 'Browser for Workshop' })).toHaveCount(0)
    const task = (await tasks()).find(item => item.device === 'iphone') as BrowserTask
    expect(task).toBeDefined()
    const action = (value: unknown) => agent('browser_action', { taskId: task.id, pageId: task.pageId, action: value })

    // The page lays out at the iPhone's 393 CSS pixels however small the player draws it.
    const screen = phone.locator('.phone-player__screen')
    await expect.poll(async () => (await nativeViews(launched)).find(view => view.url === url)?.bounds.width ?? 0).toBeGreaterThan(100)
    const box = await screen.evaluate(element => { const rect = element.getBoundingClientRect(); const x = Math.round(rect.left), y = Math.round(rect.top); return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y } })
    await expect.poll(async () => (await nativeViews(launched)).find(view => view.url === url)?.bounds).toEqual(box)
    const textOf = (result: Awaited<ReturnType<typeof agent>>): string => { const item = result.content.find(entry => entry.type === 'text'); return item?.type === 'text' ? item.text : '' }
    const inspected = JSON.parse(textOf(await action({ type: 'inspect' }))) as { output: string }
    const elements = (JSON.parse(inspected.output) as { elements: { tag: string; name: string; x: number; y: number; width: number; height: number }[] }).elements
    const field = elements.find(item => item.tag === 'input')!, button = elements.find(item => item.tag === 'button')!
    expect(field.width).toBeGreaterThan(300); expect(field.width).toBeLessThan(393)

    // A tap, typing and a key press run at once under the default grant, as a click and typing do in the browser.
    expect((await action({ type: 'tap', x: field.x + field.width / 2, y: field.y + field.height / 2 })).isError).not.toBe(true)
    expect((await action({ type: 'type', text: 'Read 20 pages' })).isError).not.toBe(true)
    expect((await action({ type: 'key', key: 'Enter' })).isError).not.toBe(true)
    expect((await action({ type: 'tap', x: button.x + button.width / 2, y: button.y + button.height / 2 })).isError).not.toBe(true)
    expect((await action({ type: 'swipe', x: 200, y: 700, toX: 200, toY: 300 })).isError).not.toBe(true)
    const shot = await action({ type: 'screenshot' })
    const result = JSON.parse(textOf(shot)) as { output: string }
    expect(JSON.parse(result.output)).toMatchObject({ width: 393, height: 852 })
    expect(shot.content.some(item => item.type === 'image')).toBe(true)
    const state = await launched.app.evaluate(async ({ BrowserWindow, WebContentsView }, url) => {
      const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      const view = host.contentView.children.find(view => view instanceof WebContentsView && (view as Electron.WebContentsView).webContents.getURL() === url) as Electron.WebContentsView
      return view.webContents.executeJavaScript(`({ first: document.querySelector('#list li').textContent, touched: window.touched === true, scrolled: scrollY > 0, width: innerWidth, agent: navigator.userAgent })`)
    }, url) as { first: string; touched: boolean; scrolled: boolean; width: number; agent: string }
    expect(state).toMatchObject({ first: 'Read 20 pages', touched: true, scrolled: true, width: 393 })
    expect(state.agent).toContain('iPhone')

    // A page in Tools > Browser and the phone show at once, each in its own place.
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await phone.getByRole('button', { name: 'Show the test iPhone in Tools' }).click()
    await expect(panel.getByRole('tab', { name: 'iPhone' })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByText('This thread uses the browser and test iPhone without asking')).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Address of the web build' })).toHaveValue(url)
    await panel.getByText(/recorded steps/u).click()
    await expect(panel.getByText('Pressed Enter.', { exact: false })).toBeVisible()

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resize(launched, width, height)
      for (const mode of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        const placed = await phone.boundingBox(); expect(placed).not.toBeNull()
        expect(placed!.x).toBeGreaterThanOrEqual(0); expect(placed!.y).toBeGreaterThanOrEqual(44)
        expect(placed!.x + placed!.width).toBeLessThanOrEqual(width); expect(placed!.y + placed!.height).toBeLessThanOrEqual(height)
        const rail = await panel.locator('.tools-rail').evaluate(element => element.scrollHeight <= element.clientHeight + 1)
        expect(rail).toBe(true)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
        await expect.poll(async () => (await nativeViews(launched)).find(view => view.url === url)?.zoom ?? 0).toBeCloseTo(((await screen.boundingBox())?.width ?? 0) / 393, 1)
        await screenshot(launched, `tools-${width}x${height}-${mode}`)
      }
    }
    await resize(launched, 1280, 800)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await panel.getByRole('button', { name: 'Close tools panel' }).click()
    await screenshot(launched, 'phone-over-thread')

    // Escape hides the phone and the agent keeps working; Tools > iPhone brings it back.
    await phone.getByRole('group', { name: /Move the test iPhone/u }).focus()
    await page.keyboard.press('Escape')
    await expect(phone).toHaveCount(0)
    await expect.poll(async () => (await nativeViews(launched)).some(view => view.url === url)).toBe(false)

    const finished = await agent('browser_finish', { taskId: task.id, pageId: task.pageId, status: 'completed', summary: 'Added a habit by tapping and pressing Enter; the list scrolls by swipe.', unchecked: ['Native iOS rendering'] })
    expect(finished.isError).not.toBe(true)
    expect(errors).toEqual([])
  } finally { await closeSotto(launched); await new Promise<void>(done => server.close(() => done())) }
})
