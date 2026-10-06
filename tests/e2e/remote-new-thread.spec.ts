import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { build } from 'vite'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

/**
 * New thread on a remote host's project opens that thread and keeps it open, in the built app, over the scripted ssh and
 * a real headless host. A remote host keeps a selection for each client and does not move it on create-thread, so the
 * window used to hold the new pane only until the page was left; coming back showed the empty page instead.
 */
test('a thread created on a remote host stays open after leaving Threads and coming back', async () => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-remote-new-thread-'))
  const root = join(profile, 'ssh-root')
  const folder = join(root, '~', 'code', 'Space Race')
  await mkdir(folder, { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on' }))
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
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
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

    // A project whose folder exists on forge, as Space Race's does, made while forge is the selected host. Then this
    // computer's host is selected again, as it is in a window that also runs threads here.
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
    const pane = page.locator('.thread-pane')
    await expect(pane.locator('h2')).toHaveText('New thread')
    // Main selects the thread itself once forge confirms it, not only the page that is showing it.
    await expect.poll(() => page.evaluate(async () => {
      const state = await window.sotto!.agents!.get()
      return state.host.threads.find(thread => thread.id === state.activeThreadId)?.title ?? null
    }), { timeout: 15_000 }).toBe('New thread')

    await page.getByRole('tab', { name: 'Dictate', exact: true }).click()
    await page.getByRole('tab', { name: 'Threads', exact: true }).click()
    await expect(pane.locator('h2')).toHaveText('New thread')
    await expect(page.getByRole('heading', { name: /^(Choose a thread|Your draft is saved)\.$/ })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
