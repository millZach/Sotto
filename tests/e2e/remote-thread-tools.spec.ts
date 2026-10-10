import { fillPrompt, promptField } from './support/prompt'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const SHOTS = evidenceDirectory('artifacts/remote-thread-tools')

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
    window.setContentSize(size.width, size.height)
  }, { width, height })
}

/**
 * Files, Changes and Agents for a thread on a paired host, in the built app, over the scripted ssh and a real headless
 * host (ADR-0025, October 5 amendment). The project is a Git repository on "forge" with one file changed and one new,
 * the way an agent leaves a working copy. The desktop reads all three surfaces from the host, offers no Show in
 * folder, and keeps the host-machine sentence for the tools that still run only there.
 */
test('a thread on a paired host shows its files, changes and agents in Tools', async () => {
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-remote-tools-' })).directory
  const root = join(profile, 'ssh-root')
  const folder = join(root, '~', 'code', 'Space Race')
  await mkdir(join(folder, 'moondust'), { recursive: true })
  await writeFile(join(folder, 'README.md'), '# Moondust\n\nA pencil-notebook short about the Space Race.\n')
  await writeFile(join(folder, 'moondust', 'score.mjs'), "export const theme = ['D5', 'A5', 'F#5']\n")
  await initializeGitRepository(folder, { branch: 'master', files: {}, message: 'Start the score', identity: { name: 'Sotto e2e', email: 'e2e@example.invalid' } })
  await writeFile(join(folder, 'moondust', 'score.mjs'), "export const theme = ['D5', 'A5', 'F#5', 'B5', 'A5']\nexport const coda = 204\n")
  await writeFile(join(folder, 'moondust', 'storyboard.md'), '1. Contact\n2. Earthrise\n')
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on', appearance: 'dark' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page, app } = launched
    page.on('pageerror', error => errors.push(error.message))
    await resize(app, 1280, 800)
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')
    const hosts = await page.evaluate(async () => {
      const connections = (await window.sotto!.agents!.get()).connections ?? []
      return { local: connections.find(item => item.kind === 'local')!.hostId, remote: connections.find(item => item.kind === 'remote')!.hostId }
    })
    await page.evaluate(async hostId => { await window.sotto!.hosts!.command({ type: 'select', hostId }) }, hosts.remote)
    const refusal = await page.evaluate(async path => (await window.sotto!.agents!.command({ type: 'create-project', provider: 'claude', title: 'Space Race', path, useExisting: true }))?.error ?? null, folder)
    expect(refusal).toBeNull()
    await page.evaluate(async hostId => { await window.sotto!.hosts!.command({ type: 'select', hostId }) }, hosts.local)
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await page.getByRole('button', { name: 'New thread in Space Race' }).click()
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.title ?? null
    }), { timeout: 15_000 }).toBe('New thread')

    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const footer = panel.locator('.tools-panel__foot')

    // Files: the host's folder, read on the host. A file opens in the preview; nothing offers to show it in a folder here.
    await panel.getByRole('tab', { name: 'Files', exact: true }).click()
    const tree = panel.getByRole('tree')
    await expect(tree.getByRole('treeitem', { name: 'moondust' })).toBeVisible({ timeout: 20_000 })
    await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible()
    await expect(panel.getByText('is on the host machine')).toHaveCount(0)
    await tree.getByRole('treeitem', { name: 'moondust' }).click()
    await tree.getByRole('treeitem', { name: 'score.mjs' }).click()
    await expect(panel.locator('.files-preview__text')).toContainText('export const coda = 204')
    await expect(panel.getByRole('button', { name: /^Show in / })).toHaveCount(0)
    await expect(footer).toContainText('on forge')
    await page.screenshot({ path: join(SHOTS, 'files-1280x800-dark.png'), animations: 'disabled' })

    // Copy path copies the host's own path for the working folder (to the scripted clipboard of an e2e run).
    await panel.getByRole('button', { name: 'Copy working folder path' }).click()
    await expect(panel.getByRole('status').filter({ hasText: 'Path copied' })).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.sottoE2E!.snapshot()).clipboardText)).toMatch(/[\\/]code[\\/]Space Race$/)

    // Changes: the working tree against HEAD on the host, the changed file and the new one, and only the two scopes it can read.
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    await expect(panel.getByText('moondust/score.mjs').first()).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByText('moondust/storyboard.md').first()).toBeVisible()
    await panel.getByRole('button', { name: 'Expand all files' }).click()
    await expect(panel.getByText('export const coda = 204').first()).toBeVisible()
    await expect(panel.getByRole('combobox', { name: 'Diff scope' }).locator('option')).toHaveText(['Working tree', 'Branch changes'])
    await page.screenshot({ path: join(SHOTS, 'changes-1280x800-dark.png'), animations: 'disabled' })

    // A change made on the host appears on its own while Changes is open: the window asks the host for its change list
    // on a timer, as it polls a working copy on this computer.
    await writeFile(join(folder, 'README.md'), '# Moondust\n\nA pencil-notebook short about Apollo 11.\n')
    await expect(panel.getByText('README.md', { exact: true }).first()).toBeVisible({ timeout: 20_000 })

    // A file mention in the thread's composer offers the host's files too.
    const prompt = promptField(page).first()
    await fillPrompt(prompt, 'Read @READ')
    await expect(page.locator('section.thread-pane').first().getByRole('listbox', { name: 'Files' }).getByRole('option')).toContainText('README.md')
    await fillPrompt(prompt, '')

    // Agents: the host's roster for this thread, which has spawned none.
    await panel.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(panel.getByText('No agents spawned in this thread yet.')).toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: join(SHOTS, 'agents-1280x800-dark.png'), animations: 'disabled' })

    // The terminal still runs only on the host, and says so.
    await panel.getByRole('tab', { name: 'Terminal', exact: true }).click()
    await expect(panel.getByText('Terminal is on the host machine.')).toBeVisible()

    // At the minimum window, in light, Changes and its footer fit.
    await resize(app, 820, 560)
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await panel.getByRole('tab', { name: 'Changes', exact: true }).click()
    await expect(panel.getByText('moondust/score.mjs').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'changes-820x560-light.png'), animations: 'disabled' })
    expect(errors).toEqual([])
    await writeFile(join(SHOTS, 'verification.json'), JSON.stringify({ filesListedFromHost: true, previewFromHost: true, noShowInFolder: true, footerSaysOnForge: true, copyPathIsHostPath: true, changesFromHost: true, twoScopesOnly: true, changeAppearsOnItsOwn: true, fileMentionFromHost: true, agentsFromHost: true, terminalStillOnHost: true, errors }, null, 2))
  } catch (error) {
    await launched?.page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
    throw error
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
