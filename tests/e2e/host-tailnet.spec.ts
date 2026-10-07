import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { build } from 'vite'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { serveStandIn } from '../fixtures/serveStandIn'

/**
 * A desktop reaches a host over its tailnet first (ADR-0053), in the built app: a scripted ssh runs the real launch script
 * and a real headless host, whose Tailscale is a stand-in it reads from a file, and a loopback proxy stands in for Tailscale
 * Serve in front of the host's tailnet listener, at the address SOTTO_E2E_TAILNET_MAP gives forge's MagicDNS name. Every
 * ssh the app spawns is recorded, so a connect that needs none is seen to make none.
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

/**
 * forge, as these journeys reach it: a host built from `tests/fixtures/e2eSshHost.ts` and started here the way the launch
 * script starts it, so it outlives a relaunch of Sotto, under a throwaway home. Its Tailscale is the stand-in it reads from
 * a file, running, with Serve as `serve` says; a loopback proxy stands in for Tailscale Serve in front of its tailnet
 * listener; and the scripted ssh runs the real launch script. Every ssh the app spawns is recorded.
 */
async function forgeHost(serve: 'free' | 'denied') {
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-tailnet-'))
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  // forge's Tailscale, as its host reads it: running, so the host's Serve setting comes up, unless Serve is refused.
  const tailscaleDirectory = join(root, 'tailscale')
  await mkdir(tailscaleDirectory, { recursive: true })
  const setServe = (value: 'free' | 'denied') => writeFile(join(tailscaleDirectory, 'e2e-tailscale.json'), JSON.stringify({ state: 'running', dnsName: 'forge.tail5728ca.ts.net', hostName: 'forge', serve: value }))
  await setServe(serve)
  // Serve's stand-in carries forge's tailnet listener, on the port the host remembers for it.
  const listenerFile = join(root, '~', '.sotto', 'phone-access.json')
  const stand = await serveStandIn(() => existsSync(listenerFile) ? (JSON.parse(readFileSync(listenerFile, 'utf8')) as { port?: number }).port : undefined)
  const record = join(root, 'ssh.jsonl')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_HOST_TAILSCALE_DIR', 'SOTTO_E2E_TAILNET_MAP', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: record, SOTTO_E2E_HOST_TAILSCALE_DIR: tailscaleDirectory,
    SOTTO_E2E_TAILNET_MAP: `forge.tail5728ca.ts.net=127.0.0.1:${stand.port}`,
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out of the captures.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  // forge's host, started here the way the launch script starts it, so it outlives a relaunch of Sotto: on Windows a host the
  // app's own ssh started would hold the app's output open, and Playwright would wait for it to close.
  const data = join(root, '~', '.sotto')
  const started = spawn(process.execPath, [join(install, 'index.js'), '--data', data, '--port', '0'], { detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, SOTTO_HOST_STARTED_BY: 'launch-script' } })
  started.unref()
  await expect.poll(() => existsSync(join(data, 'host-listener.json')), { timeout: 60_000 }).toBe(true)
  const spawned = async (): Promise<unknown[]> => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string }).filter(event => event.type === 'spawn')
  const cleanup = async (launched: LaunchedSotto | undefined): Promise<void> => {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    await stand.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return { profile, root, modeFile, record, stand, spawned, setServe, cleanup }
}

test('forge is reached over its tailnet after Add host, with no ssh at the next launch, and over SSH when the tailnet is silent', async () => {
  test.setTimeout(300_000)
  const { profile, root, modeFile, record, stand, spawned, cleanup } = await forgeHost('free')
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    page(launched).on('pageerror', error => errors.push(error.message))

    // Add forge. The form says, before the press, that Sotto turns on Tailscale Serve there.
    await openPage(page(launched), 'Settings')
    await page(launched).getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page(launched).getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page(launched).getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page(launched).keyboard.press('End')
    await page(launched).keyboard.press('Enter')
    const sshHost = form.getByRole('textbox', { name: 'SSH host' })
    await sshHost.fill('forge')
    const serve = form.getByText(/^Sotto turns on Tailscale Serve on the host, on your tailnet only/u)
    await expect(serve).toBeVisible()
    // The sentence describes the press, so a screen reader meets it there, and on the field whose Enter makes the press.
    await expect(form.getByRole('button', { name: 'Add host', exact: true })).toHaveAccessibleDescription(/^Sotto turns on Tailscale Serve on the host/u)
    // The dialog scrolls as a whole at the minimum size: the press and the sentence each fit once scrolled to.
    await capture(launched, 'add-host-serve', async () => {
      const press = form.getByRole('button', { name: 'Add host', exact: true })
      await press.scrollIntoViewIfNeeded()
      expect(await inside(press)).toBe(true)
      await serve.scrollIntoViewIfNeeded()
      expect(await inside(serve)).toBe(true)
    })
    await sshHost.focus()
    await page(launched).keyboard.press('Enter')
    await expect(page(launched).getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page(launched).keyboard.press('Enter')
    const row = () => page(launched!).getByRole('region', { name: 'forge', exact: true })
    await expect(row().getByText(/^Tailnet · Connected/u)).toBeVisible({ timeout: 30_000 })

    // Sotto quits and starts again: forge connects over its tailnet, and no ssh runs at all.
    await closeSotto(launched)
    await writeFile(record, '')
    launched = await launchSotto('success', profile)
    page(launched).on('pageerror', error => errors.push(error.message))
    await openPage(page(launched), 'Settings')
    await page(launched).getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(row().getByText(/^Tailnet · Connected · [0-9]+ providers · Phones off$/u)).toBeVisible({ timeout: 30_000 })
    expect(await spawned()).toEqual([])
    await capture(launched, 'tailnet', async () => { await row().scrollIntoViewIfNeeded(); expect(await inside(row().getByText(/^Tailnet · Connected/u))).toBe(true) })

    // Phones… reads forge over an admin connection, and Tailscale SSH holds its sign-in for approval: the dialog says so at its top.
    await writeFile(modeFile, 'run+tailscale')
    const openPhones = row().getByRole('button', { name: 'Open phone access for forge' })
    await openPhones.focus()
    await page(launched).keyboard.press('Enter')
    const dialog = page(launched).getByRole('dialog', { name: 'Phones on forge' })
    await expect(dialog.getByText(/^Waiting for your approval in Tailscale\./u)).toBeVisible({ timeout: 30_000 })
    const approve = dialog.getByRole('button', { name: 'Open the Tailscale approval page for forge' })
    await capture(launched, 'phones-approval', async () => { await approve.scrollIntoViewIfNeeded(); expect(await inside(approve)).toBe(true) })
    await approve.click()
    await writeFile(join(root, 'approved'), '')
    await expect(dialog.getByRole('switch', { name: 'Let phones reach forge' })).toBeEnabled({ timeout: 30_000 })
    await expect(dialog.getByText(/^Waiting for your approval in Tailscale\./u)).toHaveCount(0)
    // The admin connection's launch finds the running host and starts none.
    const launches = (await spawned() as { op?: string; start?: boolean }[]).filter(event => event.op === 'launch')
    expect(launches).toEqual([expect.objectContaining({ op: 'launch', start: false })])
    await page(launched).keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(openPhones).toBeFocused()

    // The tailnet goes silent: Serve answers 502, and the connection drops. Sotto reconnects over SSH and says why.
    stand.answer(502)
    stand.cut()
    await expect(row().getByText(/^SSH forge · Connected · Tailnet did not answer/u)).toBeVisible({ timeout: 60_000 })
    await expect(row().getByText('Sotto tries it again every 5 minutes.')).toBeVisible()
    await capture(launched, 'ssh-fallback', async () => { await row().scrollIntoViewIfNeeded(); expect(await inside(row().getByText('Sotto tries it again every 5 minutes.'))).toBe(true) })
    expect(errors).toEqual([])
  } finally {
    await cleanup(launched)
  }
})

test('Add host shows its tailnet step, says why it kept forge on SSH and tries again, and Edit connection chooses how Sotto connects', async () => {
  test.setTimeout(300_000)
  // forge's Tailscale refuses Serve to the SSH account until it is made Tailscale's operator, as Linux does.
  const { profile, modeFile, setServe, cleanup } = await forgeHost('denied')
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    page(launched).on('pageerror', error => errors.push(error.message))
    await openPage(page(launched), 'Settings')
    await page(launched).getByRole('tab', { name: 'Hosts', exact: true }).click()
    await page(launched).getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page(launched).getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page(launched).keyboard.press('End')
    await page(launched).keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await page(launched).keyboard.press('Enter')

    // Added and paired, but kept on SSH: the tailnet step says why, with the command to run on forge.
    const kept = page(launched).getByRole('dialog', { name: 'forge is connected over SSH' })
    await expect(kept).toBeVisible({ timeout: 90_000 })
    // The dialog's name follows the step, so its steps are found by the list's own name.
    const titles = page(launched).getByRole('list', { name: 'Connection steps' }).locator('.host-setup__title')
    await expect(titles).toHaveText(['Reached forge', 'Signed in', 'Host installed', 'Host started', 'Paired', 'Could not reach forge over your tailnet'])
    await expect(kept.getByText(/^forge’s Tailscale Serve needs your SSH account to be Tailscale’s operator there/u)).toBeVisible()
    await expect(kept.getByText('sudo tailscale set --operator=$USER')).toBeVisible()
    const done = kept.getByRole('button', { name: 'Done' })
    await expect(done).toBeFocused()
    await capture(launched, 'add-host-operator', async () => { await done.scrollIntoViewIfNeeded(); expect(await inside(done)).toBe(true) })

    // The owner runs the command on forge, then Try the tailnet again reaches it over the tailnet.
    await setServe('free')
    await kept.getByRole('button', { name: 'Try the tailnet again' }).click()
    const reached = page(launched).getByRole('dialog', { name: 'forge is connected', exact: true })
    await expect(reached).toBeVisible({ timeout: 60_000 })
    await expect(titles.last()).toHaveText('Reached forge over your tailnet', { timeout: 60_000 })
    await expect(reached.getByText('https://forge.tail5728ca.ts.net:8443')).toBeVisible()
    await expect(reached.getByText(/^forge is added and connected over your tailnet\./u)).toBeVisible()
    await expect(reached.getByRole('button', { name: 'Done' })).toBeFocused()
    await capture(launched, 'add-host-tailnet', async () => { const press = reached.getByRole('button', { name: 'Done' }); await press.scrollIntoViewIfNeeded(); expect(await inside(press)).toBe(true) })
    await page(launched).keyboard.press('Enter')
    const row = () => page(launched!).getByRole('region', { name: 'forge', exact: true })
    await expect(row().getByText(/^Tailnet · Connected/u)).toBeVisible({ timeout: 30_000 })

    // Edit connection, from the keyboard: How Sotto connects is a pair of radios the arrows move between.
    const more = row().getByRole('button', { name: 'More for forge' })
    await more.focus()
    await page(launched).keyboard.press('Enter')
    await page(launched).getByRole('menuitem', { name: 'Edit connection' }).focus()
    await page(launched).keyboard.press('Enter')
    const edit = page(launched).getByRole('dialog', { name: 'Edit connection to forge' })
    const tailnet = edit.getByRole('radio', { name: 'Over your tailnet, SSH when it can’t' })
    await expect(tailnet).toBeChecked()
    await expect(tailnet).toBeFocused()
    await expect(tailnet).toHaveAccessibleDescription(/^At https:\/\/forge\.tail5728ca\.ts\.net:8443, last reached at .+\. Sotto turns on Tailscale Serve on forge for this, on your tailnet only\./u)
    await capture(launched, 'edit-connection', async () => {
      const save = edit.getByRole('button', { name: 'Save connection' })
      await save.scrollIntoViewIfNeeded()
      expect(await inside(save)).toBe(true)
      await tailnet.scrollIntoViewIfNeeded()
      expect(await inside(tailnet)).toBe(true)
    })
    await tailnet.focus()
    await page(launched).keyboard.press('ArrowDown')
    await expect(edit.getByRole('radio', { name: 'SSH only' })).toBeChecked()
    await edit.getByRole('button', { name: 'Save connection' }).click()
    await expect(edit).toHaveCount(0, { timeout: 60_000 })
    await expect(row().getByText(/^SSH forge · Connected/u)).toBeVisible({ timeout: 60_000 })
    await expect(row().getByText(/Tailnet did not answer/u)).toHaveCount(0)

    // And back: the tailnet again, which the row reads as soon as the socket has moved. Focus starts on SSH only, the choice
    // forge has now, rather than on the first radio.
    await more.click()
    await page(launched).getByRole('menuitem', { name: 'Edit connection' }).click()
    await expect(edit.getByRole('radio', { name: 'SSH only' })).toBeFocused()
    await edit.getByRole('radio', { name: 'Over your tailnet, SSH when it can’t' }).check()
    await edit.getByRole('button', { name: 'Save connection' }).click()
    await expect(edit).toHaveCount(0, { timeout: 60_000 })
    await expect(row().getByText(/^Tailnet · Connected/u)).toBeVisible({ timeout: 60_000 })

    // Rename says how Sotto connects does not change.
    await more.click()
    await page(launched).getByRole('menuitem', { name: 'Rename' }).click()
    const rename = page(launched).getByRole('dialog', { name: 'Rename forge' })
    const field = rename.getByRole('textbox', { name: 'Host name' })
    await expect(field).toHaveAccessibleDescription('Shown on this row and beside the host\'s projects and threads. How Sotto connects to it does not change.')
    await capture(launched, 'rename', async () => { await field.scrollIntoViewIfNeeded(); expect(await inside(field)).toBe(true) })
    await page(launched).keyboard.press('Escape')
    await expect(rename).toHaveCount(0)

    // After a relaunch, over the tailnet, Phones… reads forge over an admin connection. While Tailscale holds its sign-in
    // nothing is read yet, so the dialog shows no switch.
    await closeSotto(launched)
    launched = await launchSotto('success', profile)
    page(launched).on('pageerror', error => errors.push(error.message))
    await openPage(page(launched), 'Settings')
    await page(launched).getByRole('tab', { name: 'Hosts', exact: true }).click()
    await expect(row().getByText(/^Tailnet · Connected/u)).toBeVisible({ timeout: 30_000 })
    await writeFile(modeFile, 'run+tailscale')
    await row().getByRole('button', { name: 'Open phone access for forge' }).click()
    const phones = page(launched).getByRole('dialog', { name: 'Phones on forge' })
    await expect(phones.getByText(/^Waiting for your approval in Tailscale\./u)).toBeVisible({ timeout: 30_000 })
    await expect(phones.getByText('Not read yet. The switch shows once Sotto reaches forge over SSH.')).toBeVisible()
    await expect(phones.getByRole('switch')).toHaveCount(0)
    await capture(launched, 'phones-unread', async () => { const open = phones.getByRole('button', { name: 'Open the Tailscale approval page for forge' }); await open.scrollIntoViewIfNeeded(); expect(await inside(open)).toBe(true) })
    await page(launched).keyboard.press('Escape')
    await expect(phones).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await cleanup(launched)
  }
})

function page(launched: LaunchedSotto) { return launched.page }
