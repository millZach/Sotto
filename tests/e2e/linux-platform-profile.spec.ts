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
    await expect(page.locator('.app-controls')).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-e2e-storage-check')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    await expect(page.locator('.app-controls, .threads-view__winctl')).toHaveCount(0)
    expect(await page.locator('.threads-view').evaluate(element => getComputedStyle(element).getPropertyValue('--threads-winctl-inset').trim())).toBe('0px')
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Launch when you sign in' })).toBeDisabled()
    await expect(page.getByText('Starting at sign-in comes with the installed package.')).toBeVisible()
    await expect(page.getByText('Launch at sign-in could not be updated.')).toHaveCount(0)
    await openPage(page, 'Help')
    await expect(page.getByText(/Sotto .*Linux\. No account/)).toBeVisible()
    await expect(page.getByText(/Compositor bindings live in Hyprland\. Omarchy defaults: hold F9 to talk/)).toBeVisible()
    await expect(page.getByText(/Hold F9 to talk, or press Super\+Ctrl\+X to start and stop/)).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.checkForUpdates())).toMatchObject({ phase: { phase: 'unsupported' } })
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false, autoPaste: true }))
    await openPage(page, 'Dictate')
    await expect(page.locator('.app-room__top')).toBeEmpty()
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Copied.', exact: true })).toBeVisible()
    await expect(page.getByText(/With Sotto’s compositor bindings: hold F9 to talk/)).toBeVisible()
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 0 })
  } finally { await closeSotto(launched) }
})
