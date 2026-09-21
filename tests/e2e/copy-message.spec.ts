import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

// Real Windows Electron renders of the per-message copy control (#128), variant C: a floating mark
// on each finished message's top-right corner. Same fixture as thread-activity.spec.ts; copies are
// recorded in main at globalThis.activityFixture.copied.
const shots = resolve(process.cwd(), 'artifacts/copy-message')
declare global { interface Window { activityFixture?: { show: (scenario: 'settled' | 'live' | 'disconnected' | 'restored') => void } } }

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
    SOTTO_ACTIVITY_FIXTURE_HEIGHT: String(options.height ?? 860),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({ args: [resolve('tests/fixtures/threadActivity/electronMain.cjs')], env })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByRole('log', { name: 'Thread transcript' })).toBeVisible()
  return { app, page }
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Thread transcript' })
const theme = (page: Page, mode: 'dark' | 'light'): Promise<void> => page.evaluate(mode => { document.documentElement.dataset.theme = mode! }, mode)
const copied = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { activityFixture: { copied: string[] } }).activityFixture.copied)

// The settled fixture's final reply (m3): plain prose with one inline `let`/`const` code span.
const REPLY_SOURCE = 'Fixed. The length marker is patched after every chunk, so playback no longer stops at two seconds. Lint flagged one `let` that I changed to `const`; the three new tests pass.'

test('the copy control reveals on hover and focus, copies Markdown, and offers plain text', async () => {
  const { app, page } = await launch()
  try {
    const log = transcript(page)
    const reply = log.locator('.thread-message').last()
    const control = reply.getByRole('button', { name: 'Copy reply as Markdown' })
    await expect(control).toBeAttached()

    // Hidden at rest, revealed while the message is under the pointer.
    await expect(control).toHaveCSS('opacity', '0')
    await reply.hover()
    await expect(control).toHaveCSS('opacity', '1')
    for (const mode of ['dark', 'light'] as const) {
      await theme(page, mode)
      await page.screenshot({ path: resolve(shots, `reply-hover-1280-${mode}.png`) })
    }
    await theme(page, 'dark')
    await page.locator('.thread-nav, aside, nav').first().hover()
    await page.mouse.move(40, 400)
    await expect(control).toHaveCSS('opacity', '0')

    // Keyboard: focus reveals it with a visible ring.
    await control.focus()
    await expect(control).toHaveCSS('opacity', '1')
    await expect(control).toHaveCSS('outline-style', 'solid')

    // A press copies the message's source Markdown verbatim.
    await page.keyboard.press('Enter')
    await expect(control.locator('.thread-message__copy-label')).toHaveText('Copied')
    await expect.poll(async () => (await copied(app)).at(-1)).toBe(REPLY_SOURCE)
    await expect.poll(async () => (await copied(app)).at(-1)).toContain('`let`')

    // The menu offers plain text: the rendered words without Markdown marks.
    await control.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'Copy options' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveCount(2)
    await page.screenshot({ path: resolve(shots, 'menu-1280-dark.png') })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(control).toBeFocused()
    await expect.poll(async () => (await copied(app)).at(-1)).toBe('Fixed. The length marker is patched after every chunk, so playback no longer stops at two seconds. Lint flagged one let that I changed to const; the three new tests pass.')

    // Reopen and Escape returns focus to the control.
    await control.press('Shift+F10')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(control).toBeFocused()
  } finally { await app.close() }
})

test('the control fits the minimum window without sideways scroll', async () => {
  const { app, page } = await launch({ width: 820, height: 560 })
  try {
    const log = transcript(page)
    const control = log.locator('.thread-message').last().getByRole('button', { name: 'Copy reply as Markdown' })
    await control.focus()
    await expect(control).toHaveCSS('opacity', '1')
    expect(await log.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: resolve(shots, 'reply-focus-820-dark.png') })
  } finally { await app.close() }
})
