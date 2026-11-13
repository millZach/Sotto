import { createServer, type Server } from 'node:http'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { buildSshHost } from './support/sshHost'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Account copies in the built app (ADR-0205, amending ADR-0025), over a scripted ssh that runs the real launch script
 * and a real headless host on this computer, started with a key file as a host that keeps credentials is. A Vercel
 * account added here is sent to forge when forge is paired, the page says where it is kept, switching the copy off
 * takes it back from forge, and removing the account removes the copy. Vercel is a stand-in that knows one made-up
 * token. Captures go to artifacts/plugins-account-copies for the verification note.
 */
const evidence = evidenceDirectory('artifacts/plugins-account-copies')
/** A made-up token: nothing here is a real credential. */
const TOKEN = 'made-up-token-vercel-accepts'

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/** Vercel, as far as checking a token goes. */
async function standInVercel(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const good = request.headers.authorization === `Bearer ${TOKEN}`
    response.writeHead(good ? 200 : 403, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(good ? { user: { username: 'example-user' } } : { error: { code: 'forbidden', invalidToken: true } }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

/** Anything in the open Plugins page that is wider than the room it sits in. */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.settings-scroll')!
    const room = scroll.getBoundingClientRect()
    const problems: string[] = []
    if (scroll.scrollWidth > scroll.clientWidth + 1) problems.push(`settings-scroll ${scroll.scrollWidth} > ${scroll.clientWidth}`)
    for (const element of document.querySelectorAll<HTMLElement>('#settings-plugins *')) {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.right > room.right + 1) problems.push(`${element.tagName.toLowerCase()}.${element.className} right ${Math.round(box.right)} > ${Math.round(room.right)}`)
    }
    return problems.slice(0, 8)
  })
}

test('An account is copied to a paired host, the page says where it is kept, and switching the copy off or keeping it to a project takes it back', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance')
  test.setTimeout(300_000)
  await mkdir(evidence, { recursive: true })
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-plugins-account-copies-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  // The key file a host that keeps credentials is started with: outside its data folder, and made up.
  const keyFile = join(root, 'host.key')
  await writeFile(keyFile, 'made-up-host-key-of-enough-length')
  const vercel = await standInVercel()
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'HOME', 'USERPROFILE',
    'SOTTO_OWL_FEATURES', 'SOTTO_E2E_VERCEL_API_URL', 'SOTTO_E2E_HOST_OWL', 'SOTTO_HOST_KEY_FILE', 'SOTTO_E2E_NATIVE_FIXTURE_ROOT', 'SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  // A stand-in provider, so this computer has a project to keep the account to.
  const native = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'site']) await mkdir(join(native, folder), { recursive: true })
  await writeFile(join(native, 'codex', 'script.json'), JSON.stringify({}))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them apart.
    HOME: join(root, '~'), USERPROFILE: join(root, '~'),
    SOTTO_OWL_FEATURES: 'plugins=1', SOTTO_E2E_VERCEL_API_URL: vercel.url, SOTTO_E2E_HOST_OWL: '1', SOTTO_HOST_KEY_FILE: keyFile,
    SOTTO_E2E_NATIVE_FIXTURE_ROOT: native, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.execPath })
  /** The host's own data folder, where it keeps the copies it is sent. */
  const hostData = join(root, '~', '.sotto')
  const held = async (): Promise<Record<string, unknown>[]> => (JSON.parse(await readFile(join(hostData, 'plugin-accounts.json'), 'utf8').catch(() => '{"accounts":[]}')) as { accounts: Record<string, unknown>[] }).accounts
  const hostSlots = async (): Promise<string[]> => Object.keys(JSON.parse(await readFile(join(hostData, 'credentials.json'), 'utf8').catch(() => '{}')) as Record<string, string>).filter(slot => slot.startsWith('plugin:'))
  /** Every file under a folder, as text, to look for something that must not be in any of them in the clear. */
  const files = async (folder: string): Promise<{ path: string; text: string }[]> => {
    const found: { path: string; text: string }[] = []
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) found.push(...await files(path))
      else if (/\.(json|jsonl|log|txt)$/u.test(entry.name)) found.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
    }
    return found
  }
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    // A project on this computer, to keep the account to later.
    await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const made = await agents.command({ type: 'create-project', provider: 'codex', title: 'Site', path, useExisting: true })
      if (made.error) throw new Error(made.error)
    }, join(native, 'site'))
    // An account added before any other computer is paired: one place it is kept, and nothing to choose. It is added
    // before Settings opens, so the page reads it as it reads any account it finds.
    const added = await page.evaluate(async secret => window.sotto!.plugins!.addAccount({ plugin: 'vercel', name: 'Work', secret }), TOKEN)
    expect(added.ok).toBe(true)
    const accountId = added.ok ? added.accounts[0]!.id : ''
    await openPage(page, 'Settings')
    const sections = page.getByRole('tablist', { name: 'Settings sections' })
    await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Plugins', exact: true })
    await expect(panel.getByText('No other computer is paired. Pair one in Settings › Hosts & phones, and its threads can use these accounts too.')).toBeVisible()

    // forge is paired, over the scripted ssh, with the real launch script and a real headless host.
    await sections.getByRole('tab', { name: 'Hosts & phones', exact: true }).click()
    await page.getByRole('button', { name: 'Add host', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Add host' })
    await expect(form.getByRole('combobox', { name: 'Device' })).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await form.getByRole('textbox', { name: 'SSH host' }).fill('forge')
    // Added by hand: with a provider connected, the dialog starts on having an agent set the host up.
    await form.getByRole('radio', { name: 'Add it', exact: true }).check()
    await form.getByRole('button', { name: 'Add host', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'forge is connected' })).toBeVisible({ timeout: 90_000 })
    await page.keyboard.press('Enter')

    // The copy reaches forge without being asked for: a new computer starts with a copy of each account.
    await expect.poll(async () => (await held()).map(account => account.id), { timeout: 30_000 }).toEqual([accountId])
    expect(await held()).toEqual([{ id: accountId, plugin: 'vercel', name: 'Work', savedAt: expect.any(String), signedInAs: 'example-user' }])
    expect(await hostSlots()).toEqual([`plugin:${accountId}`])
    // The token is in no file on the host, or here, in the clear.
    for (const file of [...await files(hostData), ...await files(profile)]) expect(file.text.includes(TOKEN), file.path).toBe(false)

    await sections.getByRole('tab', { name: 'Plugins', exact: true }).click()
    const computers = panel.getByRole('list', { name: 'Other computers' })
    await expect(computers.getByRole('listitem')).toHaveText(['forgeConnected. Copies kept there: 1.'])
    await expect(panel.getByRole('switch', { name: 'Copy new accounts to every computer I pair' })).toHaveAttribute('aria-checked', 'true')
    await panel.getByRole('button', { name: /^Vercel/u }).click()
    const card = panel.getByRole('region', { name: 'Vercel account Work' })
    const kept = card.getByRole('region', { name: 'Where its secret is kept' })
    await expect(kept).toContainText('This computer')
    await expect(kept).toContainText('Always, in Sotto’s encrypted store.')
    const copy = kept.getByRole('switch', { name: 'Keep a copy of Work on forge' })
    await expect(copy).toHaveAttribute('aria-checked', 'true')
    await expect(copy).toContainText('A copy is kept on forge.')

    for (const [mode, width, height] of [['dark', 1600, 1000], ['dark', 1280, 800], ['light', 1280, 800], ['dark', 820, 560]] as const) {
      await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, mode)
      await resizeWindow(launched, width, height)
      expect(await overflow(page), `Plugins ${width}x${height} ${mode}`).toEqual([])
      await kept.scrollIntoViewIfNeeded()
      if (width !== 1600) await shot(page, `copy-kept-${mode}-${width}x${height}`)
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

    // Switched off from the keyboard: forge lets its copy go, account and secret, and the page says what that means.
    await copy.focus()
    await page.keyboard.press('Enter')
    await expect(copy).toHaveAttribute('aria-checked', 'false')
    await expect(copy).toContainText('No copy. forge’s threads cannot use this account.')
    await expect.poll(held, { timeout: 30_000 }).toEqual([])
    expect(await hostSlots()).toEqual([])
    await computers.scrollIntoViewIfNeeded()
    await expect(computers.getByRole('listitem')).toHaveText(['forgeConnected. Copies kept there: 0.'])
    await shot(page, 'copy-off-dark-1280x800')

    // Switched back on, it is sent again.
    await copy.click()
    await expect(copy).toContainText('A copy is kept on forge.', { timeout: 30_000 })
    await expect.poll(async () => (await held()).length).toBe(1)

    // Kept to a project, which is a folder on this computer: its secret stays here, so forge lets its copy go and the
    // switch says why and cannot be pressed.
    const chips = card.getByRole('group', { name: 'Projects whose threads may use Work' })
    await chips.getByRole('button', { name: 'Site' }).click()
    await expect(copy).toBeDisabled()
    await expect(copy).toHaveAttribute('aria-checked', 'false')
    await expect(copy).toContainText('No copy. Work is kept to projects on this computer, so its secret stays here. Choose Every project to copy it.')
    await expect.poll(held, { timeout: 30_000 }).toEqual([])
    expect(await hostSlots()).toEqual([])
    await kept.scrollIntoViewIfNeeded()
    expect(await overflow(page), 'Plugins, an account kept to a project').toEqual([])
    await shot(page, 'copy-stays-here-dark-1280x800')
    // Given back to every project, its copy is sent again, as the switch was left.
    await chips.getByRole('button', { name: 'Every project' }).click()
    await expect(copy).toBeEnabled()
    await expect(copy).toContainText('A copy is kept on forge.', { timeout: 30_000 })
    await expect.poll(async () => (await held()).length).toBe(1)

    // Removing the account here removes the copy there.
    await card.getByRole('button', { name: 'Remove the Vercel account Work' }).click()
    await card.getByRole('button', { name: 'Remove account' }).click()
    await expect.poll(held, { timeout: 30_000 }).toEqual([])
    expect(await hostSlots()).toEqual([])
    for (const file of [...await files(hostData), ...await files(profile)]) expect(file.text.includes(TOKEN), file.path).toBe(false)
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await new Promise<void>(done => vercel.server.close(() => done()))
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
