/**
 * The main freeze notice and Record a minute (#1233, ADR-0098), in the built app with the `main-freeze` Owl feature on.
 * Main is made to freeze by busy-waiting in its own process for most of every second, with the watch's window shortened
 * to six seconds and the recording to three (development-only overrides). The pill appears, opens the numbers, records,
 * and the files land in the data folder with only names, Sotto's script places and timings. Not now hides the notice
 * until main recovers and freezes again, Attach to a thread opens a new thread with an unsent draft, and stable shows
 * none of it.
 *
 * Sotto's data folder here sits under a short neutral folder rather than the temporary folder, whose path carries the
 * Windows user name: the draft Attach to a thread writes names the recording by its full path, and it is captured.
 *
 *   npm run build && npx playwright test tests/e2e/main-freeze-notice.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/main-freeze-notice/ for the verification note.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, parse } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const shots = evidenceDirectory('artifacts/main-freeze-notice')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

/** A data folder whose path names no one: under the drive's root on Windows, the temporary folder elsewhere. */
async function neutralDataFolder(): Promise<string> {
  const root = process.platform === 'win32' ? join(parse(tmpdir()).root, 'sotto-e2e') : tmpdir()
  await mkdir(root, { recursive: true })
  const folder = await mkdtemp(join(root, 'main-freeze-'))
  const name = userInfo().username
  if (name.length >= 3) expect(folder.toLowerCase()).not.toContain(name.toLowerCase())
  return folder
}

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const overrides = { SOTTO_OWL_FEATURES: `main-freeze=${enabled ? 1 : 0}`, SOTTO_E2E_MAIN_LOOP_WINDOW_SECONDS: '6', SOTTO_E2E_ACTIVITY_RECORDING_MS: '3000' }
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  const folder = await neutralDataFolder()
  try { return await launchSotto('phase3-workspace', folder) } catch (error) {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw error
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
}

/** Closes Sotto and removes the data folder this spec made for it. */
async function close(launched: LaunchedSotto): Promise<void> {
  await closeSotto(launched)
  await rm(launched.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function ready(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
    // A thread open, so the pane's title row has to make room for the notice.
    const state = await window.sotto!.agents!.get()
    const thread = state.host.threads[0]
    if (thread) await window.sotto!.agents!.command({ type: 'select-thread', threadId: thread.id })
  })
  await page.reload()
  await openThreads(page)
  await page.evaluate(() => document.fonts.ready)
}

/** Main busy-waits `busyMs` of every second until `thaw`; the window still gets the rest of each second. */
async function freeze(launched: LaunchedSotto, busyMs = 800): Promise<void> {
  await inMain(() => launched.app.evaluate((_electron, busy) => {
    const holder = globalThis as unknown as { __sottoFreeze?: ReturnType<typeof setInterval> | undefined }
    clearInterval(holder.__sottoFreeze)
    holder.__sottoFreeze = setInterval(() => { const end = Date.now() + busy; while (Date.now() < end) { /* frozen on purpose */ } }, 1_000)
  }, busyMs))
}

async function thaw(launched: LaunchedSotto): Promise<void> {
  await inMain(() => launched.app.evaluate(() => {
    const holder = globalThis as unknown as { __sottoFreeze?: ReturnType<typeof setInterval> | undefined }
    clearInterval(holder.__sottoFreeze)
    holder.__sottoFreeze = undefined
  }))
}

const pill = (page: Page): Locator => page.locator('.main-freeze__pill')

/**
 * Playwright's evaluate in a main process that is busy-waiting most of every second can lose its context now and then
 * ("Execution context was destroyed"); a fresh attempt finds it again.
 */
async function inMain(evaluate: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try { await evaluate(); return } catch (error) {
      if (attempt >= 5 || !String(error).includes('Execution context was destroyed')) throw error
    }
  }
}

/**
 * As `resizeContentWindow`, with time to spare: a frozen main applies a new size only in its free moments. A size larger
 * than the window's display moves it to the top-left corner of a display it fits on, since the system clamps a window
 * to its display's work area.
 */
async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await inMain(() => launched.app.evaluate(({ BrowserWindow, screen }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    if (window.isMaximized()) window.unmaximize()
    window.setMinimumSize(800, 540)
    const fits = (area: Electron.Rectangle): boolean => area.width >= size.width && area.height >= size.height
    const current = screen.getDisplayMatching(window.getBounds())
    const display = fits(current.workArea) ? current : screen.getAllDisplays().find(item => fits(item.workArea))
    if (display && display !== current) window.setPosition(display.workArea.x, display.workArea.y)
    window.setContentSize(size.width, size.height)
  }, { width, height }))
  await expect.poll(() => launched.page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 30_000 }).toEqual({ width, height })
}

async function shoot(launched: LaunchedSotto, name: string, before?: () => Promise<void>): Promise<void> {
  const { page } = launched
  for (const [width, height] of SIZES) for (const appearance of ['dark', 'light'] as const) {
    await resize(launched, width, height)
    await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
    await before?.()
    // Nothing spills past the window at any size.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    const popover = page.locator('.main-freeze__popover')
    if (await popover.count()) {
      const box = (await popover.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(box.y + box.height).toBeLessThanOrEqual(height)
    }
    await page.mouse.move(2, 400)
    await page.screenshot({ path: join(shots, `${name}-${width}x${height}-${appearance}.png`) })
  }
  await resize(launched, 1280, 800)
  await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
}

test('main says when it is frozen, records a minute of itself on this computer, and hands it to a new thread', async () => {
  test.setTimeout(300_000)
  await mkdir(shots, { recursive: true })
  const launched = await launch(true)
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await ready(page)
    expect(await page.evaluate(() => typeof window.sotto?.mainActivity)).toBe('object')
    await expect(pill(page)).toHaveCount(0)

    await freeze(launched)
    await expect(pill(page)).toHaveText('Main is slow', { timeout: 30_000 })
    await expect(pill(page)).toHaveAccessibleName(/^Main is slow: blocked \d+% of the last minute\. Show details$/)
    // The pill opts out of the drag strip it sits over.
    expect(await pill(page).evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    await shoot(launched, 'pill')

    // The popover: the numbers, the chart, Record a minute and Not now; Escape closes it.
    await pill(page).click()
    const dialog = page.getByRole('dialog', { name: 'Main process' })
    await expect(dialog.getByRole('heading', { name: 'Sotto\'s main process is slow' })).toBeFocused()
    await expect(dialog.getByRole('img', { name: /^Main was blocked \d+% of the last minute/ })).toBeVisible()
    await shoot(launched, 'popover', async () => { if (!(await dialog.isVisible())) await pill(page).click(); await expect(dialog).toBeVisible() })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(pill(page)).toBeFocused()

    // Reduced motion, asked for by the system: the popover arrives without its animation.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await pill(page).click()
    await expect(dialog).toBeVisible()
    expect(await page.locator('.main-freeze__popover').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.mouse.move(2, 400)
    await page.screenshot({ path: join(shots, 'popover-1280x800-dark-reduced-motion.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await pill(page).click()
    expect(await page.locator('.main-freeze__popover').evaluate(element => getComputedStyle(element).animationName)).not.toBe('none')
    await page.keyboard.press('Escape')

    // Tab out of the popover closes it.
    await pill(page).click()
    await expect(dialog.getByRole('heading', { name: 'Sotto\'s main process is slow' })).toBeFocused()
    for (let step = 0; step < 8 && await dialog.count(); step += 1) await page.keyboard.press('Tab')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement?.closest('.main-freeze') === null)).toBe(true)

    // Not now hides the notice while main stays frozen; it comes back after main recovers and freezes again.
    await pill(page).click()
    await dialog.getByRole('button', { name: 'Not now: hide this until main recovers and freezes again' }).click()
    await expect(pill(page)).toHaveCount(0)
    await page.waitForTimeout(2_500)
    await expect(pill(page)).toHaveCount(0)
    await thaw(launched)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.mainActivity!.read()).reading.frozen), { timeout: 30_000 }).toBe(false)
    await freeze(launched)
    await expect(pill(page)).toHaveText('Main is slow', { timeout: 30_000 })

    // Settings > Performance: the live numbers, the record control and the switch.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Performance' }).click()
    const section = page.locator('#settings-performance')
    await expect(section.getByText(/^Main was blocked \d+% of the last minute/)).toBeVisible()
    await expect(section.getByRole('switch', { name: 'Tell me when main freezes' })).toHaveAttribute('aria-checked', 'true')
    await shoot(launched, 'settings')

    // Record a minute (three seconds here), from the notice, while main stays frozen.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await pill(page).click()
    await dialog.getByRole('button', { name: 'Record a minute' }).click()
    await expect(pill(page)).toHaveText(/^Recording, \d+ s$/)
    await expect(dialog.getByRole('progressbar', { name: 'Recording' })).toBeVisible()
    // Sotto's global reduced-motion rule leaves 1 ms at most, which is no easing anyone sees.
    expect(parseFloat(await page.locator('.main-activity__progress > i').first().evaluate(element => getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(dialog.getByRole('heading', { name: 'Activity recording saved' })).toBeVisible({ timeout: 30_000 })
    await expect(pill(page)).toHaveText('Recording saved')
    // A saved recording keeps its pill whether or not main is still frozen.
    await thaw(launched)
    await shoot(launched, 'saved', async () => { if (!(await dialog.isVisible())) await pill(page).click(); await expect(dialog).toBeVisible() })

    // The files, under Sotto's data folder, hold names, Sotto's script places and timings, and nothing else.
    const folder = join(launched.userData, 'performance-recordings')
    const [name] = await readdir(folder)
    expect(name).toMatch(/^sotto-activity-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/)
    const files = (await readdir(join(folder, name!))).sort()
    expect(files).toEqual(['main.cpuprofile', 'summary.json', 'window.cpuprofile'])
    for (const file of ['main.cpuprofile', 'window.cpuprofile']) {
      const profile = JSON.parse(await readFile(join(folder, name!, file), 'utf8')) as { nodes: { callFrame: Record<string, unknown> }[] } & Record<string, unknown>
      expect(Object.keys(profile).sort()).toEqual(['endTime', 'nodes', 'samples', 'startTime', 'timeDeltas'])
      expect(profile.nodes.length).toBeGreaterThan(1)
      for (const node of profile.nodes) {
        expect(Object.keys(node).sort()).toEqual(['callFrame', 'children', 'hitCount', 'id'])
        const url = String(node.callFrame['url'])
        expect(url === '' || url === '(outside Sotto)' || /^(node:|internal\/|electron\/js2c\/|electron:|sotto:\/\/\/)/u.test(url), url).toBe(true)
      }
      const text = JSON.stringify(profile)
      expect(text).not.toContain(launched.userData)
      expect(text).not.toContain(process.cwd())
    }
    const summary = JSON.parse(await readFile(join(folder, name!, 'summary.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(summary).sort()).toEqual(['before', 'durationMs', 'during', 'files', 'format', 'platform', 'sottoVersion', 'startedAt', 'windowRecorded'])
    expect(summary['windowRecorded']).toBe(true)

    // Attach to a thread: a new thread on the Threads page, its composer holding an unsent draft that names the folder.
    await dialog.getByRole('button', { name: 'Attach to a thread' }).click()
    await expect(page.locator('.threads-view')).toBeVisible()
    const composer = page.locator('.thread-prompt :is(.prompt-editor, textarea)').first()
    await expect(composer).toContainText('performance-recordings', { timeout: 30_000 })
    await expect(composer).toContainText('main.cpuprofile, window.cpuprofile, summary.json')
    // The draft names the recording by its full path, and nothing in the window names this computer's user.
    const user = userInfo().username
    if (user.length >= 3) expect((await page.locator('body').innerText()).toLowerCase()).not.toContain(user.toLowerCase())
    await page.mouse.move(2, 400)
    await page.screenshot({ path: join(shots, 'attached-1280x800-dark.png') })
    await expect(pill(page)).toHaveText('Recording saved')
    await pill(page).click()
    await expect(dialog).toContainText('Added to a new thread\'s composer. It is sent when you send.')
    await dialog.getByRole('button', { name: 'Close: the recording stays in its folder' }).click()
    await expect(pill(page)).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await thaw(launched).catch(() => undefined)
    await close(launched)
  }
})

test('stable shows none of it and starts no watch', async () => {
  test.setTimeout(120_000)
  const launched = await launch(false)
  const { page } = launched
  try {
    await ready(page)
    expect(await page.evaluate(() => typeof window.sotto?.mainActivity)).toBe('undefined')
    await freeze(launched)
    await page.waitForTimeout(8_000)
    await expect(pill(page)).toHaveCount(0)
    await thaw(launched)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Git & worktrees', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Performance' })).toHaveCount(0)
  } finally {
    await thaw(launched).catch(() => undefined)
    await close(launched)
  }
})
