import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

// The first transcription is turned away, the way an Azure rate-limit burst does, and the next is accepted.
const evidenceRoot = resolve(process.cwd(), 'test-results/dictation-retry')

async function widgetOf(launched: LaunchedSotto): Promise<Page> {
  await expect.poll(() => launched.app.windows().some((candidate) => candidate.url().endsWith('/widget.html'))).toBe(true)
  const widget = launched.app.windows().find((candidate) => candidate.url().endsWith('/widget.html'))!
  await widget.waitForLoadState('domcontentloaded')
  return widget
}

async function withTurnedAwayDictation(
  run: (launched: LaunchedSotto, widget: Page) => Promise<void>,
  settings: Partial<AppSettings> = {},
): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-dictation-retry-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings }), 'utf8')
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('transcription-turned-away-twice', profile)
    const widget = await widgetOf(launched)
    await openPage(launched.page, 'Dictate')
    await launched.page.getByRole('button', { name: 'Start dictation' }).click()
    await launched.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await run(launched, widget)
  } finally {
    if (launched !== undefined) await closeSotto(launched)
    await removeOwnedE2EProfile(profile)
  }
}

test('keeps a turned-away dictation and delivers it when the widget pill is pressed', async () => {
  await mkdir(evidenceRoot, { recursive: true })
  await withTurnedAwayDictation(async ({ page }, widget) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Dictation needs attention.' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Your recording is kept until you try again or discard it.', { exact: false })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(widget.locator('.widget-copy', { hasText: 'Click to try again' })).toBeVisible()
    await page.screenshot({ path: resolve(evidenceRoot, 'dictate-kept.png') })
    await widget.screenshot({ path: resolve(evidenceRoot, 'widget-kept.png'), animations: 'disabled' })

    // The first Try again is turned away too, and the pill says so, whole.
    await widget.locator('.widget-capsule').click({ position: { x: 60, y: 20 } })
    const again = widget.locator('.widget-copy', { hasText: 'Still busy · retry' })
    await expect(again).toBeVisible({ timeout: 15_000 })
    expect(await again.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(page.getByText('Try again did not get through.', { exact: false })).toBeVisible()
    await widget.screenshot({ path: resolve(evidenceRoot, 'widget-kept-again.png'), animations: 'disabled' })

    await widget.locator('.widget-capsule').click({ position: { x: 60, y: 20 } })
    await expect(widget.locator('.widget-shell[data-status="success"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { level: 1, name: /^(Pasted|Copied)\.$/ })).toBeVisible()
    await expect(page.getByTestId('dictate-last')).toContainText(E2E_TRANSCRIPT)
    await page.screenshot({ path: resolve(evidenceRoot, 'dictate-recovered.png') })
  })
})

test('lets go of a turned-away dictation when Discard recording is pressed', async () => {
  await mkdir(evidenceRoot, { recursive: true })
  await withTurnedAwayDictation(async ({ app, page }, widget) => {
    await expect(page.getByRole('button', { name: 'Discard recording' })).toBeVisible({ timeout: 15_000 })

    // Both buttons fit beside each other at the smallest window, here in the light appearance.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().endsWith('/widget.html'))?.setSize(820, 560)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(820)
    const actions = page.locator('.dictate__actions')
    expect(await actions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const [tryAgain, discard] = await Promise.all([
      page.getByRole('button', { name: 'Try again' }).boundingBox(),
      page.getByRole('button', { name: 'Discard recording' }).boundingBox(),
    ])
    // One row: the two buttons share a vertical centre, though the primary is taller.
    expect(Math.abs((tryAgain!.y + tryAgain!.height / 2) - (discard!.y + discard!.height / 2))).toBeLessThan(1)
    await page.screenshot({ path: resolve(evidenceRoot, 'dictate-kept-minimum-light.png') })

    await page.getByRole('button', { name: 'Discard recording' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
    await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('dictate-last')).toHaveCount(0)
  }, { appearance: 'light' })
})

test('lets go of a turned-away dictation when Escape is pressed in Sotto’s window', async () => {
  await withTurnedAwayDictation(async ({ page }, widget) => {
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 })
    // An Escape in the first half second is taken as meant for the work before
    // the error, so the press is repeated until one counts.
    await expect(async () => {
      await page.keyboard.press('Escape')
      await expect(page.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible({ timeout: 250 })
    }).toPass({ timeout: 10_000 })
    await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
  })
})
