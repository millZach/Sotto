import { isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { build } from 'vite'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { closeSotto, launchSotto, openPage, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * #480 in the built app, over a scripted ssh that runs the real launch script and a real headless host whose clients are
 * forge's on September 29 (tests/fixtures/clientUpdateProviders.ts): Claude Code, Codex and Grok Build installed by mise
 * and all behind. The chip beside Show providers counts them; a tile's Update runs one on forge; Update all runs the
 * rest one at a time, carries on past Codex's dropped download, and shows Grok Build's second step; Try again on Codex's
 * row finishes it, and Done puts the chip away. Only mise, Node and the registry are stood in for.
 */
async function capture(launched: LaunchedSotto, name: string, check: () => Promise<void>): Promise<void> {
  const { page } = launched
  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resizeWindow(launched, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      // Nothing overflows at any size: the page does not scroll sideways.
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
const updates = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.clientUpdates ?? []).map(update => [update.id, `${update.state} ${update.installed}`]))
})

test('a host’s client updates show on its tiles and run there, one at a time, carrying on past a failure', async () => {
  test.setTimeout(300_000)
  const profile = await mkdtemp(join(tmpdir(), 'sotto-e2e-host-client-updates-'))
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host', 'host')
  await build({ configFile: false, logLevel: 'silent', define: { 'require.main': 'undefined' }, ssr: { noExternal: true },
    build: { ssr: resolve('tests/fixtures/e2eSshHost.ts'), target: 'node24', outDir: install, emptyOutDir: false,
      rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'index.js' } } } })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const steering = join(root, 'client-updates')
  await mkdir(steering, { recursive: true })
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_CLIENT_UPDATES_DIR', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'), SOTTO_E2E_CLIENT_UPDATES_DIR: steering,
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
    await expect.poll(() => updates(page), { timeout: 30_000 }).toEqual({ claude: 'idle 2.1.281', codex: 'idle 0.155.1', grok: 'idle 1.0.41' })

    // The chip beside Show providers counts what is behind, with the tiles closed.
    const row = page.getByRole('region', { name: 'forge', exact: true })
    const chip = row.getByRole('button', { name: /^Show the client updates on forge/u })
    await expect(chip).toHaveText('3 updates')
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
    const show = row.getByRole('button', { name: 'Show providers on forge' })
    await show.click()
    const grid = row.getByRole('list', { name: 'Providers on forge' })
    const tile = (name: string) => grid.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(tile('Codex')).toContainText('0.158.0 available')
    await expect(tile('Grok Build')).toContainText('1.0.43 available')
    await expect(tile('Devin')).toContainText('Not installed')
    await capture(launched, 'tiles-behind', async () => {
      await grid.scrollIntoViewIfNeeded()
      await expect(tile('Codex').getByRole('button', { name: 'Update Codex on forge to 0.158.0' })).toBeVisible()
    })

    // A tile's Update runs that client's update on forge, and the tile says when it is done.
    await tile('Claude Code').getByRole('button', { name: 'Update Claude Code on forge to 2.1.284' }).click()
    await expect(tile('Claude Code')).toContainText('Claude Code is now 2.1.284.', { timeout: 30_000 })
    await expect(chip).toHaveText('2 updates')

    // Update all from the chip: Enter opens it with focus on Update all. Codex's download drops, Grok Build is held at step 2.
    await writeFile(join(steering, 'codex.fail'), '')
    await writeFile(join(steering, 'grok.hold'), '')
    await chip.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Client updates on forge' })
    /** The popover open beside its chip and wholly inside the window, whatever size the window has just become. */
    const openPanel = async (): Promise<void> => {
      await chip.scrollIntoViewIfNeeded()
      if (!await panel.isVisible()) await chip.click()
      await expect(panel).toBeVisible()
      await expect.poll(() => inside(panel)).toBe(true)
    }
    const all = panel.getByRole('button', { name: 'Update Codex and Grok Build on forge, one after another' })
    await expect(all).toBeFocused()
    await capture(launched, 'popover', async () => {
      await openPanel()
    })
    await openPanel()
    await all.click()
    const grokRow = panel.getByRole('listitem').filter({ hasText: 'Grok Build' })
    await expect(grokRow).toContainText('Step 2 of 2', { timeout: 30_000 })
    await expect(chip).toHaveText('Updating 2 of 2')
    await expect(tile('Grok Build')).toContainText('Updating to 1.0.43 · step 2 of 2…')
    await capture(launched, 'updating', async () => {
      await openPanel()
      await expect(grokRow).toContainText('Step 2 of 2')
    })
    await rm(join(steering, 'grok.hold'))

    // Update all carried on past Codex, and says so, with Try again on its row.
    await openPanel()
    await expect(panel.getByRole('status')).toHaveText('Updated Claude Code and Grok Build on forge. Codex did not update.', { timeout: 30_000 })
    await expect(chip).toHaveText('1 did not update')
    const codexRow = panel.getByRole('listitem').filter({ hasText: 'Codex' })
    await expect(codexRow).toContainText('The download dropped partway. 0.155.1 is still installed.')
    await expect(tile('Codex')).toContainText('Did not update to 0.158.0')
    await expect.poll(() => updates(page)).toEqual({ claude: 'updated 2.1.284', codex: 'failed 0.155.1', grok: 'updated 1.0.43' })
    await capture(launched, 'one-failed', async () => {
      await openPanel()
    })
    // Escape closes it back onto the chip.
    await openPanel()
    await panel.getByRole('button', { name: 'Try updating Codex on forge again' }).focus()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(chip).toBeFocused()

    // The failed tile keeps one line; Details has the rest, the command to run by hand, and what mise printed.
    await tile('Codex').getByText('Details').click()
    await expect(tile('Codex')).toContainText('Or run this on forge:')
    await expect(tile('Codex').locator('code')).toHaveText('mise upgrade codex')
    await tile('Codex').getByText('What mise printed').click()
    await expect(tile('Codex')).toContainText('mise ERROR …: exit status 1')
    await expect(tile('Codex')).toContainText('…: The process cannot access the file. connection reset by peer')
    await expect(tile('Codex')).not.toContainText('John Smith')
    await capture(launched, 'failed-tile', async () => {
      await tile('Codex').scrollIntoViewIfNeeded()
      await tile('Codex').locator('pre').evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(tile('Codex')).toContainText('…: The process cannot access the file. connection reset by peer')
      await expect(tile('Codex')).not.toContainText('John Smith')
    })

    // Try again on Codex's row finishes it; Done puts the chip away and focus goes back to Show providers.
    await chip.click()
    await panel.getByRole('button', { name: 'Try updating Codex on forge again' }).click()
    await expect(panel.getByRole('status')).toHaveText('Updated 3 clients on forge.', { timeout: 30_000 })
    await expect(chip).toHaveText('3 updated')
    await panel.getByRole('button', { name: 'Done' }).click()
    await expect(chip).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'Hide providers on forge' })).toBeFocused()
    await expect(tile('Codex')).not.toContainText('available')
    await expect.poll(() => updates(page)).toEqual({ claude: 'updated 2.1.284', codex: 'updated 0.158.0', grok: 'updated 1.0.43' })
    await writeFile(test.info().outputPath('client-updates.json'), JSON.stringify({ updates: await updates(page) }, null, 2))
    expect(errors).toEqual([])
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
