import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { bareEntityId, closeSotto, launchSotto, openPage, openThreads } from './support/sottoLaunch'

test('project defaults remain editable in Application and terminal creation keeps its layout', async () => {
  test.setTimeout(120_000)
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
    const projectId = bareEntityId(await project.inputValue())!
    const choice = page.getByRole('combobox', { name: 'New threads in this project work in' })
    await choice.selectOption('independent')
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.getSettings()).projectThreadWorkingCopyDefaults[id], projectId)).toBe('independent')
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'New thread', exact: true }).click()
    await page.getByRole('dialog', { name: 'New thread', exact: true }).getByRole('button', { name: /^Sotto test/ }).click()
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.worktree?.mode
    })).toBe('independent')
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await page.getByRole('button', { name: 'Project defaults', exact: true }).click()
    await expect(choice).toHaveValue('independent')
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
    await page.emulateMedia({ reducedMotion: 'reduce' })
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

test('a saved host-keyed local project default is migrated before a new thread opens', async () => {
  let launched = await launchSotto('design-threads-empty')
  try {
    const projectId = await launched.page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      const state = await window.sotto!.agents!.command({ type: 'connect' })
      const id = state.host.projects[0]!.id
      await window.sotto!.updateSettings({ projectThreadWorkingCopyDefaults: { [id]: 'independent' } })
      return id
    })
    expect(projectId).toMatch(/^host:/)
    const profile = launched.userData
    await launched.app.close()
    launched = { ...await launchSotto('design-threads-empty', profile), ownsUserData: true }
    const { page } = launched
    await page.evaluate(async () => window.sotto!.agents!.command({ type: 'connect' }))
    await page.reload()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).projectThreadWorkingCopyDefaults)).toEqual({ [bareEntityId(projectId)!]: 'independent' })
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Application', exact: true }).click()
    await page.getByRole('button', { name: 'Project defaults', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'New threads in this project work in' })).toHaveValue('independent')
    await openThreads(page)
    await page.getByRole('button', { name: 'New thread in workshop', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.worktree?.mode
    })).toBe('independent')
  } finally { await closeSotto(launched) }
})
