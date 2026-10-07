import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { build } from 'vite'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Phones on a remote host (ADR-0050) in the built app, over a scripted ssh that runs the real launch script and a real
 * headless host, whose Tailscale is a stand-in it reads from a file: forge has no screen, so its phone access is turned
 * on, checked, paired and turned off from this computer's Settings > Hosts, from the keyboard.
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
/** Whether an element sits wholly inside the window, so nothing is clipped at the minimum size. */
const inside = (locator: Locator) => locator.evaluate(element => {
  const box = element.getBoundingClientRect()
  return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5
})

test('forge’s phone access is turned on, checked, paired and turned off from this computer', async () => {
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-phones-'))
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  // forge's Tailscale, as its host reads it: not installed until the spec says otherwise.
  const tailscaleDirectory = join(root, 'tailscale')
  await mkdir(tailscaleDirectory, { recursive: true })
  const tailscale = (fixture: object) => writeFile(join(tailscaleDirectory, 'e2e-tailscale.json'), JSON.stringify({ dnsName: 'forge.tail5728ca.ts.net', hostName: 'forge', ...fixture }))
  await tailscale({ state: 'missing' })
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_HOST_TAILSCALE_DIR', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'), SOTTO_E2E_HOST_TAILSCALE_DIR: tailscaleDirectory,
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))

    // Add forge.
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

    // The row says phones are off, read from forge once it connected; the keyboard opens its Phones dialog.
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await expect(row.getByText(/Phones off/u)).toBeVisible({ timeout: 30_000 })
    const openPhones = row.getByRole('button', { name: 'Open phone access for forge' })
    await openPhones.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Phones on forge' })
    const toggle = dialog.getByRole('switch', { name: 'Let phones reach forge' })
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await capture(launched, 'off', async () => { expect(await inside(dialog.getByRole('button', { name: 'Done' }))).toBe(true) })

    // Tailscale is not on forge: the first step says so, and that Sotto will not install it.
    await page.keyboard.press('Space')
    const steps = dialog.getByRole('list', { name: 'Phone access on forge' })
    const step = (name: string) => steps.getByRole('listitem').filter({ hasText: name })
    await expect(step('Tailscale on forge')).toContainText('Tailscale isn’t installed on forge. Nothing was changed, and Sotto won’t install it.', { timeout: 30_000 })
    await expect(row.getByText(/Phones need you/u)).toBeVisible()
    await capture(launched, 'no-tailscale', async () => { await step('Tailscale on forge').scrollIntoViewIfNeeded(); await expect(step('Tailscale on forge')).toBeVisible() })

    // Tailscale is installed and signed in there now: Try again sets Serve up on forge and gives the address.
    await tailscale({ state: 'running' })
    await step('Tailscale on forge').getByRole('button', { name: 'Try again' }).click()
    await expect(step('Address phones use')).toContainText('https://forge.tail5728ca.ts.net:8443', { timeout: 30_000 })
    await expect(step('Tailscale Serve on port 8443')).toContainText('Sotto added it on forge.')

    // Pair a phone: the code takes focus, and Escape withdraws it without closing the dialog.
    await dialog.getByRole('button', { name: 'Pair a phone' }).click()
    const code = dialog.getByRole('group', { name: 'Pairing code from forge' })
    await expect(code).toBeFocused({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(code).toHaveCount(0, { timeout: 30_000 })
    await expect(dialog).toBeVisible()

    // A phone redeems the next code on forge's own phone listener, the one Tailscale Serve carries.
    await dialog.getByRole('button', { name: 'Pair a phone' }).click()
    await expect(code).toBeFocused({ timeout: 30_000 })
    await capture(launched, 'code', async () => { await code.scrollIntoViewIfNeeded(); expect(await inside(code)).toBe(true) })
    const spoken = (await code.locator('.tt-visually-hidden').textContent())!.replace('Pairing code ', '').replaceAll(' ', '')
    const { port } = JSON.parse(await readFile(join(root, '~', '.sotto', 'phone-access.json'), 'utf8')) as { port: number }
    const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code: spoken, name: 'Zach’s iPhone' }) })
    expect(paired.ok).toBe(true)
    await expect(dialog.getByText('Zach’s iPhone is paired with forge.')).toBeAttached({ timeout: 30_000 })
    const phones = dialog.getByRole('region', { name: 'Phones paired with forge' })
    await expect(phones.getByRole('region', { name: 'Zach’s iPhone' })).toBeVisible()
    await expect(row.getByText(/Phones on, 1 paired/u)).toBeVisible()
    await capture(launched, 'paired', async () => { await phones.scrollIntoViewIfNeeded(); await expect(phones).toBeVisible() })

    // Can answer is the owner's press, sent on to forge.
    await phones.getByRole('switch', { name: 'Can answer: let Zach’s iPhone answer questions and permissions' }).click()
    await expect(phones.getByText('Reads and replies. Can answer questions and permissions.')).toBeVisible({ timeout: 30_000 })

    // Escape closes the dialog, and focus goes back to the button that opened it.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(openPhones).toBeFocused()

    // Turning it off removes forge's Serve setting; the phone stays paired for next time.
    await openPhones.click()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 })
    await expect(row.getByText(/Phones off/u)).toBeVisible({ timeout: 30_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
