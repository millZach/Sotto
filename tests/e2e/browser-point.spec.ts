import { captureSotto } from './support/sottoCapture'
import { resizeContentWindow } from './support/sottoWindow'
import { onReleaseTrack } from './support/releaseTrack'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto, toggleTools } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * Point at something (ADR-0154), on Owl: Point turns on Chromium's own inspect overlay over the page in Tools, the
 * element under the pointer is named in the line over the page, a click takes a picture and opens a comment beside the
 * element, and Add to message puts the element, its picture and the comment in the thread's draft. Escape closes the
 * comment, and again leaves Point.
 *
 * Playwright's mouse and keyboard drive Sotto's own window, never the native page main draws over it, so the pointer
 * and the keys reach the page through `webContents.sendInputEvent`: real input through Chromium, which the overlay and
 * main read exactly as they read the user's mouse and keyboard.
 */
const SHOTS = evidenceDirectory('artifacts/browser-point')
const CONTENT = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fieldnotes</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f1e8;color:#273e34;font:16px system-ui}header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid #ced8c9}main{padding:24px;max-width:660px}h1{font-size:36px;font-weight:500;letter-spacing:-.04em;margin:10px 0}p{line-height:1.6;color:#546850}button{background:#304f3d;color:white;border:0;border-radius:5px;padding:10px 16px;font:inherit}#saved{min-height:28px}</style></head><body><header><b>Fieldnotes</b><button id="sign-in">Sign in</button></header><main><h1>Take the long way home.</h1><p>A place to save the trails you want to return to.</p><button id="save" onclick="document.querySelector('#saved').textContent='Trail saved'">Save trail</button><p id="saved" role="status"></p></main></body></html>`

async function shot(launched: LaunchedSotto, name: string): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!; if (window.isMinimized()) window.restore() })
  await captureSotto(launched, join(SHOTS, `${name}.png`), { mode: 'native-window', title: `Sotto point at something ${name}`, retries: 9, retryDelayMs: 500 })
}
async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
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
/** The centre of `selector` in the native page, in its CSS pixels. Read by the test, never by Sotto. */
async function centre(launched: LaunchedSotto, url: string, selector: string): Promise<{ x: number; y: number }> {
  return launched.app.evaluate(async ({ webContents }, { url, selector }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)!
    return contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`) as Promise<{ x: number; y: number }>
  }, { url, selector })
}
/** Real pointer input to the native page: a move, or a move and a left click. */
async function pointer(launched: LaunchedSotto, url: string, at: { x: number; y: number }, click = false): Promise<void> {
  await launched.app.evaluate(({ webContents }, { url, at, click }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)!
    contents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
    if (click) {
      contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    }
  }, { url, at, click })
}
/** A key pressed in the native page, through Chromium's own input, as a keyboard would. */
async function key(launched: LaunchedSotto, url: string, keyCode: 'Tab' | 'Enter' | 'Escape'): Promise<void> {
  await launched.app.evaluate(({ webContents }, { url, keyCode }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)!
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
  }, { url, keyCode })
}
async function pageText(launched: LaunchedSotto, url: string, selector: string): Promise<string> {
  return launched.app.evaluate(async ({ webContents }, { url, selector }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)!
    return contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).textContent`) as Promise<string>
  }, { url, selector })
}

/**
 * Whether turning Point on gave the page the keyboard. Windows reports a web page focused only while its window is the
 * foreground window, which a test run on a computer someone is using cannot promise, so with another app in front this
 * says nothing; the keys this spec sends reach the page directly either way.
 */
async function pageHasKeyboard(launched: LaunchedSotto, url: string): Promise<boolean> {
  return launched.app.evaluate(({ BrowserWindow, webContents }, url) => {
    const foreground = BrowserWindow.getFocusedWindow() !== null
    return !foreground || webContents.getAllWebContents().find(item => item.getURL() === url)!.isFocused()
  }, url)
}

test('point at something names the element, takes its picture and puts it in the message with a comment', async () => {
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const report: Record<string, unknown> = {}
  try {
    await onReleaseTrack('owl', async () => {
      const launched = await launchSotto()
      const { page } = launched
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
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
        const fresh = panel.getByRole('textbox', { name: 'Address for a new page' })
        await fresh.fill(url); await fresh.press('Enter')
        await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(url)
        await expect.poll(() => launched.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(item => item.getURL() === url && !item.isLoading()), url)).toBe(true)

        // Point sits in the row, after the address and before Screenshot to message.
        const point = panel.getByRole('button', { name: 'Point at something' })
        await expect(point).toHaveAttribute('aria-pressed', 'false')
        await point.click()
        await expect(point).toHaveAttribute('aria-pressed', 'true')
        const line = panel.locator('.browser-point__line')
        await expect(line).toHaveText(/Click something, or Tab to it and press Enter · Esc to stop/)

        // The pointer over Sign in: Chromium's overlay outlines it and the line names it.
        const signIn = await centre(launched, url, '#sign-in')
        await expect.poll(async () => { await pointer(launched, url, { x: signIn.x + 1, y: signIn.y }); await pointer(launched, url, signIn); return (await line.textContent()) ?? '' }, { timeout: 30_000 }).toContain('button · Sign in')
        for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await pointer(launched, url, signIn); await shot(launched, `hover-1280x800-${mode}`) }
        await appearance(page, 'dark')

        // A click picks it, takes a picture and opens the comment beside it; the page itself is not clicked.
        // A window capture can minimize and restore the window, which ends pointing as hiding the window should (item 3
        // of the review). Point again if it did, so the click below is a pick.
        if (await point.getAttribute('aria-pressed') !== 'true') {
          await point.click()
          await expect(point).toHaveAttribute('aria-pressed', 'true')
          await expect.poll(async () => { await pointer(launched, url, { x: signIn.x + 1, y: signIn.y }); await pointer(launched, url, signIn); return (await line.textContent()) ?? '' }, { timeout: 30_000 }).toContain('button · Sign in')
        }
        await pointer(launched, url, signIn, true)
        const comment = panel.getByRole('dialog', { name: 'Point at button · Sign in' })
        await expect(comment).toBeVisible()
        const field = comment.getByRole('textbox', { name: 'What should the agent know about this?' })
        await expect(field).toBeFocused()
        await expect(panel.getByRole('img', { name: 'The page when you pointed at button · Sign in' })).toBeVisible()
        await expect(panel.locator('.browser-point__chip')).toHaveText('button · Sign in')
        // The native page steps aside for its picture.
        await expect.poll(() => launched.app.evaluate(({ BrowserWindow, WebContentsView }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.contentView.children.filter(view => view instanceof WebContentsView).length)).toBe(0)
        // The outline sits on the element in the picture.
        const outline = (await panel.locator('.browser-point__outline').boundingBox())!, picture = (await panel.locator('.browser-point__frame').boundingBox())!
        report.outline = { outline, picture, element: signIn }
        // The picture is the page at Fit the pane, drawn at its own size, so the element's centre is where it was on the page.
        expect(Math.abs(outline.x + outline.width / 2 - picture.x - signIn.x)).toBeLessThan(12)
        expect(Math.abs(outline.y + outline.height / 2 - picture.y - signIn.y)).toBeLessThan(12)
        for (const [width, height] of [[1280, 800], [820, 560]] as const) {
          await size(launched, width, height)
          for (const mode of ['dark', 'light'] as const) {
            await appearance(page, mode)
            await expect(comment).toBeVisible()
            const pop = (await comment.boundingBox())!, frame = (await panel.locator('.browser-point').boundingBox())!
            // The comment stays inside the page's place, at the minimum window too.
            expect(pop.x).toBeGreaterThanOrEqual(frame.x - 1); expect(pop.x + pop.width).toBeLessThanOrEqual(frame.x + frame.width + 1)
            expect(pop.y).toBeGreaterThanOrEqual(frame.y - 1); expect(pop.y + pop.height).toBeLessThanOrEqual(frame.y + frame.height + 1)
            report[`comment-${width}x${height}-${mode}`] = { popover: pop, place: frame }
            await shot(launched, `comment-${width}x${height}-${mode}`)
          }
        }
        await size(launched, 1280, 800); await appearance(page, 'dark')
        expect(await pageText(launched, url, '#saved')).toBe('')

        // Escape closes the comment and goes back to pointing on the live page, which has the keyboard again; Escape
        // pressed in the page then leaves Point, and the Point button has the keyboard.
        await field.press('Escape')
        await expect(comment).toBeHidden()
        await expect(point).toHaveAttribute('aria-pressed', 'true')
        await expect(line).toBeVisible()
        await expect.poll(() => pageHasKeyboard(launched, url)).toBe(true)
        await key(launched, url, 'Escape')
        await expect(point).toHaveAttribute('aria-pressed', 'false')
        await expect(line).toBeHidden()
        await expect(point).toBeFocused()
        await expect(panel).toBeVisible()

        // Point again from the keyboard: Enter on Point, Tab through the page to Save trail, and Enter picks it.
        // Enter goes down and comes up as a person's key does, a moment apart: press() sends both within a few
        // milliseconds through the debugger, and its key-up can land on Sotto's own window after main has handed the
        // page the keyboard. The page keeps the keyboard through the key-up.
        await point.focus(); await page.keyboard.down('Enter')
        await expect(line).toBeVisible()
        await expect.poll(() => pageHasKeyboard(launched, url)).toBe(true)
        await page.keyboard.up('Enter')
        await expect.poll(() => pageHasKeyboard(launched, url)).toBe(true)
        await key(launched, url, 'Tab'); await key(launched, url, 'Tab')
        await expect.poll(() => pageText(launched, url, '#save').then(() => launched.app.evaluate(async ({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL() === url)!.executeJavaScript('document.activeElement.id') as Promise<string>, url))).toBe('save')
        await key(launched, url, 'Enter')
        const saveComment = panel.getByRole('dialog', { name: 'Point at button · Save trail' })
        await expect(saveComment).toBeVisible()
        await saveComment.getByRole('textbox').fill('This should say Save, to match the header.')
        await saveComment.getByRole('button', { name: 'Add to message' }).click()
        await expect(saveComment).toBeHidden({ timeout: 30_000 })
        await expect(panel.locator('.tools-panel__status')).toHaveText(/^Added to the draft for /)
        await expect(point).toHaveAttribute('aria-pressed', 'false')
        await expect(point).toBeFocused()
        expect(await pageText(launched, url, '#saved')).toBe('')
        const readDraft = () => page.evaluate(async () => { const state = await window.sotto!.agents!.get(); const id = state.hostId === undefined ? 'workshop' : `host:${state.hostId}:workshop`; return state.threadDrafts?.find(item => item.threadId === id) })
        // The draft reaches main a moment after the composer has it. It is one item: the picture, named after the
        // element, carrying the comment and the context; the composer's text stays the user's own, empty here.
        await expect.poll(async () => (await readDraft())?.attachments.map(item => item.name)).toEqual(['button · Save trail'])
        const draft = await readDraft()
        expect(draft?.text).toBe('')
        const feedback = draft?.attachments[0]?.browserFeedback
        expect(feedback).toMatchObject({ label: 'button · Save trail', comment: 'This should say Save, to match the header.' })
        expect(feedback?.context).toContain('Selected element: button (button) - Save trail')
        expect(feedback?.context).toContain('Selector: #save')
        report.draft = draft
        const composer = page.locator('.thread-pane[data-focused]')
        await expect(composer.getByRole('button', { name: /Remove button · Save trail/ })).toBeVisible()
        await expect(composer.locator('.screenshot-previews__note')).toHaveText('This should say Save, to match the header.')
        await expect(composer.getByRole('textbox').first()).not.toContainText('Selector')
        for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(launched, `added-1280x800-${mode}`) }
        await size(launched, 820, 560)
        for (const mode of ['dark', 'light'] as const) { await appearance(page, mode); await shot(launched, `added-820x560-${mode}`) }
        expect(errors).toEqual([])
        await writeFile(join(SHOTS, 'verification.json'), JSON.stringify({ track: 'owl', report, errors }, null, 2))
      } catch (error) {
        await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
        throw error
      } finally { await closeSotto(launched) }
    })
  } finally { await new Promise<void>(done => server.close(() => done())) }
})
