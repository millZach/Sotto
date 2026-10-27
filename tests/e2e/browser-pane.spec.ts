import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { onReleaseTrack } from './support/releaseTrack'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { BrowserTask } from '../../src/shared/browser'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * The quiet browser pane (ADR-0154), on Owl: an agent opening a page while Tools is open turns Tools to Browser and
 * that page; the agent's work is one strip at the page's foot; Screenshot to message puts the page in the draft; the
 * page steps aside while More is open; and with no page the pane lists what this thread's browser opened.
 */
const SHOTS = evidenceDirectory('artifacts/browser-pane')
const CONTENT = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:16px system-ui}header{padding:20px 24px;border-bottom:1px solid #ced8c9}main{padding:24px;max-width:660px}h1{font-size:40px;font-weight:500;letter-spacing:-.04em;margin:10px 0}p{line-height:1.6;color:#546850}.landscape{height:120px;background:linear-gradient(150deg,#dbe0d0 35%,#a7b8a0 35%,#a7b8a0 57%,#688a73 57%,#688a73 76%,#294b3e 76%);margin:20px 0}button{background:#304f3d;color:white;border:0;border-radius:5px;padding:12px 18px;font:inherit}#saved{min-height:28px}</style></head><body><header>Fieldnotes</header><main><h1>Take the long way home.</h1><p>A place to save the trails you want to return to.</p><div class="landscape"></div><button id="save" onclick="document.querySelector('#saved').textContent='Trail saved'">Save trail</button><p id="saved" role="status"></p></main></body></html>`

async function shot(launched: LaunchedSotto, name: string): Promise<void> {
  await launched.page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
  // The window's own pixels, native page included, even under another window; a minimized window is not listed.
  await launched.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; if (window.isMinimized()) window.restore() })
  await captureSotto(launched, join(SHOTS, `${name}.png`), { mode: 'native-window', title: `Sotto browser pane ${name}`, retries: 9, retryDelayMs: 500 })
}
/** The window at a content size; a maximized window ignores a new size, so it is restored first. */
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  // A window minimized or maximized meanwhile ignores a new size, so it is restored and asked again.
  for (let attempt = 0; ; attempt++) {
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
      if (window.isFullScreen()) window.setFullScreen(false)
      if (window.isMaximized()) window.unmaximize()
      if (window.isMinimized()) window.restore()
    })
    try { await resizeContentWindow(launched, width, height, [800, 540]); return } catch (error) {
      if (attempt >= 3) throw error
    }
  }
}
async function appearance(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
}
/** Main draws exactly one native page in the window, at the pane's viewport, or none while something covers it. */
async function nativePages(launched: LaunchedSotto): Promise<{ url: string; bounds: Electron.Rectangle }[]> {
  return launched.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    return host.contentView.children.filter(view => view instanceof WebContentsView).map(view => ({ url: (view as Electron.WebContentsView).webContents.getURL(), bounds: view.getBounds() }))
  })
}
async function viewportBounds(panel: Locator): Promise<Electron.Rectangle> {
  return panel.locator('.browser-viewport').evaluate(element => { const rect = element.getBoundingClientRect(); const x = Math.round(rect.left), y = Math.round(rect.top); return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y } })
}
/** Nothing in the pane's row or strip runs past the panel, and the window does not scroll sideways. */
async function fits(page: Page, panel: Locator): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const box = (await panel.boundingBox())!
  for (const part of await panel.locator('.browser-pane__row, .browser-pane__strip, .browser-pane__tabs').all()) {
    const rect = (await part.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(box.x - 1); expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1)
  }
}

test('the quiet browser pane opens on its own, speaks in one strip, and puts a screenshot in the message', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const host = `127.0.0.1:${address.port}`
  const report: Record<string, unknown> = {}
  try {
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto()
      const { page } = launched
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      try {
        await page.evaluate(async () => {
          // The ADR-0029 default stays on: the agent opens, clicks and types without asking.
          await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
          await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
          await window.sotto!.agents!.command({ type: 'connect' })
        })
        await page.reload(); await size(launched, 1280, 800); await openThreads(page)
        await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
        const agent = (name: string, args: unknown) => page.evaluate(async request => window.sottoE2E!.browserAgent!(request), { threadId: 'workshop', name, arguments: args })
        const tasks = () => page.evaluate(async () => { const result = await window.sotto!.browser!.tasks({ threadId: 'workshop' }); return result.ok ? result.value : [] })

        // Tools is open on Files, and the user is elsewhere: the agent's page takes Tools to Browser.
        await page.getByRole('button', { name: 'Tools', exact: true }).click()
        const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
        await panel.getByRole('tab', { name: 'Files' }).click()
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        const opened = await agent('browser_open', { url, description: 'Checking that a trail can be saved' })
        expect(opened.isError).not.toBe(true)
        await expect(panel.getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true')
        await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(url)
        await expect(page.getByRole('complementary', { name: 'Browser for Workshop' })).toBeHidden()
        // One row: no tab line for one page, no grant line, no task line, no steps fold.
        await expect(panel.getByRole('tablist', { name: 'Pages' })).toHaveCount(0)
        await expect(panel.getByText('This thread uses the browser without asking')).toHaveCount(0)
        await expect(panel.locator('.browser-task')).toHaveCount(0)
        await expect.poll(async () => nativePages(launched)).toEqual([{ url, bounds: await viewportBounds(panel) }])

        const task = (await tasks())[0] as BrowserTask
        const action = (step: unknown) => agent('browser_action', { taskId: task.id, pageId: task.pageId, action: step })
        const inspect = await action({ type: 'inspect' })
        const text = inspect.content.find(item => item.type === 'text'); if (!text || text.type !== 'text') throw new Error('Inspection missing')
        const save = (JSON.parse(JSON.parse(text.text).output) as { elements: { tag: string; name: string; x: number; y: number; width: number; height: number }[] }).elements.find(item => item.tag === 'button' && item.name === 'Save trail')!
        expect((await action({ type: 'click', x: save.x + save.width / 2, y: save.y + save.height / 2 })).isError).not.toBe(true)
        const strip = panel.locator('.browser-pane__strip')
        await expect(strip).toHaveText(/Agent is browsing · clicked in the page/)
        await expect(strip.getByRole('button', { name: 'Pause' })).toBeVisible()
        // The strip sits under the native page, never over it.
        const pageBox = await viewportBounds(panel), stripBox = (await strip.boundingBox())!
        expect(stripBox.y).toBeGreaterThanOrEqual(pageBox.y + pageBox.height - 1)
        const dot = await strip.locator('.browser-pane__dot').evaluate(element => getComputedStyle(element).animationName)
        expect(dot).toBe('none')

        for (const [width, height] of [[1280, 800], [820, 560]] as const) {
          await size(launched, width, height)
          for (const mode of ['dark', 'light'] as const) {
            await appearance(page, mode)
            await expect.poll(async () => nativePages(launched)).toEqual([{ url, bounds: await viewportBounds(panel) }])
            await fits(page, panel)
            const contrast = await strip.evaluate(element => {
              const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
              const context = canvas.getContext('2d')!
              const luminance = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0) }
              const background = luminance(getComputedStyle(element).backgroundColor)
              return ['.browser-pane__lead', '.browser-pane__last'].map(selector => { const foreground = luminance(getComputedStyle(element.querySelector(selector)!).color); return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05) })
            })
            contrast.forEach(ratio => expect(ratio).toBeGreaterThanOrEqual(4.5))
            report[`agent-${width}x${height}-${mode}`] = { contrast, viewport: await viewportBounds(panel) }
            await shot(launched, `agent-${width}x${height}-${mode}`)
          }
        }
        await size(launched, 1280, 800); await appearance(page, 'dark')

        // Pause and Resume, from the strip.
        await strip.getByRole('button', { name: 'Pause' }).click()
        await expect(strip).toHaveText(/Browsing paused · clicked in the page/)
        await shot(launched, 'paused-1280x800-dark')
        await strip.getByRole('button', { name: 'Resume' }).click()
        await expect(strip.getByRole('button', { name: 'Pause' })).toBeVisible()

        // Screenshot to message: the page goes into the draft, and the composer shows it.
        await panel.getByRole('button', { name: 'Screenshot to message' }).click()
        await expect(panel.getByRole('button', { name: 'Screenshot to message' })).toBeEnabled({ timeout: 30_000 })
        await expect(panel.locator('.tools-panel__status')).toHaveText(/^Added to the draft for /)
        await expect.poll(() => page.evaluate(async () => { const state = await window.sotto!.agents!.get(); const id = state.hostId === undefined ? 'workshop' : `host:${state.hostId}:workshop`; return state.threadDrafts?.find(item => item.threadId === id)?.attachments.length ?? 0 })).toBe(1)
        await expect(page.locator('.thread-pane[data-focused]').getByRole('button', { name: /Remove Browser feedback\.png/ })).toBeVisible()
        await shot(launched, 'screenshot-to-message-1280x800-dark')

        // More: the page steps aside while it is open, and Escape gives focus back to its button.
        const more = panel.getByRole('button', { name: 'More browser actions' })
        await more.click()
        const menu = panel.getByRole('menu', { name: 'More browser actions' })
        await expect(menu.getByRole('menuitem', { name: 'Ask before this thread uses the browser' })).toBeVisible()
        await expect(menu.getByRole('menuitemradio', { name: 'Fit the pane' })).toHaveAttribute('aria-checked', 'true')
        await expect.poll(() => nativePages(launched)).toEqual([])
        await expect(panel.getByText('The page steps aside while a menu or dialog is open.')).toBeVisible()
        await shot(launched, 'more-menu-1280x800-dark')
        await size(launched, 820, 560)
        await expect(menu).toBeVisible()
        const menuBox = (await menu.boundingBox())!
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(560)
        await appearance(page, 'light')
        await shot(launched, 'more-menu-820x560-light')
        await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
        await expect(more).toBeFocused()
        await expect.poll(async () => nativePages(launched)).toEqual([{ url, bounds: await viewportBounds(panel) }])
        await size(launched, 1280, 800); await appearance(page, 'dark')

        // Ask before this thread uses the browser ends the grant; the item leaves the menu.
        await more.click()
        await menu.getByRole('menuitem', { name: 'Ask before this thread uses the browser' }).click()
        await expect(more).toBeFocused()
        await more.click()
        await expect(menu.getByRole('menuitem', { name: 'Ask before this thread uses the browser' })).toHaveCount(0)
        await page.keyboard.press('Escape')

        // A second page puts the tabs on their own line above the row.
        await more.click()
        await menu.getByRole('menuitem', { name: 'New page' }).click()
        const fresh = panel.getByRole('textbox', { name: 'Address for a new page' })
        await expect(fresh).toBeFocused()
        await fresh.fill(`${url}notes`); await fresh.press('Enter')
        await expect(panel.getByRole('tablist', { name: 'Pages' }).getByRole('tab')).toHaveCount(2)
        // Tools shows this thread's browser, so the agent's page does not float over the thread as well.
        await expect(page.getByRole('complementary', { name: /^Browser for/ })).toHaveCount(0)
        await shot(launched, 'two-pages-1280x800-dark')

        await agent('browser_finish', { taskId: task.id, pageId: task.pageId, status: 'completed', summary: 'Saved the trail.', unchecked: [] })
        await expect(panel.locator('.browser-pane__strip')).toHaveCount(0)

        // Closing every page leaves the address and what this thread's browser opened this session.
        await panel.getByRole('button', { name: /^Close page: / }).click()
        await expect(panel.getByRole('tablist', { name: 'Pages' })).toHaveCount(0)
        await more.click()
        await menu.getByRole('menuitem', { name: 'Close page' }).click()
        await expect(panel.getByRole('textbox', { name: 'Address for a new page' })).toBeVisible()
        const openedList = panel.getByRole('region', { name: 'Opened this session' })
        await expect(openedList).toBeVisible()
        await expect(openedList.getByRole('button', { name: `Open ${host}`, exact: true })).toBeVisible()
        await expect(openedList.getByRole('button', { name: `Open ${host}/notes`, exact: true })).toBeVisible()
        await expect.poll(() => nativePages(launched)).toEqual([])
        await expect(page.getByRole('complementary', { name: /^Browser for/ })).toHaveCount(0)
        for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(launched, `empty-1280x800-${mode}`) }
        await size(launched, 820, 560); await fits(page, panel)
        await shot(launched, 'empty-820x560-light')

        // Tools closed: the next page the agent opens floats in the player instead.
        await appearance(page, 'dark'); await size(launched, 1280, 800)
        await panel.getByRole('button', { name: 'Close tools panel' }).click()
        // The grant was ended above, so this open waits for the user's answer, which the player offers.
        const later = agent('browser_open', { url: `${url}later`, description: 'Checking a later page' })
        const player = page.getByRole('complementary', { name: 'Browser for Workshop' })
        await expect(player).toBeVisible()
        await expect(panel).toBeHidden()
        await shot(launched, 'player-tools-closed-1280x800-dark')
        await player.getByRole('button', { name: 'Allow once' }).click()
        expect((await later).isError).not.toBe(true)
        expect(errors).toEqual([])
        await writeFile(join(SHOTS, 'verification.json'), JSON.stringify({ track: 'owl', sizes: report, errors }, null, 2))
      } catch (error) {
        await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
        throw error
      } finally { await closeSotto(launched) }
    })
  } finally { await new Promise<void>(done => server.close(() => done())) }
})
