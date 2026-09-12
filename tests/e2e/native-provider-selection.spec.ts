import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('selects native thread providers through the existing configuration controls', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    const picker = page.getByRole('combobox', { name: 'Thread provider', exact: true })
    await expect(picker.locator('option')).toHaveText(['T3 Code', 'Codex', 'Claude Code', 'Grok Build'])
    for (const [provider, label] of [['claude', 'Claude Code'], ['grok', 'Grok Build'], ['codex', 'Codex'], ['t3', 'T3 Code']] as const) {
      await picker.selectOption(provider)
      await expect(picker).toHaveValue(provider)
      await expect(page.getByRole('textbox', { name: 'T3 Code address', exact: true })).toHaveCount(provider === 't3' ? 1 : 0)
      if (provider === 'claude' || provider === 'grok') {
        await page.screenshot({ animations: 'disabled', path: `artifacts/native-providers/${provider}-configuration.png` })
      }
      await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
      await expect(page.getByRole('button', { name: `Connect ${label}`, exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    }
    await picker.selectOption('grok')
    await expect(picker).toHaveValue('grok')
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await page.getByRole('button', { name: 'Connect Grok Build', exact: true }).click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(picker).toBeDisabled()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(picker).toBeEnabled()
    await page.reload()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const dismissPreferences = page.getByRole('button', { name: 'Not now', exact: true })
    if (await dismissPreferences.isVisible()) await dismissPreferences.click()
    await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
    await expect(picker).toHaveValue('grok')
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect Grok Build', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
