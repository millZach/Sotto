import { buildSshHost } from './support/sshHost'
import { insideWindow as inside } from './support/hostCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { elementContrast } from './support/elementContrast'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { opencodeSignInComesBack } from '../../src/shared/opencodeSignIn'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #1107 in the built app: an Owl desktop adds forge over a scripted ssh that runs the real launch script and a real headless
 * host on Owl, whose OpenCode is the fake server (tests/fixtures/fakeOpenCodeServer.mjs). forge's OpenCode tile shows its
 * version and connection, and the Model sources block under the tiles signs forge's own OpenCode in from this computer: a
 * key that never stays in the window, a device code whose page opens in this computer's browser, and a sign-in that would
 * send the browser back to forge, which is refused.
 */
const evidence = evidenceDirectory('artifacts/opencode-hosts')
// Made up for this journey; the fixture's model sources are fake and no key leaves this computer and its test host.
const KEY = 'sk-e2e-host-made-up-key-7f20'
const opened = (page: Page) => page.evaluate(async () => (await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.snapshot()).openedExternalLink ?? null)
const providers = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.providers ?? []).map(provider => [provider.id, provider.connection]))
})
const contrasts: { surface: string; appearance: string; ratio: number }[] = []
async function measure(root: Locator, surfaces: Record<string, string>, appearance: string): Promise<void> {
  for (const [surface, selector] of Object.entries(surfaces)) {
    const ratio = await elementContrast(root.locator(selector).first())
    contrasts.push({ surface, appearance, ratio: Math.round(ratio * 100) / 100 })
    expect(ratio, surface).toBeGreaterThanOrEqual(4.5)
  }
}
async function shoot(launched: LaunchedSotto, name: string, sizes: readonly (readonly [number, number])[], check: (appearance: string) => Promise<void>): Promise<void> {
  const { page } = launched
  for (const [width, height] of sizes) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await check(appearance)
      await page.screenshot({ path: join(evidence, `${name}-${width}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}

test('forge’s OpenCode shows on its tile and signs in to model sources from this computer', async () => {
  test.setTimeout(600_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-opencode-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  await mkdir(evidence, { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await buildSshHost(install)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  await writeFile(modeFile, 'run')
  const opencode = join(root, 'opencode-fixture')
  await mkdir(opencode, { recursive: true })
  await writeFile(join(opencode, 'script.json'), JSON.stringify({ oauth: { 'xai:device': { mode: 'auto', code: 'QX7M-4LRT' }, 'openai:chatgpt-token-sharing': { mode: 'auto' } } }))
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_HOST_OPENCODE_ROOT', 'SOTTO_E2E_HOST_OPENCODE_SCRIPT', 'SOTTO_OWL_FEATURES', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    SOTTO_E2E_HOST_OPENCODE_ROOT: opencode, SOTTO_E2E_HOST_OPENCODE_SCRIPT: resolve('tests/fixtures/fakeOpenCodeServer.mjs'),
    // An Owl desktop: OpenCode is on here, as it is on forge.
    SOTTO_OWL_FEATURES: 'opencode=1',
    // The host runs on this computer, so its folders would be this account's: a throwaway home keeps them out.
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    page.on('pageerror', error => errors.push(error.message))
    await resizeWindow(launched, 1280, 800)

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
    await expect.poll(() => providers(page), { timeout: 60_000 }).toMatchObject({ opencode: 'connected' })

    // OpenCode's tile: its version and connection, and no sign-in command; Model sources under the tiles.
    const row = page.getByRole('region', { name: 'forge', exact: true })
    await row.getByRole('button', { name: 'Show providers on forge' }).click()
    const grid = row.getByRole('list', { name: 'Providers on forge' })
    const tile = grid.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'OpenCode', exact: true }) })
    await expect(tile).toContainText('Connected')
    await expect(tile).toContainText('2.0.31')
    await expect(tile.getByRole('button', { name: 'Disconnect OpenCode on forge' })).toBeVisible()
    const sources = row.getByRole('group', { name: 'OpenCode model sources on forge' })
    await expect(sources).toContainText('OpenCode Zen')
    const deferUpdates = page.getByRole('button', { name: 'Not now', exact: true })
    if (await deferUpdates.count()) await deferUpdates.click()
    await shoot(launched, 'tile', [[1600, 1000], [1280, 800], [820, 560]], async appearance => {
      await tile.scrollIntoViewIfNeeded()
      expect(await inside(tile)).toBe(true)
      await measure(tile, { 'tile state': '.host-provider__state', 'tile detail': '.host-provider__detail' }, appearance)
      await measure(sources, { 'model source': '.oc-src small', 'model count': '.oc-count' }, appearance)
    })
    await shoot(launched, 'sources', [[1280, 800], [820, 560]], async () => {
      await sources.scrollIntoViewIfNeeded()
      expect(await inside(sources.getByRole('button', { name: 'Add a model source to OpenCode on forge' }))).toBe(true)
    })

    // Add a model source to forge's OpenCode: the dialog names forge, and a key goes to it and stays nowhere here.
    const add = sources.getByRole('button', { name: 'Add a model source to OpenCode on forge' })
    await add.scrollIntoViewIfNeeded()
    await add.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleName('Add a model source to OpenCode on forge')
    await expect(dialog.getByRole('textbox', { name: 'Search model sources' })).toBeFocused()
    await shoot(launched, 'dialog-pick', [[1280, 800], [820, 560]], async appearance => {
      expect(await inside(dialog)).toBe(true)
      await measure(dialog, { 'dialog description': '.tt-dialog__description', 'source name': '.oc-opt__name' }, appearance)
    })
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('anthro')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Sign in to Anthropic')
    await expect(dialog).toContainText('The key goes to Sotto’s OpenCode on forge once, which keeps it in its own folder there. Sotto keeps no copy on either computer.')
    const field = dialog.getByLabel('Anthropic API key')
    await expect(field).toBeFocused()
    await field.fill(KEY)
    await shoot(launched, 'dialog-key', [[1280, 800], [820, 560]], async appearance => {
      expect(await inside(dialog)).toBe(true)
      await measure(dialog, { 'key sentence': '.oc-keynote' }, appearance)
    })
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(sources).toContainText('Signed in to Anthropic.', { timeout: 30_000 })
    await expect(sources.getByRole('button', { name: 'Sign out of Anthropic on forge' })).toBeVisible()
    // forge's OpenCode holds the key; nothing in this window or this computer's state does.
    expect(await readFile(join(opencode, 'credentials.json'), 'utf8')).toContain(KEY)
    expect(await page.content()).not.toContain(KEY)
    expect(await page.evaluate(async () => JSON.stringify([await window.sotto!.agents!.get(), await window.sotto!.hosts!.get()]))).not.toContain(KEY)
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.clientHosts?.[0]?.providers?.find(provider => provider.id === 'opencode')?.account ?? ''), { timeout: 30_000 }).toBe('Signed in to Anthropic')

    // A device code: the page opens in this computer's browser, and the sign-in finishes by itself on forge.
    await add.click()
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('xai')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Sign in to xAI')
    await dialog.getByRole('radio', { name: /SuperGrok/u }).check()
    await dialog.getByRole('button', { name: 'Open the xAI sign-in page in your browser' }).click()
    await expect(dialog.getByText('QX7M-4LRT')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => opened(page)).toBe('https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT')
    await shoot(launched, 'dialog-device-code', [[1280, 800], [820, 560]], async appearance => {
      expect(await inside(dialog)).toBe(true)
      await measure(dialog, { 'waiting line': '.oc-wait__status' }, appearance)
    })
    await writeFile(join(opencode, 'approve.json'), JSON.stringify({ integrationID: 'xai' }))
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(sources).toContainText('Signed in to xAI.')

    // A sign-in that would send the browser back to OpenCode on forge cannot finish from here: it is refused in words.
    await add.click()
    await dialog.getByRole('textbox', { name: 'Search model sources' }).fill('openai')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveAccessibleName('Sign in to OpenAI')
    await dialog.getByRole('radio', { name: /ChatGPT/u }).check()
    await dialog.getByRole('button', { name: 'Open the OpenAI sign-in page in your browser' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(opencodeSignInComesBack('forge'), { timeout: 30_000 })
    // Learned once: the method says why, and its button cannot be pressed again.
    await expect(dialog.getByRole('button', { name: 'ChatGPT account cannot finish from this computer' })).toBeDisabled()
    await expect(dialog.getByText('Finishes on forge itself, so not from this computer.')).toBeVisible()
    await shoot(launched, 'dialog-comes-back', [[1280, 800]], async appearance => {
      await measure(dialog, { 'refusal': '.provider-detail__error' }, appearance)
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(add).toBeFocused()

    await writeFile(join(evidence, 'contrast.json'), JSON.stringify({ lowest: Math.min(...contrasts.map(item => item.ratio)), contrasts }, null, 2))
    expect(errors).toEqual([])
  } finally {
    // forge keeps running after Sotto closes, as a host Sotto started does: stop it, and every OpenCode server it started.
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    const records = await readFile(join(opencode, 'requests.jsonl'), 'utf8').catch(() => '')
    for (const line of records.split('\n')) {
      try { const record = JSON.parse(line) as { method?: string; params?: { pid?: number } }; if (record.method === 'fixture/process' && record.params?.pid) process.kill(record.params.pid) } catch { /* gone, or not a record */ }
    }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
