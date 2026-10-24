import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('provider configuration and new-thread defaults have separate settings', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Providers', exact: true }).click()
    const providers = page.getByRole('list', { name: 'Thread providers', exact: true })
    for (const [index, label] of ['Codex', 'Claude Code', 'Grok Build'].entries()) {
      const header = providers.getByRole('button', { name: label, exact: true })
      // Codex's row is open to begin with; each next row is reached with Down from the one before and opened with Enter.
      if (index > 0) {
        await providers.getByRole('button', { name: ['Codex', 'Claude Code'][index - 1]!, exact: true }).focus()
        await page.keyboard.press('ArrowDown')
        await expect(header).toBeFocused()
        await page.keyboard.press('Enter')
      }
      await expect(header).toHaveAttribute('aria-expanded', 'true')
      const panel = providers.getByRole('region', { name: `${label} details`, exact: true })
      await expect(providers.getByRole('region')).toHaveCount(1)
      await expect(providers.getByRole('switch', { name: `Enable ${label}`, exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: `Connect ${label}`, exact: true })).toBeVisible()
      await expect(panel).toContainText(`Connect ${label} to load its models.`)
    }
    await expect(providers.getByRole('combobox', { name: 'Reasoning account', exact: true })).toHaveCount(0)
    const before = await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration)
    const nav = page.getByRole('tablist', { name: 'Settings sections' })
    await expect(nav.getByRole('tab')).toHaveText(['Dictation', 'Cleanup', 'Threads', 'Git & worktrees', 'Providers', 'Hosts & phones', 'Cloud iPhone', 'Appearance', 'Application'])
    const sections = page.locator('.settings-form > [role="tabpanel"]')
    await expect(sections.nth(2)).toHaveAttribute('id', 'settings-agents')
    await expect(sections.nth(4)).toHaveAttribute('id', 'settings-providers')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(page.getByRole('tabpanel', { name: 'Threads', exact: true })).toBeVisible()
    await expect(providers).toBeHidden()
    const coordinator = page.locator('#settings-agents')
    await expect(coordinator.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible()
    await expect(coordinator.getByRole('button', { name: 'Configure agents', exact: true })).toHaveCount(0)
    await expect(coordinator.getByRole('combobox', { name: 'Thread provider', exact: true })).toHaveCount(0)
    await expect(coordinator.getByRole('combobox', { name: 'Reasoning account', exact: true })).toHaveCount(0)
    await expect(coordinator.getByRole('combobox', { name: 'Thread model', exact: true })).toBeVisible()
    const after = await page.evaluate(async () => (await window.sotto!.agents!.get()).configuration)
    expect(after.provider).toBe(before.provider)
    expect(after.enabledProviders).toEqual(before.enabledProviders)
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Providers', exact: true }).click()
    await expect(providers.getByRole('region', { name: 'Grok Build details', exact: true })).toBeVisible()
    await expect(coordinator).toBeHidden()
  } finally { await closeSotto(launched) }
})
