import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/host-folder-browser-run')

/**
 * Add project with this computer the only host: the computer step is skipped and the folder browser opens in the home
 * folder, which here is a throwaway one so the captures show fixture folders rather than the machine's own.
 */
test('adds a project from this computer\'s folders, by mouse and by keyboard', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sotto-folder-browser-')))
  for (const folder of ['code/sotto/.git', 'code/forge-ml', 'Documents', 'models', '.config']) await mkdir(join(home, folder), { recursive: true })
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = home; process.env.HOME = home
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    const addProject = page.getByRole('button', { name: 'Add project', exact: true })
    await addProject.click()
    const dialog = page.getByRole('dialog', { name: /Where should this project live\?/ })
    await expect(dialog).toBeVisible()
    const list = dialog.locator('.folder-browser__list')
    await expect(list.getByRole('button', { name: 'code' })).toBeVisible()
    // Folders only, and no dot folder.
    await expect(list.getByRole('button')).toHaveText(['code', 'Documents', 'models'])
    await expect(dialog.getByRole('navigation').getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'location')
    await expect(dialog.getByRole('button', { name: 'Browse with File Explorer' })).toBeVisible()
    await expect(dialog.getByRole('searchbox')).toBeFocused()

    await dialog.getByRole('searchbox').press('Enter')
    await expect(list.getByRole('button', { name: /sotto/ })).toContainText('Git')
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeInViewport()
        await expect(dialog.getByRole('button', { name: 'New folder' })).toBeInViewport()
        await page.screenshot({ animations: 'disabled', path: `${SHOTS}/code-${width}x${height}-${appearance}.png` })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // Backspace in the empty search goes up a folder; Escape closes and gives focus back to Add project.
    await dialog.getByRole('searchbox').press('Backspace')
    await expect(dialog.getByRole('navigation').getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'location')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(addProject).toBeFocused()

    // A new folder is only a name until it is used; using it adds the project and makes the folder.
    await addProject.click()
    await dialog.getByRole('button', { name: 'code' }).click()
    await expect(list.getByRole('button', { name: /forge-ml/ })).toBeVisible()
    await dialog.getByRole('button', { name: 'New folder' }).click()
    await dialog.getByRole('textbox', { name: 'New folder name' }).fill('voice-lab')
    await dialog.getByRole('textbox', { name: 'New folder name' }).press('Enter')
    await expect(dialog.getByText(/This folder is new/)).toBeVisible()
    await page.screenshot({ animations: 'disabled', path: `${SHOTS}/new-folder-1280x800-dark.png` })
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await expect.poll(() => dialog.getByRole('alert').allTextContents()).toEqual([])
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.projects.map(project => project.title))).toContain('voice-lab')
    await expect.poll(async () => page.evaluate(async path => { try { return (await window.sotto!.agents!.hostFolders!({ hostId: (await window.sotto!.agents!.get()).hostId!, path })).status } catch { return 'error' } }, join(home, 'code', 'voice-lab'))).toBe('listed')
  } finally {
    await closeSotto(launched)
    process.env.USERPROFILE = saved.USERPROFILE; process.env.HOME = saved.HOME
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
    if (saved.HOME === undefined) delete process.env.HOME
    await rm(home, { recursive: true, force: true })
  }
})
