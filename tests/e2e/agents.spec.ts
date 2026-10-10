import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('keeps new-thread defaults and projects available while dormant reasoning controls stay hidden', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Agents', exact: true }).click()
    const settings = page.locator('#settings-agents')
    await expect(settings.getByRole('combobox', { name: 'Thread model', exact: true })).toBeVisible()
    await expect(settings.getByLabel('Default projects directory')).toBeVisible()
    await expect(settings.getByLabel('Reasoning account', { exact: true })).toHaveCount(0)
    await expect(settings.getByLabel('Reasoning API key', { exact: true })).toHaveCount(0)
    await expect(settings.getByLabel('Speech voice', { exact: true })).toHaveCount(0)
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 })
    })
    await settings.getByLabel('Default projects directory').fill('D:\\Builder projects')
    await settings.getByLabel('Default projects directory').press('Tab')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.projectsDirectory)).toBe('D:\\Builder projects')
    expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  } finally { await closeSotto(launched) }
})
