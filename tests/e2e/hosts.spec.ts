import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DETERMINISTIC_TRANSCRIPT } from '../fixtures/fakeTranscription'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage } from './support/sottoLaunch'

test('client-only desktop keeps local history, renders Hosts, and retains dictation settings', async () => {
  test.setTimeout(120_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-hosts-'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const saved = '{"existing":"untouched workspace"}'
  await writeFile(join(profile, 'workspace.json'), saved)
  // A saved host, switched off so the run connects nowhere, and a stand-in SSH folder for the suggestions.
  await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: '33333333-3333-4333-8333-333333333333', name: 'Forge', target: 'builder@forge', identityFile: '', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', enabled: false }]))
  await mkdir(join(profile, 'e2e-home', '.ssh'), { recursive: true })
  await writeFile(join(profile, 'e2e-home', '.ssh', 'config'), 'Host forge\n  HostName forge.example.net\n  User builder\nHost pihole\n  HostName 192.0.2.10\n  User pi\nHost *\n  ServerAliveInterval 30\n')
  await writeFile(join(profile, 'e2e-home', '.ssh', 'known_hosts'), '[buildbox.example.net]:2200 ssh-ed25519 AAAA\n|1|hashed=|entry= ssh-ed25519 AAAA\n')
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
    const row = page.getByRole('region', { name: 'Forge', exact: true })
    await expect(row.getByText('SSH builder@forge · Switched off')).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Keep Forge connected, now and when Sotto starts' })).toHaveAttribute('aria-checked', 'false')
    for (const name of ['Save host', 'Connect', 'Disconnect', 'Use this host', 'Use this computer']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
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
          if (dialog) expect(await page.getByRole('dialog').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth })).toBe(true)
          await page.screenshot({ path: test.info().outputPath(`${name}-${width}-${appearance}.png`), animations: 'disabled' })
        }
      }
    }
    await row.scrollIntoViewIfNeeded()
    await capture('hosts', false)

    // Add host: suggestions from the SSH setup, the host already saved left out, Escape closing the list first.
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add host' })
    const field = dialog.getByRole('combobox', { name: 'SSH host or alias' })
    await expect(field).toBeFocused()
    await expect(dialog.getByRole('option')).toHaveText([/^pihole/, /^buildbox\.example\.net/])
    await capture('host-add', true)
    await page.keyboard.press('Escape')
    await expect(field).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog).toBeVisible()
    // A host nothing answers on: the dialog says what happened and that nothing was saved.
    await field.fill('127.0.0.1')
    await page.keyboard.press('Escape')
    await dialog.getByRole('textbox', { name: 'Port (optional)' }).fill('1')
    await dialog.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Nothing was saved.', { timeout: 60_000 })
    await page.screenshot({ path: test.info().outputPath('host-add-failed.png'), animations: 'disabled' })
    expect((JSON.parse(await readFile(join(profile, 'remote-hosts.json'), 'utf8')) as { name: string }[]).map(host => host.name)).toEqual(['Forge'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('region', { name: '127.0.0.1' })).toHaveCount(0)

    // The row menu, from the keyboard: Edit connection shows the route split into its fields.
    await row.getByRole('button', { name: 'More for Forge' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Edit connection' })).toBeFocused()
    await page.keyboard.press('Enter')
    const edit = page.getByRole('dialog', { name: 'Edit connection to Forge' })
    await expect(edit.getByRole('combobox', { name: 'SSH host or alias' })).toHaveValue('forge')
    await expect(edit.getByRole('textbox', { name: 'Username (optional)' })).toHaveValue('builder')
    await page.screenshot({ path: test.info().outputPath('host-edit-minimum.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'More for Forge' })).toBeFocused()
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
