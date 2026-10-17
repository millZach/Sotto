import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/add-project-opens-thread-run')

/**
 * Add project leaves the project open with something to work in: a new thread from the Threads sidebar, for a new
 * folder and for one that is already a project, and New terminal for the project from the Terminal sidebar. The home
 * folder is a throwaway one, so the folders are fixtures rather than the machine's own.
 */
test('Add project opens a new thread in the project, or New terminal from the Terminal sidebar', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sotto-add-project-')))
  for (const folder of ['code/sotto/.git', 'code/forge-ml']) await mkdir(join(home, folder), { recursive: true })
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = home; process.env.HOME = home
  const launched = await launchSotto()
  const { page } = launched
  const threadsIn = (title: string): Promise<number> => page.evaluate(async name => {
    const state = await window.sotto!.agents!.get()
    const project = state.host.projects.find(item => item.title === name)
    return project ? state.host.threads.filter(thread => thread.projectId === project.id).length : -1
  }, title)
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    const addProject = page.getByRole('button', { name: 'Add project', exact: true })
    const dialog = page.getByRole('dialog', { name: /Where should this project live\?/ })
    const newThread = page.getByRole('heading', { name: 'New thread' })

    // A new folder: the project is made and a new thread opens in it.
    await addProject.click()
    await dialog.getByRole('button', { name: 'code' }).click()
    await expect(dialog.locator('.folder-browser__list').getByRole('button', { name: /forge-ml/ })).toBeVisible()
    await dialog.getByRole('button', { name: 'New folder' }).click()
    await dialog.getByRole('textbox', { name: 'New folder name' }).fill('voice-lab')
    await dialog.getByRole('textbox', { name: 'New folder name' }).press('Enter')
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(newThread).toBeVisible()
    await expect.poll(() => threadsIn('voice-lab')).toBe(1)
    await page.screenshot({ animations: 'disabled', path: `${SHOTS}/new-folder-thread-1280x800-dark.png` })

    // The same folder again is already a project: it opens, and its unused new thread opens rather than a second.
    await addProject.click()
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.locator('.folder-browser__list').getByRole('button', { name: /voice-lab/ }).click()
    await dialog.getByRole('button', { name: 'Open project' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(newThread).toBeVisible()
    await expect.poll(() => threadsIn('voice-lab')).toBe(1)

    // From the Terminal sidebar, an added folder opens New terminal with the project already chosen.
    await page.getByRole('radiogroup', { name: 'Sidebar mode' }).getByRole('radio', { name: 'Terminal' }).click()
    await expect(page.getByRole('complementary', { name: 'Terminal sidebar' })).toBeVisible()
    await addProject.click()
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.locator('.folder-browser__list').getByRole('button', { name: /^sotto/ }).click()
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await expect(dialog).toHaveCount(0)
    const terminal = page.getByRole('dialog', { name: 'New terminal' })
    await expect(terminal).toBeVisible()
    await expect(terminal.getByRole('button', { name: 'Back to projects' })).toBeVisible()
    await expect.poll(() => threadsIn('sotto')).toBe(0)
    await page.screenshot({ animations: 'disabled', path: `${SHOTS}/terminal-new-terminal-1280x800-dark.png` })
    await page.keyboard.press('Escape')
    await expect(terminal).toHaveCount(0)

    // Beside History, with Terminal still the remembered mode, the sidebar there lists threads: the new thread
    // opens on Threads in Threads mode, rather than behind the Terminal workspace.
    await page.getByRole('link', { name: 'History' }).click()
    await addProject.click()
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.locator('.folder-browser__list').getByRole('button', { name: /forge-ml/ }).click()
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('radiogroup', { name: 'Sidebar mode' }).getByRole('radio', { name: 'Threads' })).toHaveAttribute('aria-checked', 'true')
    await expect(newThread).toBeVisible()
    await expect.poll(() => threadsIn('forge-ml')).toBe(1)
    await page.screenshot({ animations: 'disabled', path: `${SHOTS}/from-history-thread-1280x800-dark.png` })
  } finally {
    await closeSotto(launched)
    process.env.USERPROFILE = saved.USERPROFILE; process.env.HOME = saved.HOME
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
    if (saved.HOME === undefined) delete process.env.HOME
    await rm(home, { recursive: true, force: true })
  }
})
