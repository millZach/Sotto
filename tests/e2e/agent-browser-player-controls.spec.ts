import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Evidence for the browser player's keyboard and pointer resize/move path, and the corner-resize jump fix
// (two-axis review of #331's floating player). `agent-browser.spec.ts` and `tools-sidecar.spec.ts` already cover
// the player's layout, contrast and lifecycle at every window size; this spec covers what those never drove with
// real pointer and keyboard input.
const SHOTS = resolve('artifacts/thread-browser-player')
const CONTENT = `<!doctype html><html><head><title>Fieldnotes</title></head><body><h1>Fieldnotes</h1></body></html>`

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    host.setMinimumSize(800, 540); host.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}

async function nativeCapture(launched: LaunchedSotto, name: string): Promise<void> {
  const title = `Sotto browser player controls ${name}`
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

test('the browser player moves and resizes with the pointer and the keyboard, without a first-resize jump', async () => {
  test.setTimeout(180_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(CONTENT) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview server unavailable')
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchSotto().catch(error => { server.close(); throw error })
  const { page } = launched
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload(); await resize(launched, 1280, 800); await openThreads(page)
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('button', { name: 'Workshop', exact: true }).first().click()
    await page.evaluate(async request => { await window.sottoE2E!.browserAgent!(request) }, { threadId: 'workshop', name: 'browser_open', arguments: { url, description: 'Checking the field notes' } })

    const player = page.getByRole('complementary', { name: 'Browser for Workshop' })
    await expect(player).toBeVisible()
    // The arrival animation moves and scales the player; let it finish before reading positions from it.
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))) })
    const bar = player.getByRole('group', { name: /Move the browser\. Drag, or use the arrow keys/ })
    const grip = player.getByRole('separator', { name: /Resize the browser\. Use the arrow keys/ })

    // Drag the title bar with the pointer: the player moves, stays inside the window and below the drag strip.
    const before = (await player.boundingBox())!
    const barBox = (await bar.boundingBox())!
    const barStartX = barBox.x + barBox.width / 2, barStartY = barBox.y + barBox.height / 2
    await page.mouse.move(barStartX, barStartY)
    await page.mouse.down()
    for (let step = 1; step <= 8; step++) await page.mouse.move(barStartX - step * 15, barStartY + step * 11)
    await page.mouse.up()
    await expect.poll(async () => (await player.boundingBox())!.x).not.toBe(before.x)
    const dragged = (await player.boundingBox())!
    expect(dragged.x).toBeGreaterThanOrEqual(0)
    expect(dragged.y).toBeGreaterThanOrEqual(44) // below the drag strip
    expect(dragged.x + dragged.width).toBeLessThanOrEqual(1280)
    expect(dragged.y + dragged.height).toBeLessThanOrEqual(800)

    // Resize from the corner with the pointer, on the very first resize the player has ever had: the top-left
    // corner stays exactly where it was drawn (no jump between a pane-anchored and a window-anchored default).
    const beforeResize = (await player.boundingBox())!
    const gripBox = (await grip.boundingBox())!
    const gripStartX = gripBox.x + gripBox.width / 2, gripStartY = gripBox.y + gripBox.height / 2
    await page.mouse.move(gripStartX, gripStartY)
    await page.mouse.down()
    for (let step = 1; step <= 6; step++) await page.mouse.move(gripStartX + step * 10, gripStartY + step * 7)
    await page.mouse.up()
    await expect.poll(async () => (await player.boundingBox())!.width).toBeGreaterThan(beforeResize.width)
    const resized = (await player.boundingBox())!
    expect(resized.x).toBeCloseTo(beforeResize.x, 0)
    expect(resized.y).toBeCloseTo(beforeResize.y, 0)
    expect(resized.height).toBeGreaterThan(beforeResize.height)
    expect(resized.x + resized.width).toBeLessThanOrEqual(1280)
    expect(resized.y + resized.height).toBeLessThanOrEqual(800)

    // The drag bar's own arrow keys move the player.
    await bar.focus()
    const beforeKeyMove = (await player.boundingBox())!
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await player.boundingBox())!.x).toBe(beforeKeyMove.x + 16)

    // The corner grip is focusable and its own arrow keys resize the player.
    await grip.focus()
    await expect(grip).toBeFocused()
    const beforeKeyResize = (await player.boundingBox())!
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await player.boundingBox())!.width).toBe(beforeKeyResize.width + 16)
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await player.boundingBox())!.height).toBe(beforeKeyResize.height + 16)

    await resize(launched, 1600, 1000)
    await expect(player.locator('.browser-player__viewport')).toBeVisible()
    const atSize = (await player.boundingBox())!
    expect(atSize.x + atSize.width).toBeLessThanOrEqual(1600)
    expect(atSize.y + atSize.height).toBeLessThanOrEqual(1000)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await nativeCapture(launched, 'player-1600x1000-dark')

    expect(errors).toEqual([])
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
    console.error(await page.locator('body').innerText().catch(() => 'No renderer'))
    throw error
  } finally { await closeSotto(launched); await new Promise<void>(done => server.close(() => done())) }
})
