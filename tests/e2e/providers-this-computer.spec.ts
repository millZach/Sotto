import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #1083 in the built app: with forge selected for new work, Settings > Providers is still this computer's clients.
 * Forge runs the real headless host over a scripted ssh with its Codex signed out, as the development laptop's forge
 * had Muse signed out on October 16, 2026, while this computer's Codex is connected. The page shows this computer's
 * Codex, and its Disconnect and Connect act on this computer alone. (Forge's fake sign-in client words its own
 * refusal, so naming the host where an error says "this machine" is checked in desktopHostRouter.test.ts.)
 */

const OUT = process.env.SOTTO_PROVIDERS_CAPTURE_DIR

/** Each host's Codex as the window has it, with the host selected for new work. */
const codex = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  const of = (kind: 'local' | 'remote') => {
    const hostId = state.connections?.find(item => item.kind === kind)?.hostId
    const status = state.host.clientHosts?.find(item => item.hostId === hostId)?.providers?.find(provider => provider.id === 'codex')
    return { connection: status?.connection ?? null, error: status?.error ?? null }
  }
  const selected = state.connections?.find(item => item.hostId === state.hostId)?.kind ?? null
  return { selected, local: of('local'), remote: of('remote') }
})

test('Settings > Providers shows and acts on this computer’s clients while forge is selected', async () => {
  test.setTimeout(240_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-providers-this-computer-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  await buildSshHost(join(root, '~', '.local', 'share', 'sotto-host', 'host'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: true, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  // Forge's Claude Code is signed in; its Codex is not.
  const signIns = join(root, 'sign-ins')
  await mkdir(signIns, { recursive: true })
  await writeFile(join(signIns, 'claude.signed-in'), '')
  // This computer's providers run in the provider switch a real app has, each a test host (the Devin fixture's wiring).
  const devinRoot = join(profile, 'devin')
  await mkdir(devinRoot, { recursive: true })
  const keys = ['SOTTO_E2E_DEVIN_ROOT', 'SOTTO_E2E_DEVIN_EXECUTABLE', 'SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_SIGN_IN_DIR', 'SOTTO_E2E_SIGN_IN_SCRIPT', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_DEVIN_ROOT: devinRoot, SOTTO_E2E_DEVIN_EXECUTABLE: process.execPath, SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    SOTTO_E2E_SIGN_IN_DIR: signIns, SOTTO_E2E_SIGN_IN_SCRIPT: resolve('tests/fixtures/fakeSignInCli.mjs'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })

    // Add forge, then select it for new work, as opening one of its threads does.
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    await form.getByRole('radio', { name: 'Add it' }).check()
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await codex(page)).remote.connection, { timeout: 30_000 }).toBe('error')
    await expect.poll(async () => (await codex(page)).local.connection, { timeout: 30_000 }).toBe('connected')
    const forgeId = await page.evaluate(async () => (await window.sotto!.agents!.get()).connections!.find(item => item.kind === 'remote')!.hostId)
    await page.evaluate(async hostId => { await window.sotto!.hosts!.command({ type: 'select', hostId }) }, forgeId)
    expect((await codex(page)).selected).toBe('remote')

    // Settings > Providers shows this computer's Codex, connected, and none of forge's error.
    await page.getByRole('tab', { name: 'Providers', exact: true }).click()
    const list = page.getByRole('list', { name: 'Thread providers' })
    // Every row starts closed; open Codex's.
    await expect(list.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await list.getByRole('button', { name: 'Codex', exact: true }).click()
    await expect(list.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(list.getByRole('button', { name: 'Codex', exact: true })).toContainText('Connected')
    const detail = page.getByRole('region', { name: 'Codex details' })
    await expect(detail.getByRole('button', { name: 'Disconnect Codex' })).toBeVisible()
    await expect(list.getByRole('alert')).toHaveCount(0)
    if (OUT) await page.screenshot({ path: join(OUT, 'providers-with-forge-selected.png') })

    // Disconnect and Connect act on this computer's Codex; forge's stays as it was and stays selected.
    await detail.getByRole('button', { name: 'Disconnect Codex' }).click()
    await expect.poll(async () => (await codex(page)).local.connection, { timeout: 30_000 }).toBe('disconnected')
    expect(await codex(page)).toMatchObject({ selected: 'remote', remote: { connection: 'error' } })
    await expect(detail.getByRole('button', { name: 'Connect Codex' })).toBeVisible()
    await detail.getByRole('button', { name: 'Connect Codex' }).click()
    await expect.poll(async () => (await codex(page)).local.connection, { timeout: 30_000 }).toBe('connected')
    expect(await codex(page)).toMatchObject({ selected: 'remote', remote: { connection: 'error' } })
    await expect(detail.getByRole('alert')).toHaveCount(0)

    // Forge's own Codex is on its tile in Settings > Hosts & phones.
    await page.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await row.getByRole('button', { name: 'Show providers on forge' }).click()
    const tile = row.getByRole('list', { name: 'Providers on forge' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) })
    await expect(tile).toContainText('Not signed in')
    if (OUT) { await tile.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(OUT, 'forge-codex-tile.png') }) }
    expect(errors).toEqual([])
  } finally {
    // The host the launch script started outlives Sotto, as a real one does; this run stops it first.
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
