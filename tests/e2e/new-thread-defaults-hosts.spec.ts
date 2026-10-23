import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * ADR-0074 in the built app, over a scripted ssh that runs the real launch script and a real headless host. With a
 * project on forge selected, Settings → Threads once sent forge its new-thread defaults and forge refused every one.
 * Now they are this computer's: the change saves, forge's own projects folder has its own row, and a thread opened in
 * forge's project starts on the permission chosen here.
 */

const agents = (page: Page) => page.evaluate(() => window.sotto!.agents!.get())
/** `docs/verification/new-thread-defaults-every-host.md` cites four of these; publish them with `SOTTO_E2E_EVIDENCE=publish`. */
const evidence = evidenceDirectory('artifacts/new-thread-defaults-every-host')

test('one set of new-thread defaults applies on every host, and each computer keeps its own projects folder', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-defaults-' })).directory
  const root = join(profile, 'ssh-root')
  const site = join(root, '~', 'code', 'site')
  await mkdir(site, { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })

    // Add forge.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    // This computer's providers are connected, so Add host offers to have an agent set forge up; forge already has the host.
    await form.getByRole('radio', { name: 'Add it' }).check()
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')
    const forge = (await agents(page)).connections!.find(connection => connection.kind === 'remote')!.hostId
    await expect.poll(async () => (await agents(page)).host.clientHosts?.find(host => host.hostId === forge)?.connected, { timeout: 30_000 }).toBe(true)

    // A project on forge, selected, as when the refusal was reported.
    await page.evaluate(async hostId => { await window.sotto!.hosts!.command({ type: 'select', hostId }) }, forge)
    const created = await page.evaluate(async path => window.sotto!.agents!.command({ type: 'create-project', title: 'site', path, useExisting: true }), site)
    expect(created.error).toBeNull()
    expect(created.hostId).toBe(forge)

    await openPage(page, 'Settings')
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const section = page.locator('#settings-agents')
    await expect(section.getByText('New threads start with these on every connected computer. Change them for one thread in its composer.')).toBeVisible()
    await section.getByRole('combobox', { name: 'Default permissions for new threads' }).click()
    await page.getByRole('option', { name: 'Auto', exact: true }).click()
    await expect.poll(async () => (await agents(page)).configuration.newThreadRuntimeMode).toBe('auto')
    await expect(section.getByRole('alert')).toHaveCount(0)

    // Each computer's own projects folder, forge's saved on forge.
    await expect(section.getByRole('textbox', { name: 'Default projects directory on this computer' })).toBeVisible()
    const forgeFolder = section.getByRole('textbox', { name: 'Default projects directory on forge' })
    await forgeFolder.fill('/home/builder/projects')
    await forgeFolder.press('Tab')
    await expect.poll(async () => (await agents(page)).host.clientHosts?.find(host => host.hostId === forge)?.projectsDirectory).toBe('/home/builder/projects')
    await expect(section.getByRole('alert')).toHaveCount(0)
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expect(forgeFolder).toBeInViewport({ ratio: 0.5 })
        await page.screenshot({ path: join(evidence, `${appearance}-${width}.png`), animations: 'disabled' })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // A thread opened in forge's project starts on Auto, since forge lets this computer answer over SSH.
    expect((await agents(page)).host.clientHosts?.find(host => host.hostId === forge)?.mayAnswer).toBe(true)
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'New thread in site', exact: true }).click()
    const project = (await agents(page)).host.projects.find(item => item.hostId === forge && item.title === 'site')!.id
    await expect.poll(async () => {
      const state = await agents(page)
      return state.host.threads.filter(thread => thread.projectId === project).map(thread => thread.runtimeMode)
    }, { timeout: 30_000 }).toEqual(['auto'])
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
