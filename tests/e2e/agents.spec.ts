import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

/** `docs/verification/2026-11-01-projects-folder-picker.md` cites these; publish them with `SOTTO_E2E_EVIDENCE=publish`. */
const evidence = evidenceDirectory('artifacts/projects-folder-picker')

test('keeps new-thread defaults and projects available while dormant reasoning controls stay hidden', async () => {
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const settings = page.locator('#settings-agents')
    await expect(settings.getByRole('combobox', { name: 'Thread model', exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: /^(Choose|Change) the default projects directory on this computer$/ })).toBeVisible()
    await expect(settings.getByLabel('Reasoning account', { exact: true })).toHaveCount(0)
    await expect(settings.getByLabel('Reasoning API key', { exact: true })).toHaveCount(0)
    await expect(settings.getByLabel('Speech voice', { exact: true })).toHaveCount(0)
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ ...main.getBounds(), width: 820, height: 560 })
    })
    // The folder is chosen in the folder browser, which opens at the saved one: up one, then Use this folder.
    const builder = join(launched.userData, 'Builder projects')
    await mkdir(join(builder, 'inner'), { recursive: true })
    await page.evaluate(async path => { await window.sotto!.agents!.command({ type: 'configure', patch: { projectsDirectory: path } }) }, join(builder, 'inner'))
    await settings.getByRole('button', { name: 'Change the default projects directory on this computer', exact: true }).click()
    const browser = page.getByRole('dialog', { name: /^Default projects directory on this computer/ })
    await expect(browser.getByRole('button', { name: 'inner', exact: true })).toHaveAttribute('aria-current', 'location')
    await browser.getByRole('button', { name: 'Builder projects', exact: true }).click()
    await expect(browser.getByRole('button', { name: 'Builder projects', exact: true })).toHaveAttribute('aria-current', 'location')
    await page.screenshot({ path: join(evidence, 'browser-820-dark.png'), animations: 'disabled' })
    await browser.getByRole('button', { name: 'Use this folder', exact: true }).click()
    await expect(browser).toBeHidden()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.projectsDirectory)).toBe(builder)
    await expect(settings.getByText(builder, { exact: true })).toBeVisible()
    expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await settings.getByText(builder, { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, 'chosen-820-dark.png'), animations: 'disabled' })
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await launched.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      main.setBounds({ ...main.getBounds(), width: 1280, height: 800 })
    })
    await settings.getByText(builder, { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, 'chosen-1280-light.png'), animations: 'disabled' })
  } finally { await closeSotto(launched) }
})
