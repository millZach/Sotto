import { buildSshHost } from './support/sshHost'
import { captureHostMatrix as capture, insideWindow as inside } from './support/hostCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #460 in the built app, over a scripted ssh that runs the real launch script and a real headless host whose providers
 * are signed out until their fake clients sign in (tests/fixtures/fakeSignInCli.mjs), as forge was on September 28:
 * Codex signed in and connected, Claude Code and Grok Build installed and signed out, Devin not installed. From the
 * keyboard: Show providers, Sign in to Claude Code with a refused code and then the right one, Grok Build's device code
 * with Escape and then entered, Disconnect and Connect Codex, and Check again on Devin.
 */

/** Whether an element sits wholly inside the window, so nothing is clipped at the minimum size. */

const providers = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.providers ?? []).map(provider => [provider.id, provider.connection]))
})
const opened = (page: Page) => page.evaluate(async () => (await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot()).openedExternalLink ?? null)

test('a host’s providers show under its row, sign in from this computer, and act on that host alone', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-provider-tiles-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const signIns = join(root, 'sign-ins')
  await mkdir(signIns, { recursive: true })
  await writeFile(modeFile, 'run')
  // Codex is signed in on forge; the others are not.
  await writeFile(join(signIns, 'codex.signed-in'), '')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_SIGN_IN_DIR', 'SOTTO_E2E_SIGN_IN_SCRIPT', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    SOTTO_E2E_SIGN_IN_DIR: signIns, SOTTO_E2E_SIGN_IN_SCRIPT: resolve('tests/fixtures/fakeSignInCli.mjs'),
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
    await expect.poll(() => providers(page), { timeout: 30_000 }).toEqual({ codex: 'connected', claude: 'error', grok: 'error', devin: 'error' })

    // The row counts forge's connected providers, and Show providers opens its tiles from the keyboard.
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await expect(row.getByText('SSH forge · Connected · 1 provider')).toBeVisible()
    const show = row.getByRole('button', { name: 'Show providers on forge' })
    await show.focus()
    await page.keyboard.press('Enter')
    const hide = row.getByRole('button', { name: 'Hide providers on forge' })
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    const grid = row.getByRole('list', { name: 'Providers on forge' })
    const tile = (name: string) => grid.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(tile('Codex')).toContainText('Connected')
    await expect(tile('Claude Code')).toContainText('Not signed in')
    await expect(tile('Grok Build')).toContainText('Not signed in')
    await expect(tile('Devin')).toContainText('Not installed')
    await expect(tile('Devin')).toContainText('Not on forge yet.')
    await expect(row.getByText('forge connects each provider that is signed in when its host starts. A provider you disconnect stays off.')).toBeVisible()
    // Focus moves from the disclosure into the tiles in the order they are read.
    await page.keyboard.press('Tab')
    await expect(tile('Claude Code').getByRole('button', { name: 'Sign in to Claude Code on forge from this computer' })).toBeFocused()
    await capture(launched, 'tiles', async () => {
      await expect(grid).toBeVisible()
      await grid.scrollIntoViewIfNeeded()
      for (const name of ['Claude Code', 'Codex']) expect(await inside(tile(name))).toBe(true)
    })

    // Claude Code: the code pasted back. A refused code says so and offers Try again; the right one connects it.
    await tile('Claude Code').getByRole('button', { name: 'Sign in to Claude Code on forge from this computer' }).focus()
    await page.keyboard.press('Enter')
    const claude = page.getByRole('dialog', { name: 'Sign in to Claude Code on forge' })
    const openPageButton = claude.getByRole('button', { name: 'Open sign-in page' })
    await expect(openPageButton).toBeFocused({ timeout: 30_000 })
    await page.keyboard.press('Enter')
    await expect.poll(() => opened(page)).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/u)
    const code = claude.getByRole('textbox', { name: 'Code from the page' })
    await expect(code).toBeFocused()
    await capture(launched, 'sign-in-paste', async () => {
      await expect(code).toBeVisible()
      expect(await inside(claude)).toBe(true)
    })
    await code.focus()
    await page.keyboard.type('stale-code#fixture-state')
    await page.keyboard.press('Enter')
    const refusal = claude.getByRole('alert')
    await expect(refusal).toHaveText('Claude Code did not accept that code, so forge is still not signed in. Open the sign-in page again for a new code.', { timeout: 30_000 })
    const again = claude.getByRole('button', { name: 'Try again' })
    await expect(again).toBeFocused()
    await capture(launched, 'sign-in-refused', async () => {
      await expect(refusal).toBeVisible()
      expect(await inside(claude)).toBe(true)
    })
    await again.focus()
    await page.keyboard.press('Enter')
    await expect(openPageButton).toBeFocused({ timeout: 30_000 })
    await page.keyboard.press('Enter')
    await expect(code).toBeFocused()
    await page.keyboard.type('good-code#fixture-state')
    await page.keyboard.press('Enter')
    await expect(claude.getByText('Claude Code is signed in and connected on forge.')).toBeVisible({ timeout: 30_000 })
    await expect(claude.getByRole('button', { name: 'Done' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(claude).toHaveCount(0)
    await expect(tile('Claude Code')).toContainText('Connected')
    await expect(row.getByText('SSH forge · Connected · 2 providers')).toBeVisible()

    // Grok Build: a device code. Escape stops the sign-in on forge and leaves it signed out.
    await tile('Grok Build').getByRole('button', { name: 'Sign in to Grok Build on forge from this computer' }).click()
    const grok = page.getByRole('dialog', { name: 'Sign in to Grok Build on forge' })
    await expect(grok.getByText('K7PX-2QRM')).toBeVisible({ timeout: 30_000 })
    await expect(grok.getByText('Waiting for you on accounts.x.ai.')).toBeVisible()
    await expect(grok.getByRole('button', { name: 'Open sign-in page' })).toBeFocused()
    await capture(launched, 'sign-in-device-code', async () => {
      await expect(grok.getByText('K7PX-2QRM')).toBeVisible()
      expect(await inside(grok)).toBe(true)
    })
    await page.keyboard.press('Escape')
    await expect(grok).toHaveCount(0)
    await expect(tile('Grok Build')).toContainText('Not signed in')
    await tile('Grok Build').getByRole('button', { name: 'Sign in to Grok Build on forge from this computer' }).click()
    await expect(grok.getByText('K7PX-2QRM')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Enter')
    await expect.poll(() => opened(page)).toBe('https://accounts.x.ai/oauth2/device?user_code=K7PX-2QRM')
    // Entering the code on the page: the fake client finishes by itself.
    await writeFile(join(signIns, 'grok.approved'), '')
    await expect(grok.getByText('Grok Build is signed in and connected on forge.')).toBeVisible({ timeout: 30_000 })
    await grok.getByRole('button', { name: 'Done' }).click()
    await expect(tile('Grok Build')).toContainText('Connected')
    await expect.poll(() => providers(page)).toEqual({ codex: 'connected', claude: 'connected', grok: 'connected', devin: 'error' })

    // Disconnect and Connect act on forge alone, and Check again on Devin says nothing changed.
    await tile('Codex').getByRole('button', { name: 'Disconnect Codex on forge' }).click()
    await expect(tile('Codex')).toContainText('Turned off')
    const saved = JSON.parse(await readFile(join(root, '~', '.sotto', 'agents.json'), 'utf8')) as { configuration: { disconnectedProviders?: string[] } }
    expect(saved.configuration.disconnectedProviders).toEqual(['codex'])
    await tile('Codex').getByRole('button', { name: 'Connect Codex on forge' }).click()
    await expect(tile('Codex')).toContainText('Connected')
    await tile('Devin').getByRole('button', { name: 'Check forge for Devin again' }).click()
    await expect(tile('Devin')).toContainText('Checked again. Nothing changed on forge.')
    await capture(launched, 'tiles-after', async () => {
      await expect(grid).toBeVisible()
      await row.getByText('forge connects each provider').scrollIntoViewIfNeeded()
      await expect(tile('Devin')).toContainText('Checked again. Nothing changed on forge.')
    })
    await hide.click()
    await expect(grid).toHaveCount(0)
    await writeFile(test.info().outputPath('host-providers.json'), JSON.stringify({ providers: await providers(page) }, null, 2))
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
