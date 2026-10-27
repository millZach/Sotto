/**
 * Clearing settled threads (ADR-0140) in the built app with the `clear-threads` Owl feature on: Settings → Threads,
 * Clearing threads, lists what goes and what is kept and clears it; Delete thread… in a settled thread's pane menu asks
 * first and deletes it. The real controller, workspace, store and IPC run; only the provider is the E2E fixture. A stable
 * build shows neither.
 *
 *   npm run build && npx playwright test tests/e2e/clear-threads.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/clear-threads/ for the verification note.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { captureWindow, closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

const shots = evidenceDirectory('artifacts/clear-threads')
const LOOKS = [[1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark'], [820, 560, 'light']] as const

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const directory = (await ownedE2EProfile({ prefix: 'sotto-e2e-clear-threads-' })).directory
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark' }))
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `clear-threads=${enabled ? 1 : 0}`
  try {
    const launched = await launchSotto('phase3-workspace', directory)
    return { ...launched, ownsUserData: true }
  } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']
    else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}

/** Connects the fixture provider and settles threads at rest and at work, so both lists have something in them. */
async function settleSome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const agents = window.sotto!.agents!
    await agents.command({ type: 'configure', patch: { enabled: true } })
    await agents.command({ type: 'connect' })
    for (const threadId of ['grok-previews', 'release-notes', 'benchmark', 'notes-cleanup', 'thread-routing', 'footer-links', 'visual-gate']) {
      await agents.command({ type: 'settle-thread', threadId })
    }
  })
}

/** The window's content at this size, give or take the pixel or two display scaling rounds the minimum size to. */
async function resize(sotto: LaunchedSotto, width: number, height: number): Promise<void> {
  await sotto.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(async () => {
    const shown = await sotto.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    return Math.max(Math.abs(shown.width - width), Math.abs(shown.height - height))
  }).toBeLessThanOrEqual(2)
}

async function shoot(sotto: LaunchedSotto, name: string, before?: () => Promise<void>): Promise<void> {
  for (const [width, height, appearance] of LOOKS) {
    await sotto.page.evaluate(async look => { await window.sotto!.updateSettings({ appearance: look }) }, appearance)
    await resize(sotto, width, height)
    await before?.()
    await sotto.page.waitForTimeout(150)
    await captureWindow(sotto.app, join(shots, `${name}-${width}x${height}-${appearance}.png`))
  }
}

/** Nothing in an open dialog runs past the window, at any size it was shown at. */
async function expectDialogInside(page: Page): Promise<void> {
  const box = await page.getByRole('dialog').boundingBox()
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
}

test('an Owl build clears settled threads from Settings and deletes one from its pane menu', async () => {
  test.setTimeout(240_000)
  await mkdir(shots, { recursive: true })
  const sotto = await launch(true)
  try {
    const { page } = sotto
    await settleSome(page)

    // Settings → Threads, Clearing threads.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const threads = page.locator('#settings-agents')
    const after = threads.getByRole('combobox', { name: 'Clear settled threads after' })
    await expect(after).toHaveValue('30')
    const age = threads.getByRole('combobox', { name: 'Settled threads on this computer quiet longer than' })
    await age.selectOption('0')
    await shoot(sotto, 'settings-clearing-threads', async () => { await threads.getByRole('group', { name: 'Clear now' }).evaluate(row => row.scrollIntoView({ block: 'end' })) })
    await after.selectOption('90')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).clearSettledThreadsAfterDays)).toBe(90)
    await after.selectOption('never')

    // Clear settled threads: the threads that go, the ones kept and why.
    await threads.getByRole('button', { name: 'Clear now…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Clear settled threads' })
    await expect(dialog.getByRole('radio', { name: 'Any age' })).toHaveAttribute('aria-checked', 'true')
    const go = dialog.getByRole('list', { name: 'Threads that go' })
    await expect(go).toBeVisible()
    await expect(go).toContainText('Grok voice previews')
    await expect(dialog.getByRole('list', { name: 'Threads kept' })).toContainText(/still working|waiting on you/u)
    await shoot(sotto, 'clear-settled-threads', () => expectDialogInside(page))
    await dialog.getByRole('radio', { name: '7 days' }).click()
    await expect(dialog).toContainText('No settled thread on this computer has been quiet that long.')
    await expect(dialog.getByRole('button', { name: 'Clear threads' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Delete thread… on one settled thread.
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: /^Settled/ }).click()
    await sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Grok voice previews', exact: true }).click({ position: { x: 16, y: 12 } })
    const pane = page.locator('section.thread-pane').filter({ has: page.getByRole('heading', { level: 2, name: 'Grok voice previews' }) })
    await pane.getByRole('button', { name: 'More actions' }).click()
    const menu = pane.getByRole('menu', { name: 'More actions' })
    await expect(menu.getByRole('menuitem').last()).toHaveText('Delete thread…')
    await menu.getByRole('menuitem', { name: 'Delete thread…' }).click()
    const ask = page.getByRole('dialog', { name: 'Delete “Grok voice previews”?' })
    await expect(ask).toContainText('Its messages and activity leave Sotto and can’t be brought back.')
    await shoot(sotto, 'delete-thread', () => expectDialogInside(page))
    await ask.getByRole('button', { name: 'Delete' }).click()
    await expect(ask).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 2, name: 'Grok voice previews' })).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: 'Grok voice previews', exact: true })).toHaveCount(0)
    await expect(page.getByText('Deleted “Grok voice previews”.')).toBeVisible()
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
    await resize(sotto, 1280, 800)
    await captureWindow(sotto.app, join(shots, 'deleted-1280x800-dark.png'))

    // A settled thread still at work is kept, says why, and offers only Close.
    await sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Footer links', exact: true }).click({ position: { x: 16, y: 12 } })
    const working = page.locator('section.thread-pane').filter({ has: page.getByRole('heading', { level: 2, name: 'Footer links' }) })
    await working.getByRole('button', { name: 'More actions' }).click()
    await working.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Delete thread…' }).click()
    const kept = page.getByRole('dialog', { name: 'Delete “Footer links”?' })
    await expect(kept).toContainText('This thread can’t be deleted: still working. Nothing was deleted.')
    await expect(kept.getByRole('button')).toHaveText(['Close'])
    await captureWindow(sotto.app, join(shots, 'delete-thread-kept-1280x800-dark.png'))
    await page.keyboard.press('Escape')
    await expect(kept).toHaveCount(0)

    // Clear now clears what it listed, and says how many.
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await age.selectOption('0')
    await threads.getByRole('button', { name: 'Clear now…' }).click()
    const clear = dialog.getByRole('button', { name: /^Clear \d+ threads?$/u })
    await expect(clear).toBeEnabled()
    const listed = Number((await clear.textContent())!.match(/\d+/u)![0])
    await clear.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.settings-notice')).toHaveText(`Cleared ${listed} ${listed === 1 ? 'thread' : 'threads'}.`)
    await captureWindow(sotto.app, join(shots, 'cleared-1280x800-dark.png'))
  } finally { await closeSotto(sotto) }
})

test('a stable build shows neither the Settings group nor Delete thread…', async () => {
  test.setTimeout(90_000)
  const sotto = await launch(false)
  try {
    const { page } = sotto
    await settleSome(page)
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(page.locator('#settings-agents')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Clearing threads' })).toHaveCount(0)
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: /^Settled/ }).click()
    await sidebar.getByRole('region', { name: 'Settled' }).getByRole('button', { name: 'Grok voice previews', exact: true }).click({ position: { x: 16, y: 12 } })
    const pane = page.locator('section.thread-pane').filter({ has: page.getByRole('heading', { level: 2, name: 'Grok voice previews' }) })
    await pane.getByRole('button', { name: 'More actions' }).click()
    await expect(pane.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Restore' })).toBeVisible()
    await expect(pane.getByRole('menuitem', { name: 'Delete thread…' })).toHaveCount(0)
  } finally { await closeSotto(sotto) }
})
