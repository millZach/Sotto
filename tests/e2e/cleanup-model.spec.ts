/**
 * Settings → Cleanup's model and mode (ADR-0122), in the built app with the `cleanup-model` Owl feature on: the search
 * box lists the models, a pick and a mode are saved and survive a reload, and with the feature off neither shows. The
 * renderer's E2E bridge supplies a fixed model list; main makes no network request.
 *
 *   npm run build && npx playwright test tests/e2e/cleanup-model.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/cleanup-model/ for the verification note.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { captureWindow, closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const shots = evidenceDirectory('artifacts/cleanup-model')

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `cleanup-model=${enabled ? 1 : 0}`
  try {
    return await launchSotto('success')
  } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']
    else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}

async function openCleanup(page: Page): Promise<Locator> {
  await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true, llmFormatting: true }))
  await page.reload()
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cleanup', exact: true }).click()
  return page.locator('#settings-formatting')
}

test('an Owl build chooses the cleanup model and mode in Settings → Cleanup', async () => {
  test.setTimeout(120_000)
  await mkdir(shots, { recursive: true })
  const sotto = await launch(true)
  try {
    const { page } = sotto
    const cleanup = await openCleanup(page)
    const box = cleanup.getByRole('combobox', { name: 'Cleanup model' })
    await expect(box).toHaveValue('Default')
    await expect(cleanup.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true')

    await box.click()
    await expect(cleanup.getByRole('option')).toHaveCount(4)
    for (const [width, height, theme] of [[1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark']] as const) {
      await page.evaluate(async (appearance) => { await window.sotto!.updateSettings({ appearance }) }, theme)
      await resizeContentWindow(sotto, width, height)
      await box.press('Escape')
      await box.scrollIntoViewIfNeeded()
      await box.click()
      await expect(cleanup.getByRole('listbox')).toBeVisible()
      await captureWindow(sotto.app, join(shots, `cleanup-model-${width}x${height}-${theme}.png`))
    }
    await box.fill('gemini')
    await expect(cleanup.getByRole('option')).toHaveCount(1)
    await box.press('Enter')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).llmModel)).toBe('google/gemini-3.1-flash-lite')
    await expect(box).toHaveValue('Google: Gemini 3.1 Flash Lite')

    await cleanup.getByRole('radio', { name: 'Floor' }).click()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).llmMode)).toBe('floor')

    await box.click()
    await box.press('Escape')
    await expect(cleanup.getByRole('listbox')).toHaveCount(0)
    await expect(page.locator('#settings-formatting')).toBeVisible()
  } finally { await closeSotto(sotto) }
})

test('a stable build shows neither control', async () => {
  test.setTimeout(60_000)
  const sotto = await launch(false)
  try {
    const cleanup = await openCleanup(sotto.page)
    await expect(cleanup.getByLabel('OpenRouter API key')).toBeVisible()
    await expect(cleanup.getByRole('combobox', { name: 'Cleanup model' })).toHaveCount(0)
    await expect(cleanup.getByRole('radiogroup', { name: 'Mode' })).toHaveCount(0)
  } finally { await closeSotto(sotto) }
})
