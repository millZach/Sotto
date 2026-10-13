import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { evidenceDirectory } from '../fixtures/evidence'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Update all (ADR-0077) in the built app, on the Owl track, over a scripted ssh that runs the real launch script and a
 * real headless host whose clients are forge's on September 29 (tests/fixtures/clientUpdateProviders.ts): Claude Code,
 * Codex and Grok Build installed by mise and all behind. The corner card lists them under forge and takes the host update
 * pill's and the client update card's place; one press updates all three on forge, one at a time, carries on past
 * Codex's dropped download and says so, Try again finishes it, and Dismiss puts the card away. Sotto itself cannot update
 * in a development run, so the card never asks to restart here; the restart is covered by the window's unit tests.
 *
 *   npm run build && npx playwright test tests/e2e/update-all.spec.ts
 */
const evidence = evidenceDirectory('artifacts/update-all')
const updates = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.clientUpdates ?? []).map(update => [update.id, `${update.state} ${update.installed}`]))
})
/** Whether the card sits wholly inside the window, so nothing is clipped at the minimum size. */
const inside = (page: Page) => page.locator('.update-all').evaluate(element => {
  const box = element.getBoundingClientRect()
  return box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
})

test('Update all lists what is behind on every machine and updates it with one press', async () => {
  test.setTimeout(300_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-update-all-' })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  await buildSshHost(join(root, '~', '.local', 'share', 'sotto-host', 'host'))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const steering = join(root, 'client-updates')
  await mkdir(steering, { recursive: true })
  await mkdir(evidence, { recursive: true })
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD', 'SOTTO_E2E_CLIENT_UPDATES_DIR', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'), SOTTO_E2E_CLIENT_UPDATES_DIR: steering,
    HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    await onReleaseTrack('owl', async () => {
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

      // The card lists forge's three clients, from any page.
      await openThreads(page)
      const card = page.getByRole('region', { name: 'Updates' })
      await expect(card).toBeVisible()
      await expect(card).toContainText('3 clients')
      const forge = card.getByRole('region', { name: 'forge' })
      for (const name of ['Claude Code', 'Codex', 'Grok Build']) await expect(forge).toContainText(name)
      await expect(card).toContainText('0.155.1 → 0.158.0')
      await expect(card).toContainText('Threads keep working while clients update.')
      // It takes the client update card's and the host update pill's place.
      await expect(page.locator('.client-updates')).toHaveCount(0)
      await expect(page.locator('.host-update')).toHaveCount(0)
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect.poll(() => inside(page)).toBe(true)
        await page.screenshot({ path: join(evidence, `offer-dark-${width}.png`), animations: 'disabled' })
      }
      await resizeWindow(launched, 1280, 800)

      // Folds into a pill, and back.
      await card.getByRole('button', { name: 'Fold updates into a button' }).click()
      const pill = page.getByRole('button', { name: 'Update all. Show updates' })
      await expect(pill).toBeFocused()
      await page.screenshot({ path: join(evidence, 'folded-dark-1280.png'), animations: 'disabled' })
      await page.keyboard.press('Enter')
      await expect(card).toBeVisible()

      // One press: Codex's download drops, Grok Build is held at its second step so the card can be seen updating.
      await writeFile(join(steering, 'codex.fail'), '')
      await writeFile(join(steering, 'grok.hold'), '')
      await card.getByRole('button', { name: 'Update all: 3 clients' }).click()
      await expect(card).toContainText(/Updating/u, { timeout: 30_000 })
      await expect(forge).toContainText('step 2 of 2', { timeout: 30_000 })
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
      await page.screenshot({ path: join(evidence, 'updating-light-1280.png'), animations: 'disabled' })
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await rm(join(steering, 'grok.hold'))

      // It carried on past Codex and says so, with Try again on its row.
      await expect(card.getByRole('heading', { level: 3, name: 'forge' })).toBeVisible()
      await expect(card).toContainText('Not everything updated', { timeout: 60_000 })
      await expect(card).toContainText('forge’s Codex did not update.')
      await expect.poll(() => updates(page)).toEqual({ claude: 'updated 2.1.284', codex: 'failed 0.155.1', grok: 'updated 1.0.43' })
      await page.screenshot({ path: join(evidence, 'one-failed-dark-1280.png'), animations: 'disabled' })
      await card.getByRole('button', { name: 'Try again to update Codex on forge' }).click()
      await expect(card).toContainText('Updated', { timeout: 60_000 })
      await expect(card).toContainText('Nothing needs a restart.')
      await expect.poll(() => updates(page)).toEqual({ claude: 'updated 2.1.284', codex: 'updated 0.158.0', grok: 'updated 1.0.43' })
      await card.getByRole('button', { name: 'Dismiss the results of Update all' }).click()
      await expect(card).toHaveCount(0)
      await writeFile(test.info().outputPath('update-all.json'), JSON.stringify({ updates: await updates(page) }, null, 2))
      expect(errors).toEqual([])
    })
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
