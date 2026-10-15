import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'

// Real Electron renders of a sent image opened large over its thread pane (prototype variant C), and the copy
// control in its bottom-left corner (variant A). Same fixture as copy-message.spec.ts, in its images scenario;
// copied images are recorded in main at globalThis.activityFixture.copiedImages.
const shots = evidenceDirectory('artifacts/image-viewer')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--config', 'tests/fixtures/threadActivity/vite.config.mjs'], { stdio: 'inherit' })
  await mkdir(shots, { recursive: true })
})

async function launch(options: { width?: number; height?: number } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(Object.entries({
    ...process.env,
    SOTTO_ACTIVITY_FIXTURE: '1',
    SOTTO_ACTIVITY_FIXTURE_WIDTH: String(options.width ?? 1280),
    SOTTO_ACTIVITY_FIXTURE_HEIGHT: String(options.height ?? 800),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/threadActivity/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => window.activityFixture!.show('images'))
  await expect(page.getByRole('log', { name: 'Thread transcript' })).toBeVisible()
  return { app, page }
}

const theme = (page: Page, mode: 'dark' | 'light'): Promise<void> => page.evaluate(mode => { document.documentElement.dataset.theme = mode! }, mode)
const copiedImages = (app: ElectronApplication): Promise<{ width: number; height: number }[]> =>
  app.evaluate(() => (globalThis as unknown as { activityFixture: { copiedImages: { width: number; height: number }[] } }).activityFixture.copiedImages)

test('a sent image opens over its pane, steps through the message, copies and closes back to its thumbnail', async () => {
  const { app, page } = await launch()
  try {
    const sent = page.locator('.thread-message[data-role="user"]').first()
    await sent.scrollIntoViewIfNeeded()
    await sent.hover()
    await expect(sent.getByRole('button', { name: 'Copy message as Markdown' })).toHaveCSS('opacity', '1')
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await sent.screenshot({ path: resolve(shots, `message-hover-1280-${mode}.png`) })
    }
    await theme(page, 'dark')

    const thumbnail = sent.getByRole('button', { name: 'Open image.png' }).first()
    await thumbnail.click()
    await expect(page.getByRole('dialog', { name: /image\.png/u })).toBeVisible()
    const viewer = page.getByRole('dialog')
    // It covers the thread pane, not the window: the sidebar stays in view.
    const pane = await page.locator('.thread-pane').first().boundingBox()
    const box = await viewer.boundingBox()
    expect(box).toEqual(pane)
    await expect(viewer.getByRole('group', { name: 'Image view' })).toBeFocused()
    await expect(viewer).toContainText('PNG · 449 KB · 1 of 3')
    await expect(viewer.getByRole('img', { name: 'image.png' })).toHaveJSProperty('naturalWidth', 1600)
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await page.screenshot({ path: resolve(shots, `viewer-1280-${mode}.png`) })
    }
    await theme(page, 'dark')

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(viewer).toContainText('settings.png')
    await expect(viewer).toContainText('3 of 3')
    await page.keyboard.press('+')
    await page.keyboard.press('+')
    await expect(viewer.getByRole('button', { name: 'Fit to view' })).toHaveAttribute('aria-pressed', 'false')
    await page.screenshot({ path: resolve(shots, 'viewer-zoomed-1280-dark.png') })
    await page.keyboard.press('0')
    await expect(viewer.getByRole('button', { name: 'Fit to view' })).toHaveAttribute('aria-pressed', 'true')

    await viewer.getByRole('button', { name: 'Copy image' }).click()
    await expect(viewer.locator('.rich-code__status')).toHaveText('Copied image')
    await expect.poll(async () => (await copiedImages(app)).at(-1)).toEqual({ width: 1200, height: 420 })

    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()
    await expect(thumbnail).toBeFocused()

    // Right-click on a thumbnail offers the same two things.
    await thumbnail.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Image: image.png' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Open image', 'Copy image'])
    await page.screenshot({ path: resolve(shots, 'thumbnail-menu-1280-dark.png') })
    await menu.getByRole('menuitem', { name: 'Copy image' }).click()
    await expect.poll(async () => (await copiedImages(app)).at(-1)).toEqual({ width: 1600, height: 1000 })
  } finally { await app.close() }
})
