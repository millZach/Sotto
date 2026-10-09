import { expect, test } from '@playwright/test'
import { E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { closeSotto, finishFirstRunSetupFrom, launchSotto, openPage, reachFirstRunStep } from './support/sottoLaunch'

test('Linux saves a key during onboarding and copies dictation without attempting paste', async () => {
  test.skip(process.platform !== 'linux', 'Linux desktop profile')
  const launched = await launchSotto('success')
  const { page } = launched
  try {
    await expect(page.getByRole('heading', { name: 'Talk to your computer and your coding agents' })).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.platform)).toBe('linux')
    expect(await page.evaluate(() => window.sotto!.canFrostWindow)).toBe(false)
    await expect(page.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
    await reachFirstRunStep(page, 'key', { microphone: 'skip' })
    await page.getByLabel('OpenRouter API key', { exact: true }).fill('sotto-linux-e2e-storage-check')
    await page.getByRole('heading', { name: 'Connect your OpenRouter key' }).click()
    await expect(page.getByLabel('OpenRouter API key', { exact: true })).toHaveAttribute('placeholder', 'Key saved')
    await finishFirstRunSetupFrom(page, 'key', { microphone: 'skip' })
    await expect(page.getByRole('complementary', { name: 'Thread sidebar', exact: true })).toBeVisible()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Launch when you sign in' })).toBeDisabled()
    await expect(page.getByText('Starting at sign-in comes with the installed package.')).toBeVisible()
    await expect(page.getByText('Launch at sign-in could not be updated.')).toHaveCount(0)
    await openPage(page, 'Help')
    await expect(page.getByText(/Sotto .*Linux\. No account/)).toBeVisible()
    await expect(page.getByText('Wayland does not deliver this shortcut yet. Use the dictation button.')).toBeVisible()
    await expect(page.getByText(/Use the dictation button to begin, then press Stop to finish/)).toBeVisible()
    expect(await page.evaluate(() => window.sotto!.checkForUpdates())).toMatchObject({ phase: { phase: 'unsupported' } })
    await page.evaluate(async () => window.sotto!.updateSettings({ microphoneSkipped: false, autoPaste: true }))
    await openPage(page, 'Dictate')
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Copied.', exact: true })).toBeVisible()
    await expect(page.getByText('Paste with Ctrl+V, or Shift+Insert in a terminal.', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 0 })
  } finally { await closeSotto(launched) }
})
