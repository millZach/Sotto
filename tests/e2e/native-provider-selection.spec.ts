import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('provider configuration and coordinator choices have separate settings', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('link', { name: 'Providers', exact: true }).click()
    const providers = page.getByRole('navigation', { name: 'Thread providers', exact: true })
    const panel = page.getByRole('region', { name: 'Provider configuration', exact: true })
    for (const label of ['Codex', 'Claude Code', 'Grok Build']) {
      await providers.getByRole('button', { name: label, exact: true }).click()
      await expect(panel.getByRole('heading', { name: label, exact: true })).toBeVisible()
      await expect(providers.getByRole('switch', { name: `Enable ${label}`, exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: `Connect ${label}`, exact: true })).toBeVisible()
      await panel.getByRole('tab', { name: 'Configuration', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await expect(panel.getByRole('tab', { name: 'Models', exact: true })).toBeFocused()
      await expect(panel.getByRole('tabpanel')).toContainText(`Connect ${label} to load its models.`)
      await page.keyboard.press('ArrowLeft')
      await expect(panel.getByRole('tab', { name: 'Configuration', exact: true })).toBeFocused()
    }
    await expect(page.getByRole('combobox', { name: 'Reasoning account', exact: true })).toHaveCount(0)
    const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration)
    await page.getByRole('link', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Configure agents', exact: true }).click()
    const coordinator = page.getByRole('dialog', { name: 'Agent configuration', exact: true })
    await expect(coordinator.getByRole('heading', { name: 'Sotto coordinator', exact: true })).toBeVisible()
    await expect(coordinator.getByRole('combobox', { name: 'Thread provider', exact: true })).toHaveCount(0)
    await coordinator.getByRole('combobox', { name: 'Reasoning account', exact: true }).selectOption('claude')
    await expect.poll(async () => (await page.evaluate(async () => window.sotto!.agents!.get())).configuration.reasoning).toBe('claude')
    const after = await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration)
    expect(after.provider).toBe(before.provider)
    expect(after.enabledProviders).toEqual(before.enabledProviders)
    await coordinator.getByRole('button', { name: 'Close Agent configuration', exact: true }).click()
    await page.getByRole('link', { name: 'Providers', exact: true }).click()
    await expect(panel.getByRole('heading', { name: 'Grok Build', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
