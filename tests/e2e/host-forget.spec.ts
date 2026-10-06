import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { build } from 'vite'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Forget over an admin connection (ADR-0053) in the built app, over a scripted ssh that runs the real launch script and
 * a real headless host. A host on no connection is forgotten over an admin connection of its own, which revokes this
 * computer there. When SSH cannot reach the host, Forget still removes it here and says how to revoke it there.
 */
async function capture(launched: LaunchedSotto, name: string, check: () => Promise<void>): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await check()
      await page.screenshot({ path: test.info().outputPath(`${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}
/** Whether an element sits wholly inside the window, and does not scroll sideways, so nothing is clipped at the minimum size. */
const inside = (locator: Locator) => locator.evaluate(element => {
  const box = element.getBoundingClientRect()
  return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 && element.scrollWidth <= element.clientWidth + 1
})

test('Forget revokes this computer over an admin connection, and says how to revoke it there when SSH cannot reach the host', async () => {
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-forget-'))
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  const record = join(root, 'ssh.jsonl')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: record,
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  /** The launch script operations every ssh ran since `from`, with an admin connection's launch named for what it is. */
  const operations = async (from = 0): Promise<string[]> => (await readFile(record, 'utf8')).trim().split('\n').slice(from)
    .map(line => JSON.parse(line) as { type: string; op?: string; start?: boolean }).filter(event => event.type === 'spawn' && event.op)
    .map(event => event.op === 'launch' && event.start === false ? 'admin launch' : event.op!)
  const lines = async (): Promise<number> => (await readFile(record, 'utf8')).trim().split('\n').length
  const paired = async (): Promise<string[]> => ((JSON.parse(await readFile(join(root, '~', '.sotto', 'paired-clients.json'), 'utf8')) as { clients: { clientId: string }[] }).clients).map(client => client.clientId)
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts', exact: true }).click()
    const row = page.getByRole('region', { name: 'forge', exact: true })
    const addForge = async (): Promise<string> => {
      await page.getByRole('button', { name: 'Add host', exact: true }).click()
      const form = page.getByRole('dialog', { name: 'Add host' })
      await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
      await form.getByRole('button', { name: 'Add host', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
      await page.keyboard.press('Enter')
      await expect(row.getByText('SSH forge · Connected')).toBeVisible()
      return (await page.evaluate(() => window.sotto!.hosts!.get())).hosts[0]!.clientId!
    }
    const forget = async (): Promise<Locator> => {
      await row.getByRole('button', { name: 'More for forge' }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: 'Forget forge…' }).click()
      return page.getByRole('dialog', { name: 'Forget forge?' })
    }

    // Switched off, forge's host keeps running and this computer has no connection to it. Forget opens an admin
    // connection, which finds the running host and starts none, revokes this computer over it and stops the host.
    const first = await addForge()
    expect(await paired()).toEqual([first])
    await row.getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' }).click()
    await expect(row.getByText('SSH forge · Switched off')).toBeVisible()
    const before = await lines()
    const dialog = await forget()
    await expect(dialog.getByText(/Sotto signs in to forge over SSH to revoke this computer's access there/u)).toBeVisible()
    await dialog.getByRole('button', { name: 'Forget host' }).click()
    await expect(row).toHaveCount(0, { timeout: 60_000 })
    // The revoke comes before the stop of the host Sotto started, since it goes through the running host.
    expect(await operations(before)).toEqual(['admin launch', 'revoke-client', 'stop-host'])
    expect(await paired()).toEqual([])
    await expect(page.getByRole('status', { name: 'forge still trusts this computer' })).toHaveCount(0)

    // Added again, then switched off, and now SSH cannot reach forge: Forget removes it here anyway, and says how to
    // revoke this computer there.
    const second = await addForge()
    await row.getByRole('switch', { name: 'Keep forge connected, now and when Sotto starts' }).click()
    await expect(row.getByText('SSH forge · Switched off')).toBeVisible()
    await writeFile(modeFile, 'unreachable')
    const unreachable = await forget()
    await capture(launched, 'forget-confirm', async () => { expect(await inside(unreachable)).toBe(true) })
    await unreachable.getByRole('button', { name: 'Forget host' }).click()
    await expect(row).toHaveCount(0, { timeout: 60_000 })
    expect(await paired()).toEqual([second])
    const notice = page.getByRole('status', { name: 'forge still trusts this computer' })
    await expect(notice).toContainText('Sotto removed forge from this computer, but could not revoke this computer’s access there')
    const command = (await notice.locator('code').textContent())!
    expect(command).toContain(`--revoke-client "${second}"`)
    expect(command).toContain('--data "$HOME/.sotto"')
    expect(command).toMatch(/^I="\$HOME\/\.local\/share\/sotto-host"; /u)
    await capture(launched, 'forget-not-revoked', async () => { await notice.scrollIntoViewIfNeeded(); expect(await inside(notice)).toBe(true) })

    // From the keyboard: Copy command puts the line on the clipboard, and Dismiss puts the notice away.
    const copy = notice.getByRole('button', { name: 'Copy the command to run on forge' })
    await copy.focus()
    await page.keyboard.press('Enter')
    await expect(copy).toHaveText('Copied')
    await expect.poll(() => page.evaluate(async () => (await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot()).clipboardText)).toBe(command)
    await page.keyboard.press('Tab')
    await expect(notice.getByRole('button', { name: 'Dismiss what Sotto said about forge' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(notice).toHaveCount(0)
    expect(JSON.parse(await readFile(join(profile, 'remote-hosts.json'), 'utf8'))).toEqual([])
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
