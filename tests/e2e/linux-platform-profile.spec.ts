import { expect, test } from '@playwright/test'
import { E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('Linux saves a key during onboarding and copies dictation without attempting paste', async () => {
  test.skip(process.platform !== 'linux', 'Linux desktop profile')
  const launched = await launchSotto('success')
  const { page } = launched
  try {
    await expect(page.getByRole('heading', { name: 'Dictation, ready when you are' })).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.platform)).toBe('linux')
    expect(await page.evaluate(() => window.sotto!.canFrostWindow)).toBe(false)
    await expect(page.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-e2e-storage-check')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.checkForUpdates())).toMatchObject({ phase: { phase: 'unsupported' } })
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false, autoPaste: true }))
    await openPage(page, 'Dictate')
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Copied.', exact: true })).toBeVisible()
    await expect(page.getByText(/With Sotto’s compositor bindings: hold F9 to talk/)).toBeVisible()
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 0 })
  } finally { await closeSotto(launched) }
})
