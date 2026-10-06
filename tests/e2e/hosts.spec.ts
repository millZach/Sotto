import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DETERMINISTIC_TRANSCRIPT } from '../fixtures/fakeTranscription'
import { TAILSCALE_RUNNING } from '../fixtures/tailscaleStatus'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('client-only desktop keeps local history, renders Hosts, and retains dictation settings', async () => {
  test.setTimeout(180_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-hosts-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const saved = '{"existing":"untouched workspace"}'
  await writeFile(join(profile, 'workspace.json'), saved)
  // A saved host, switched off so the run connects nowhere, and a stand-in SSH folder for the device list.
  await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: '33333333-3333-4333-8333-333333333333', name: 'Spark', target: 'builder@spark', identityFile: '', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', enabled: false }]))
  await mkdir(join(profile, 'e2e-home', '.ssh'), { recursive: true })
  await writeFile(join(profile, 'e2e-home', '.ssh', 'config'), 'Host forge\n  HostName forge.tail5728ca.ts.net\n  User builder\nHost pihole\n  HostName 100.64.0.5\n  User pi\nHost spark\n  HostName spark.lan\n  User builder\nHost *\n  ServerAliveInterval 30\n')
  await writeFile(join(profile, 'e2e-home', '.ssh', 'known_hosts'), '[buildbox.example.net]:2200 ssh-ed25519 AAAA\n|1|hashed=|entry= ssh-ed25519 AAAA\n')
  // This computer's Tailscale, stopped: the recorded tailnet with its backend stopped, which the end-to-end
  // stand-in answers with until Connect to Tailscale sets it running.
  const tailscaleStatus = join(profile, 'e2e-tailscale-status.json')
  await writeFile(tailscaleStatus, JSON.stringify({ ...JSON.parse(TAILSCALE_RUNNING) as object, BackendState: 'Stopped' }))
  const launched = await launchSotto('success', profile)
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const state = await page.evaluate(() => window.sotto!.agents!.get())
    expect(state.host.threads).toEqual([])
    expect(state.connections).toEqual([])
    expect(await readFile(join(profile, 'workspace.json'), 'utf8')).toBe(saved)
    expect((await readdir(profile)).filter(file => file.startsWith('threads.sqlite'))).toEqual([])
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Run the local host' })).toHaveAttribute('aria-checked', 'false')
    // The saved host was switched off, so nothing connects; it still reads as a row.
    const row = page.getByRole('region', { name: 'Spark', exact: true })
    await expect(row.getByText('SSH builder@spark · Switched off')).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Keep Spark connected, now and when Sotto starts' })).toHaveAttribute('aria-checked', 'false')
    for (const name of ['Save host', 'Connect', 'Disconnect', 'Use this host', 'Use this computer']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    // Tailscale sits under This computer and offers to connect.
    const tailscale = page.getByRole('region', { name: 'Tailscale', exact: true })
    await expect(tailscale.getByText('Off on this computer. Connect to reach your other machines.')).toBeVisible()
    await expect(tailscale.getByRole('button', { name: 'Connect to Tailscale' })).toBeVisible()
    const capture = async (name: string, dialog: boolean): Promise<void> => {
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await launched.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.setContentSize(size.width!, size.height!)
        }, { width, height })
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          expect(await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth,
            form: document.querySelector('.settings-scroll')!.scrollWidth > document.querySelector('.settings-scroll')!.clientWidth + 1 }))).toEqual({ page: false, form: false })
          if (dialog) {
            expect(await page.getByRole('dialog').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth })).toBe(true)
            // An open device list sits inside the dialog, which scrolls to it, and never scrolls sideways.
            expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.hosts-devices__popup:not([hidden])')].every(popup => {
              const box = popup.getBoundingClientRect(), dialog = popup.closest('[role="dialog"]')!.getBoundingClientRect()
              return box.left >= dialog.left && box.right <= dialog.right && popup.scrollWidth <= popup.clientWidth
            }))).toBe(true)
          }
          await page.screenshot({ path: test.info().outputPath(`${name}-${width}-${appearance}.png`), animations: 'disabled' })
        }
      }
    }
    await row.scrollIntoViewIfNeeded()
    await capture('hosts-tailscale-off', false)

    // Add host with Tailscale off: the dialog asks too, and the list holds the SSH setup alone, the saved host greyed.
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add host' })
    const picker = dialog.getByRole('combobox', { name: 'Device' })
    await expect(picker).toBeFocused()
    await expect(picker).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.getByText(/Tailscale is off on this computer\./)).toBeVisible()
    await expect(dialog.getByRole('option')).toHaveText([/^forgebuilder@forge/, /^pihole/, /^buildbox\.example\.net/, /^spark.*Already added as Spark$/, /^Another SSH host/])
    await expect(dialog.getByText('Connect to Tailscale to see the machines on your tailnet here.')).toBeVisible()
    await capture('host-add-tailscale-off', true)

    // Connect to Tailscale runs `tailscale up`; the stand-in comes up, the prompt goes and the tailnet fills the list.
    await dialog.getByRole('button', { name: 'Connect to Tailscale' }).click()
    await expect(dialog.getByText(/Tailscale is off/)).toHaveCount(0)
    await expect(picker).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(picker).toHaveAttribute('aria-expanded', 'true')
    const canConnect = dialog.getByRole('group', { name: 'Can connect' })
    await expect(canConnect.getByRole('option')).toHaveText([
      'forgeLinux · Tailscale SSH · SSH configuration',
      'piholeLinux · Tailscale, SSH server not checked · SSH configuration',
      /^buildbox\.example\.net/,
    ])
    const cantUse = dialog.getByRole('group', { name: "Can't use now" })
    await expect(cantUse.getByRole('option')).toHaveText([/^spark.*Already added as Spark$/, /^omarchyLinux · Tailscale SSH · Offline, last seen \d+ days? ago$/, /^DESKTOP-8NPFSBMWindows · Tailscale, SSH server not checked · Offline/, 'iphone-15-proiOS · Tailscale · A phone cannot run the host'])
    await expect(dialog.getByText("Don't see your machine? Install Tailscale on it and sign in as millZach@github.")).toBeVisible()
    await expect(tailscale.getByText('Connected as millZach · 5 devices on your tailnet')).toBeVisible()
    await capture('host-add', true)
    // Typeahead and Enter pick forge; Escape closes the list before the dialog.
    await page.keyboard.type('fo')
    await page.keyboard.press('Enter')
    await expect(picker).toHaveAttribute('aria-expanded', 'false')
    await expect(picker).toHaveText('forgeLinux · Tailscale SSH · SSH configuration')
    await capture('host-add-picked', true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(picker).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog).toBeVisible()

    // Another SSH host: a host nothing answers on, typed. The dialog says what happened and that nothing was saved.
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    const field = dialog.getByRole('textbox', { name: 'SSH host' })
    await expect(field).toBeFocused()
    await expect(field).toHaveValue('forge')
    await field.fill('127.0.0.1')
    await dialog.getByRole('textbox', { name: 'Port (optional)' }).fill('1')
    await capture('host-add-typed', true)
    await dialog.getByRole('button', { name: 'Add host', exact: true }).click()
    // Once pressed, the dialog is the setup checklist, and a failure shows on its step.
    const failed = page.getByRole('dialog', { name: '127.0.0.1 could not be added' })
    await expect(failed.getByRole('alert')).toContainText('Nothing was saved.', { timeout: 60_000 })
    await page.screenshot({ path: test.info().outputPath('host-add-failed.png'), animations: 'disabled' })
    expect((JSON.parse(await readFile(join(profile, 'remote-hosts.json'), 'utf8')) as { name: string }[]).map(host => host.name)).toEqual(['Spark'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '127.0.0.1' })).toHaveCount(0)
    await expect(tailscale.getByText('Connected as millZach · 5 devices on your tailnet')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('hosts-tailscale-running.png'), animations: 'disabled' })

    // The row menu, from the keyboard: Edit connection shows the route split into its fields.
    await row.getByRole('button', { name: 'More for Spark' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Edit connection' })).toBeFocused()
    await page.keyboard.press('Enter')
    const edit = page.getByRole('dialog', { name: 'Edit connection to Spark' })
    await expect(edit.getByRole('textbox', { name: 'SSH host' })).toHaveValue('spark')
    await expect(edit.getByRole('textbox', { name: 'Username (optional)' })).toHaveValue('builder')
    await page.screenshot({ path: test.info().outputPath('host-edit-minimum.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'More for Spark' })).toBeFocused()

    // Tailscale not installed: the row offers Get Tailscale once the window comes back to the front.
    await rm(tailscaleStatus)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(tailscale.getByText('Not installed. Any machine you reach over SSH works without it, and Sotto connects to it over SSH each time.')).toBeVisible()
    await tailscale.getByRole('button', { name: 'Get Tailscale' }).click()
    await capture('hosts-tailscale-missing', false)

    await page.getByRole('tab', { name: 'Dictation', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Global shortcut' })).toBeVisible()
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page.getByRole('switch', { name: 'Run the local host' }).click()
    await expect(page.getByRole('button', { name: 'Restart Sotto' })).toBeVisible()
    expect((await page.evaluate(() => window.sotto!.getSettings())).localHostEnabled).toBe(true)
    expect(await readFile(join(profile, 'workspace.json'), 'utf8')).toBe(saved)
    await openPage(page, 'Dictate')
    await page.getByRole('button', { name: /start dictation/i }).click()
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot())).toMatchObject({ clipboardText: DETERMINISTIC_TRANSCRIPT })
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true })
  }
})
