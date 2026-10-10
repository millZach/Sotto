import { buildSshHost } from './support/sshHost'
import { captureHostMatrix as capture } from './support/hostCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #459 in the built app, over a scripted ssh that runs the real launch script and a real headless host with scripted
 * providers. First every provider on forge is signed out: adding a project there is refused with a sentence that
 * names forge and the page to go to. Then the providers are signed in on forge, the host is stopped and switched on
 * again, and it connects all four on its own, with nothing saved to tell it to, and the same project is added.
 */

const providers = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.providers ?? []).map(provider => [provider.id, provider.connection]))
})

test('a host names itself when no provider is connected, and connects every signed-in provider when it starts', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-providers-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code', 'site'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const signedOut = join(root, 'signed-out')
  await writeFile(modeFile, 'run')
  await writeFile(signedOut, '')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_HOST_SIGNED_OUT', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'), SOTTO_E2E_HOST_SIGNED_OUT: signedOut,
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))

    // Add forge, whose providers are all signed out.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    const connected = page.getByRole('dialog', { name: 'forge is connected' })
    await expect(connected).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')
    await expect.poll(() => providers(page), { timeout: 30_000 }).toEqual({ codex: 'error', claude: 'error', grok: 'error', devin: 'error' })

    // Adding a project there is refused, naming forge and where to connect one, and claiming no saved draft.
    await openThreads(page)
    const addProject = page.getByRole('button', { name: 'Add project', exact: true })
    await addProject.click()
    const dialog = page.getByRole('dialog', { name: /Where should this project live\?/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.getByRole('button', { name: /site/ }).click()
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    const refusal = dialog.getByRole('alert')
    await expect(refusal).toHaveText('No provider is connected on forge. Connect one in Settings > Hosts.')
    await capture(launched, 'no-provider', async () => {
      await expect(refusal).toBeInViewport()
      await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeInViewport()
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Sign the providers in on forge and restart its host: Stop host, then switch it on.
    await rm(signedOut)
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await row.getByRole('button', { name: 'More for forge' }).click()
    await page.getByRole('menuitem', { name: 'Stop host' }).click()
    await page.getByRole('dialog', { name: /Stop the host on forge\?/ }).getByRole('button', { name: 'Stop host' }).click()
    const toggle = row.getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 })
    await toggle.click()
    await expect(row.getByText('SSH forge · Connected')).toBeVisible({ timeout: 90_000 })
    // All four connect by themselves: nothing on forge names any of them.
    await expect.poll(() => providers(page), { timeout: 30_000 }).toEqual({ codex: 'connected', claude: 'connected', grok: 'connected', devin: 'connected' })
    const saved = JSON.parse(await readFile(join(root, '~', '.sotto', 'agents.json'), 'utf8')) as { configuration: { enabledProviders?: string[]; disconnectedProviders?: string[] } }
    expect(saved.configuration.disconnectedProviders).toBeUndefined()
    await writeFile(test.info().outputPath('host-providers.json'), JSON.stringify({ providers: await providers(page), enabledProviders: saved.configuration.enabledProviders }, null, 2))

    // The same project is added now.
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(addProject).toBeVisible()
    await addProject.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'code' }).click()
    await dialog.getByRole('button', { name: /site/ }).click()
    await dialog.getByRole('button', { name: 'Use this folder' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.projects.map(project => project.title))).toContain('site')
    await capture(launched, 'project-added', async () => {
      await expect(page.getByRole('button', { name: /site/ }).first()).toBeInViewport()
    })
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
