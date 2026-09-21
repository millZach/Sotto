import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openPage, openThreads } from './support/sottoLaunch'

test('project defaults remain editable in Application and terminal creation keeps its layout', async () => {
  const launched = await launchSotto()
  const { page, app } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await page.getByRole('button', { name: 'Project defaults', exact: true }).click()
    const project = page.getByRole('combobox', { name: 'Project', exact: true })
    const projectId = await project.inputValue()
    const choice = page.getByRole('combobox', { name: 'New threads in this project work in' })
    await choice.selectOption('independent')
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.getSettings()).projectThreadWorkingCopyDefaults[id], projectId)).toBe('independent')
    await mkdir('artifacts/new-thread-setup', { recursive: true })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await app.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
        window.setMinimumSize(800, 540)
        window.setContentSize(size.width!, size.height!)
      }, { width, height })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await choice.scrollIntoViewIfNeeded()
        await expect(choice).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `artifacts/new-thread-setup/project-defaults-${width}-${appearance}.png`, animations: 'disabled' })
      }
    }
    await choice.selectOption('inherit')
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.getSettings()).projectThreadWorkingCopyDefaults[id], projectId)).toBeUndefined()
    await choice.press('Escape')
    await expect(page.getByRole('button', { name: 'Project defaults', exact: true })).toBeFocused()
    await expect(choice).toBeHidden()
    await openThreads(page)
    await page.getByRole('radio', { name: 'Terminal', exact: true }).check()
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New terminal', exact: true })
    await dialog.getByRole('searchbox', { name: 'Search projects' }).press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('textbox', { name: 'Terminal name' })).toBeVisible()
    expect(await dialog.locator('form').evaluate(node => ({ display: getComputedStyle(node).display, overflow: getComputedStyle(node).overflowY }))).toEqual({ display: 'grid', overflow: 'auto' })
    await page.screenshot({ path: 'artifacts/new-thread-setup/terminal-820-light.png', animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
