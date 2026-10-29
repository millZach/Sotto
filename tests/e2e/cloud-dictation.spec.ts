/**
 * Transcribe with OpenRouter (ADR-0160), in the built app with the `cloud-dictation` Owl feature on: the switch leads
 * Settings → Dictation's Speech model group, turning it on swaps the speech model picker for OpenRouter's ranked list,
 * a pick by click and by the arrow keys is saved and survives a reload, and with the feature off nothing of it shows.
 * The renderer's E2E bridge supplies a saved key and a fixed model list; main sends no audio anywhere.
 *
 *   npm run build && npx playwright test tests/e2e/cloud-dictation.spec.ts
 *
 * With `SOTTO_E2E_EVIDENCE=publish` the screenshots go to artifacts/cloud-dictation/ for the verification note.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { captureWindow, closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const shots = evidenceDirectory('artifacts/cloud-dictation')

async function launch(enabled: boolean): Promise<LaunchedSotto> {
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = `cloud-dictation=${enabled ? 1 : 0}`
  try {
    return await launchSotto('success')
  } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']
    else process.env['SOTTO_OWL_FEATURES'] = previous
  }
}

async function openSpeechModel(page: Page): Promise<Locator> {
  await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
  await page.reload()
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Dictation', exact: true }).click()
  const group = page.locator('#settings-transcription')
  await group.scrollIntoViewIfNeeded()
  return group
}

const saved = (page: Page): Promise<{ readonly on: boolean; readonly model: string | null }> =>
  page.evaluate(async () => {
    const settings = await window.sotto!.getSettings()
    return { on: settings.cloudTranscription, model: settings.cloudSpeechModel }
  })

test('an Owl build turns on Transcribe with OpenRouter and picks a model from the ranked list', async () => {
  test.setTimeout(120_000)
  await mkdir(shots, { recursive: true })
  const sotto = await launch(true)
  try {
    const { page } = sotto
    let group = await openSpeechModel(page)
    const toggle = group.getByRole('switch', { name: /Transcribe with OpenRouter/u })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(group.getByRole('radiogroup')).toHaveCount(0)

    await toggle.click()
    await expect.poll(() => saved(page)).toEqual({ on: true, model: null })
    await expect(group.getByText('Uses the OpenRouter key saved for AI cleanup. Change it in Settings → Cleanup.')).toBeVisible()
    const rows = group.getByRole('radio')
    await expect(rows).toHaveCount(5)
    await expect(rows.first()).toHaveAttribute('aria-checked', 'true')

    for (const [width, height, theme] of [[1280, 800, 'dark'], [1280, 800, 'light'], [820, 560, 'dark']] as const) {
      await page.evaluate(async (appearance) => { await window.sotto!.updateSettings({ appearance }) }, theme)
      await resizeContentWindow(sotto, width, height)
      await group.getByRole('radiogroup').scrollIntoViewIfNeeded()
      await rows.nth(1).hover()
      await expect(rows.nth(1).getByRole('tooltip')).toBeVisible()
      await captureWindow(sotto.app, join(shots, `cloud-dictation-${width}x${height}-${theme}.png`))
    }

    await rows.nth(2).click()
    const third = await rows.nth(2).getAttribute('aria-describedby')
    expect(third).not.toBeNull()
    await expect.poll(async () => (await saved(page)).model).not.toBeNull()
    const picked = (await saved(page)).model
    await rows.nth(2).focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await saved(page)).model).not.toBe(picked)
    await expect(rows.nth(3)).toBeFocused()

    await group.getByRole('button', { name: /Show all \d+ models/u }).click()
    await expect(rows).toHaveCount(7)

    const chosen = (await saved(page)).model
    await page.reload()
    group = await openSpeechModel(page)
    await expect(group.getByRole('switch', { name: /Transcribe with OpenRouter/u })).toHaveAttribute('aria-checked', 'true')
    await expect(group.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1)
    expect((await saved(page)).model).toBe(chosen)
  } finally {
    await closeSotto(sotto)
  }
})

test('stable shows no Transcribe with OpenRouter, and keeps the speech model picker', async () => {
  test.setTimeout(60_000)
  const sotto = await launch(false)
  try {
    const group = await openSpeechModel(sotto.page)
    await expect(group.getByRole('switch', { name: /Transcribe with OpenRouter/u })).toHaveCount(0)
    await expect(group.getByRole('radiogroup')).toHaveCount(0)
  } finally {
    await closeSotto(sotto)
  }
})
