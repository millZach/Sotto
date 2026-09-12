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
    await expect(picker.locator('option')).toHaveText(['Codex', 'Claude Code', 'Grok Build'])
    for (const [provider, label] of [['claude', 'Claude Code'], ['grok', 'Grok Build'], ['codex', 'Codex']] as const) {
      await picker.selectOption(provider)
      await expect(picker).toHaveValue(provider)
      await expect(page.getByRole('textbox', { name: /address|access token/i })).toHaveCount(0)
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
    for (const width of [760, 420]) {
      await launched.app.evaluate(({ BrowserWindow }, windowWidth) => {
        const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
        window.setMinimumSize(320, 400); window.setSize(windowWidth, 740)
      }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      await expect(picker).toBeVisible()
      await page.screenshot({ animations: 'disabled', path: `artifacts/native-providers/grok-${width}.png` })
      expect(await page.getByRole('dialog', { name: 'Agent configuration', exact: true }).evaluate(element => {
        const bounds = element.getBoundingClientRect(); return bounds.left >= -1 && bounds.right <= innerWidth + 1
      })).toBe(true)
    }
    await page.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect Grok Build', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
