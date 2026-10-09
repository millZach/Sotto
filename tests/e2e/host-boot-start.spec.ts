import { agentState } from './support/agentAccess'
import { buildSshHost } from './support/sshHost'
import { captureHostMatrix as capture, insideWindow } from './support/hostCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { fakeSystemd } from '../fixtures/fakeSystemd'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Start at boot from Settings > Hosts (ADR-0054) in the built app, over a scripted ssh that runs the real launch script and
 * a real headless host, with fake `systemctl --user` and `loginctl` first on the path (tests/fixtures/fakeSystemd.ts). Add
 * host's connected card offers it; linger needing an administrator changes nothing and shows the command; the More menu
 * stops it after the busy-host question, and starts it again; Stop host and Forget say what the unit means for them.
 */

/** Whether an element sits wholly inside the window, and does not scroll sideways, so nothing is clipped at the minimum size. */
const inside = (locator: Locator) => insideWindow(locator, true)
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

test('starts a host at boot from Add host’s card once linger is on, stops it after the busy-host question, and Forget takes it away', async () => {
  test.setTimeout(420_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-boot-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  // forge's account does not linger, and polkit refuses to turn it on without an administrator.
  const systemd = await fakeSystemd(join(profile, 'systemd'), { linger: false, enableLinger: 'refuse' })
  const pathKey = Object.keys(systemd.env).find(key => key.toUpperCase() === 'PATH')!
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE',
    pathKey, 'XDG_CONFIG_HOME', 'FAKE_SYSTEMD_STATE', 'FAKE_SYSTEMD_RECORD']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~'),
    [pathKey]: systemd.env[pathKey], XDG_CONFIG_HOME: systemd.env.XDG_CONFIG_HOME, FAKE_SYSTEMD_STATE: systemd.env.FAKE_SYSTEMD_STATE, FAKE_SYSTEMD_RECORD: systemd.env.FAKE_SYSTEMD_RECORD })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    const row = page.getByRole('region', { name: 'forge', exact: true })
    const menu = async (): Promise<Locator> => {
      await row.getByRole('button', { name: 'More for forge' }).focus()
      await page.keyboard.press('Enter')
      return page.getByRole('menu', { name: 'forge actions' })
    }

    // Add forge. Its connected card offers start at boot, saying linger goes on first and the host restarts once.
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('zach@forge')
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    const connected = page.getByRole('dialog', { name: 'forge is connected' })
    await expect(connected).toBeVisible({ timeout: 90_000 })
    await expect(connected).toContainText('Sotto adds a systemd user unit for zach on forge and turns on linger for that account; the host restarts once now, which stops turns running there.')
    const offer = connected.getByRole('button', { name: 'Start forge’s host at boot' })
    await capture(launched, 'card-offer', async () => { expect(await inside(connected)).toBe(true) })

    // Polkit refuses linger: nothing is written, the host keeps running, and the card shows the command to run.
    const before = await systemd.calls()
    await offer.click()
    await expect(connected.getByRole('alert')).toContainText('Nothing changed on forge, and its host is still running as before. forge would not turn on linger without an administrator.', { timeout: 60_000 })
    await expect(connected.locator('.host-setup__command code')).toHaveText(/^sudo loginctl enable-linger \S+$/u)
    expect((await systemd.calls()).slice(before.length)).toContain('loginctl enable-linger')
    expect(await systemd.calls()).not.toContain('systemctl enable sotto-host')
    expect(await exists(systemd.unitPath)).toBe(false)
    await capture(launched, 'card-linger', async () => { expect(await inside(connected)).toBe(true) })

    // The owner runs it on forge: now the press installs the unit, which takes the host over, and this computer connects again.
    await systemd.set({ enableLinger: 'allow' })
    await connected.getByRole('button', { name: 'Start forge’s host at boot' }).click()
    await expect(connected.locator('.host-boot__done')).toHaveText('forge’s host starts at boot. It restarted once under its systemd unit and is connected again.', { timeout: 120_000 })
    expect(await systemd.calls()).toEqual(expect.arrayContaining(['systemctl enable sotto-host', 'systemctl start sotto-host']))
    expect(await exists(systemd.unitPath)).toBe(true)
    await capture(launched, 'card-done', async () => { expect(await inside(connected)).toBe(true) })
    await connected.getByRole('button', { name: 'Done' }).click()
    await expect(row.getByText('SSH zach@forge · Connected')).toBeVisible({ timeout: 60_000 })

    // Stop host says a host that starts at boot comes back with its machine.
    await (await menu()).getByRole('menuitem', { name: 'Stop host' }).click()
    const stop = page.getByRole('dialog', { name: 'Stop the host on forge?' })
    await expect(stop).toContainText('forge’s host stops now and starts again when forge restarts or when you switch it on.')
    await capture(launched, 'stop-host', async () => { expect(await inside(stop)).toBe(true) })
    await stop.getByRole('button', { name: 'Keep it running' }).click()

    // A thread on forge is working: Stop starting at boot asks first, and stops it on the press.
    const thread = await page.evaluate(async path => {
      const forgeHost = (await window.sotto!.hosts!.get()).hosts[0]!.hostId!
      await window.sotto!.hosts!.command({ type: 'select', hostId: forgeHost })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'create-project', title: 'render-farm', path, useExisting: true })
      const state = await agents.get()
      const projectId = state.host.projects.find(item => item.title === 'render-farm')!.id
      await agents.command({ type: 'create-thread', projectId, title: 'Bake the hero shot lighting', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' })
      const threadId = (await agents.get()).host.threads.find(item => item.title === 'Bake the hero shot lighting')!.id
      await agents.command({ type: 'manual-send', threadId, text: 'Bake the lighting for the hero shot.' })
      return threadId
    }, join(root, '~', 'code'))
    const status = async (): Promise<string | undefined> => (await agentState(page)).host.threads.find(item => item.id === thread)?.status
    await expect.poll(status, { timeout: 30_000 }).toBe('running')
    const items = (await menu()).getByRole('menuitem')
    await expect(items.first()).toHaveText('Stop starting at boot…')
    await expect(items).toHaveText(['Stop starting at boot…', 'Stop host', 'Rename', 'Edit connection', 'Forget forge…'])
    const list = page.getByRole('menu', { name: 'forge actions' })
    await capture(launched, 'menu', async () => { await list.scrollIntoViewIfNeeded(); expect(await inside(list)).toBe(true) })
    await page.keyboard.press('Enter')
    const unboot = page.getByRole('dialog', { name: 'Stop starting forge’s host at boot?' })
    await expect(unboot).toContainText('Sotto removes sotto-host.service and its script from forge, and, while forge is switched on, restarts the host once outside the unit')
    await capture(launched, 'stop-boot-consent', async () => { expect(await inside(unboot)).toBe(true) })
    await unboot.getByRole('button', { name: 'Stop starting at boot' }).click()
    await expect(unboot).toContainText('1 thread on forge is working. Stopping start at boot restarts forge’s host, which stops it.')
    await capture(launched, 'stop-boot-busy', async () => { expect(await inside(unboot)).toBe(true) })
    expect(await systemd.calls()).not.toContain('systemctl disable --now sotto-host')
    await expect(unboot.getByRole('button', { name: 'Wait until they finish, then stop starting at boot on forge' })).toBeFocused()
    await unboot.getByRole('button', { name: 'Stop 1 thread now, then stop starting at boot on forge' }).click()
    const unbooted = page.getByRole('dialog', { name: 'forge’s host no longer starts at boot' })
    await expect(unbooted).toContainText('It restarted once outside the unit and is connected again.', { timeout: 120_000 })
    expect(await systemd.calls()).toContain('systemctl disable --now sotto-host')
    expect(await exists(systemd.unitPath)).toBe(false)
    expect(await status()).not.toBe('running')
    await capture(launched, 'stop-boot-done', async () => { expect(await inside(unbooted)).toBe(true) })
    await page.keyboard.press('Escape')
    await expect(unbooted).toHaveCount(0)

    // Start at boot… from the menu: linger is on now, and the host Sotto started restarts once under the unit.
    await (await menu()).getByRole('menuitem', { name: 'Start at boot…' }).click()
    const boot = page.getByRole('dialog', { name: 'Start forge’s host at boot?' })
    await expect(boot.getByRole('list', { name: 'What Sotto found on forge' })).toContainText('Linger · On for zach')
    await expect(boot.getByRole('list', { name: 'What changes on forge' })).toContainText('One restart, now')
    await capture(launched, 'start-boot-consent', async () => { expect(await inside(boot)).toBe(true) })
    await boot.getByRole('button', { name: 'Cancel' }).click()
    await expect(boot).toHaveCount(0)

    // Linger goes off on forge, and turning it on wants an administrator again. Connected again, the modal says linger
    // comes first, with the command to run if forge asks for an administrator, and its button still fits the window.
    await systemd.set({ linger: false, enableLinger: 'refuse' })
    const keep = row.getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' })
    await keep.click()
    await expect(row.getByText('SSH zach@forge · Switched off')).toBeVisible({ timeout: 60_000 })
    await keep.click()
    await expect(row.getByText('SSH zach@forge · Connected')).toBeVisible({ timeout: 90_000 })
    await (await menu()).getByRole('menuitem', { name: 'Start at boot…' }).click()
    await expect(boot.getByRole('list', { name: 'What Sotto found on forge' })).toContainText('Linger, first · Off. Sotto turns it on for zach before anything else')
    await expect(boot.locator('.host-setup__command code')).toHaveText(/^sudo loginctl enable-linger \S+$/u)
    const press = boot.getByRole('button', { name: 'Start at boot', exact: true })
    await capture(launched, 'start-boot-linger-consent', async () => {
      expect(await inside(boot)).toBe(true)
      // The dialog scrolls when the window is short; its button is reachable there, and the dialog never runs off the window.
      await press.scrollIntoViewIfNeeded()
      expect(await inside(press)).toBe(true)
    })

    // The press changes nothing on forge, and offers Start at boot again once the owner has run the command.
    await press.click()
    const lingering = page.getByRole('dialog', { name: 'forge’s host does not start at boot yet' })
    await expect(lingering).toContainText('Nothing changed on forge. Its host is still running as before, and this computer is still connected.', { timeout: 60_000 })
    await expect(lingering.getByRole('button', { name: 'Start at boot', exact: true })).toBeFocused()
    await capture(launched, 'start-boot-linger', async () => { expect(await inside(lingering)).toBe(true) })
    expect(await exists(systemd.unitPath)).toBe(false)
    await systemd.set({ enableLinger: 'allow' })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'forge’s host starts at boot' })).toContainText('It restarted once under its systemd unit', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(row.getByText('SSH zach@forge · Connected')).toBeVisible({ timeout: 60_000 })

    // Forget says it takes start at boot away, and does, after the revoke; nothing starts.
    await (await menu()).getByRole('menuitem', { name: 'Forget forge…' }).click()
    const forget = page.getByRole('dialog', { name: 'Forget forge?' })
    await expect(forget).toContainText('It removes start at boot from forge, so its host does not start again when forge restarts.')
    await capture(launched, 'forget', async () => { expect(await inside(forget)).toBe(true) })
    const removing = (await systemd.calls()).length
    await forget.getByRole('button', { name: 'Forget host' }).click()
    await expect(row).toHaveCount(0, { timeout: 60_000 })
    expect((await systemd.calls()).slice(removing)).toContain('systemctl disable --now sotto-host')
    expect(await exists(systemd.unitPath)).toBe(false)
    await expect(page.getByRole('status', { name: /still (?:trusts this computer|starts at boot)/u })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    for (const pid of await systemd.spawned().catch(() => [])) { try { process.kill(pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
