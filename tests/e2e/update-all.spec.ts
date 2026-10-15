import { buildSshHost } from './support/sshHost'
import { ownedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'
import { evidenceDirectory } from '../fixtures/evidence'
import { hostRelease, localArchiveName, releasesPage, sidecar, tarGz } from '../fixtures/hostArchive'
import { onReleaseTrack, OWL_E2E_VERSION } from './support/releaseTrack'
import { closeSotto, launchSotto, openPage, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/**
 * Update all (ADR-0077) in the built app, on the Owl track, over a scripted ssh that runs the real launch script and a
 * real headless host whose clients are forge's on September 29 (tests/fixtures/clientUpdateProviders.ts): Claude Code,
 * Codex and Grok Build installed by mise and all behind. The corner card lists them under forge and takes the host update
 * pill's and the client update card's place; one press updates all three on forge, one at a time, carries on past
 * Codex's dropped download and says so, Try again finishes it, and Dismiss puts the card away. Sotto itself cannot update
 * in a development run, so this first journey never asks to restart.
 *
 * The other two stand an update in for Sotto's own (SOTTO_E2E_APP_UPDATE), which downloads nothing and never installs, and
 * a releases page that publishes the host it brings. forge's host is listed at once, aimed at that version, and one
 * press updates forge's clients, then forge's host to it, before the card asks to restart (ADR-0077 decision 6).
 *
 *   npm run build && npx playwright test tests/e2e/update-all.spec.ts
 */
const evidence = evidenceDirectory('artifacts/update-all')
const updates = (page: Page) => page.evaluate(async () => {
  const state = await window.sotto!.agents!.get()
  return Object.fromEntries((state.host.clientHosts?.[0]?.clientUpdates ?? []).map(update => [update.id, `${update.state} ${update.installed}`]))
})
/** Each step's accessible name, in order: what it does and how it stands. */
const stepNames = (page: Page) => page.locator('.update-all__step').evaluateAll(steps => steps.map(step => step.getAttribute('aria-label') ?? ''))
/** The step names with forge's clients sorted, since the host lists its clients in its own order. */
const clientsSorted = (names: readonly string[], before: number, after: number): string[] =>
  [...names.slice(0, before), ...names.slice(before, names.length - after).sort(), ...names.slice(names.length - after)]
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
  const install = join(root, '~', '.local', 'share', 'sotto-host')
  await buildSshHost(join(install, 'host'))
  // This journey updates clients only. The real host reads its matching Owl version from its installation metadata.
  await writeFile(join(install, 'package.json'), `${JSON.stringify({ name: 'sotto-host', version: OWL_E2E_VERSION })}\n`)
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
      const hostState = await page.evaluate(() => window.sotto!.hosts!.get())
      expect(hostState.hosts).toHaveLength(1)
      expect(hostState.hosts[0]).toMatchObject({ name: 'forge', phase: 'connected', version: OWL_E2E_VERSION })
      expect(hostState.updates ?? []).toEqual([])

      // The card lists forge's three clients, from any page.
      await openThreads(page)
      const card = page.getByRole('region', { name: 'Updates' })
      await expect(card).toBeVisible()
      await expect(card).toContainText('3 clients')
      // Steps, in the order the press runs them; with no Sotto update there is no restart step.
      await expect.poll(async () => clientsSorted(await stepNames(page), 0, 0)).toEqual(['Update Claude Code, to do', 'Update Codex, to do', 'Update Grok Build, to do'])
      await expect(card.getByRole('listitem', { name: 'Update Codex, to do' })).toContainText('forge')
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
      await expect(card).toContainText('step 2 of 2', { timeout: 30_000 })
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
      await page.screenshot({ path: join(evidence, 'updating-light-1280.png'), animations: 'disabled' })
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      await rm(join(steering, 'grok.hold'))

      // It carried on past Codex and says so, with Try again on its row.
      await expect(card).toContainText('Not everything updated', { timeout: 60_000 })
      await expect(card.getByRole('listitem', { name: 'Update Codex, did not finish' })).toBeVisible()
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

/** The update Sotto is downloading in the next two journeys, the build after the one this run says it is. */
const PENDING = '0.1.37-owl.20261012.2'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
interface AheadRun { readonly launched: LaunchedSotto; readonly page: Page; readonly steering: string; readonly requests: readonly string[]; readonly forgeId: string }

/**
 * forge added over the scripted ssh, its host on this run's Owl version, and a releases page that publishes the host
 * Sotto's waiting update brings, for this machine, built from the same host as forge runs and saying it is PENDING.
 */
async function withForgeBehindTheUpdate(prefix: string, run: (forge: AheadRun) => Promise<void>): Promise<void> {
  const profile = (await ownedE2EProfile({ prefix })).directory
  const root = join(profile, 'ssh-root')
  await mkdir(join(root, '~', 'code'), { recursive: true })
  const install = join(root, '~', '.local', 'share', 'sotto-host')
  await buildSshHost(join(install, 'host'))
  await writeFile(join(install, 'package.json'), `${JSON.stringify({ name: 'sotto-host', version: OWL_E2E_VERSION })}\n`)
  const file = localArchiveName(PENDING)
  const archive = tarGz(hostRelease(PENDING, await readFile(join(install, 'host', 'index.js'), 'utf8'), { commonjs: true }))
  // Each answer is held back a little, so the host's download can be seen under way.
  const releases = await releasesPage(new Map<string, Uint8Array | string>([[`/v${PENDING}/${file}`, archive], [`/v${PENDING}/${file}.sha256`, sidecar(archive, file)]]), 1500)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on' }))
  const modeFile = join(root, 'mode')
  const steering = join(root, 'client-updates')
  await mkdir(steering, { recursive: true })
  await writeFile(modeFile, 'run')
  const keys = ['SOTTO_E2E_SSH_SCRIPT', 'SOTTO_E2E_SSH_EXECUTABLE', 'SOTTO_E2E_HOST_RELEASES_URL', 'SOTTO_E2E_APP_UPDATE', 'FAKE_SSH_MODE_FILE', 'FAKE_SSH_ROOT', 'FAKE_SSH_RECORD',
    'SOTTO_E2E_CLIENT_UPDATES_DIR', 'HOME', 'USERPROFILE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { SOTTO_E2E_SSH_SCRIPT: resolve('tests/fixtures/fakeSsh.mjs'), SOTTO_E2E_SSH_EXECUTABLE: process.execPath,
    SOTTO_E2E_HOST_RELEASES_URL: releases.url, SOTTO_E2E_APP_UPDATE: PENDING, FAKE_SSH_MODE_FILE: modeFile, FAKE_SSH_ROOT: root, FAKE_SSH_RECORD: join(root, 'ssh.jsonl'),
    SOTTO_E2E_CLIENT_UPDATES_DIR: steering, HOME: join(root, '~'), USERPROFILE: join(root, '~') })
  let launched: LaunchedSotto | undefined
  const errors: string[] = []
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      page.on('pageerror', error => errors.push(error.message))
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
      const hostState = await page.evaluate(() => window.sotto!.hosts!.get())
      expect(hostState.hosts[0]).toMatchObject({ name: 'forge', phase: 'connected', version: OWL_E2E_VERSION })
      // Nothing is behind this computer's own version, so no host update is offered before Sotto finds its own.
      expect(hostState.updates ?? []).toEqual([])
      await openThreads(page)
      await run({ launched, page, steering, requests: releases.requests, forgeId: hostState.hosts[0]!.id })
      // forge runs ahead of this computer until Sotto restarts, connected, and nothing asks to update Sotto here.
      const after = await page.evaluate(() => window.sotto!.hosts!.get())
      expect(after.hosts[0]).toMatchObject({ phase: 'connected', version: PENDING })
      expect(after.hosts[0]!.error ?? '').not.toContain('Update Sotto on this computer')
      await expect(page.getByText(/Update Sotto on this computer/u)).toHaveCount(0)
      expect(errors).toEqual([])
    })
  } finally {
    const descriptor = await readFile(join(root, '~', '.sotto', 'host-listener.json'), 'utf8').then(text => JSON.parse(text) as { pid?: number }, () => undefined)
    if (descriptor?.pid) { try { process.kill(descriptor.pid) } catch { /* already gone */ } }
    if (launched) await closeSotto(launched)
    await releases.close()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(requireOwnedE2EProfile(profile), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** Screenshots of the card at each size asked for, dark and light, checking that it sits inside the window at each. */
async function captureCard(launched: LaunchedSotto, name: string, sizes: readonly (readonly [number, number])[] = SIZES): Promise<void> {
  const { page } = launched
  for (const [width, height] of sizes) {
    await resizeWindow(launched, width, height)
    for (const appearance of width === 1280 ? ['dark', 'light'] as const : ['dark'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await expect.poll(() => inside(page)).toBe(true)
      await page.screenshot({ path: join(hostsEvidence, `${name}-${appearance}-${width}x${height}.png`), animations: 'disabled' })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}
const hostsEvidence = evidenceDirectory('artifacts/update-all-hosts-together')

test('Update all updates forge’s clients, then forge’s host to the version Sotto is downloading, then asks to restart', async () => {
  test.setTimeout(300_000)
  await mkdir(hostsEvidence, { recursive: true })
  await withForgeBehindTheUpdate('sotto-e2e-update-all-ahead-', async ({ launched, page, steering, requests }) => {
    // Sotto finds its own update: forge's host is listed at once, after forge's clients, aimed at that version.
    await page.evaluate(() => window.sotto!.checkForUpdates())
    const card = page.getByRole('region', { name: 'Updates' })
    await expect(card.getByRole('listitem', { name: 'Update forge’s host, to do' })).toBeVisible({ timeout: 30_000 })
    expect(clientsSorted(await stepNames(page), 1, 2)).toEqual(['Download Sotto Owl, to do', 'Update Claude Code, to do', 'Update Codex, to do', 'Update Grok Build, to do',
      'Update forge’s host, to do', 'Restart Sotto, comes last'])
    // Sotto's versions once, in the head; the host's own sentence once, in its step; nothing below repeats it.
    await expect(card).toContainText(`${OWL_E2E_VERSION} → ${PENDING}`)
    await expect(card.getByText('Restarts forge’s host, so its threads are unavailable for a few seconds.')).toHaveCount(1)
    await expect(card.locator('.update-all__notes')).toHaveText('Threads keep working while clients update.')
    await expect(card.getByRole('listitem', { name: 'Restart Sotto, comes last' })).toContainText('Last. Sotto asks before it restarts.')
    // The releases page was asked whether the host is published before it was offered.
    expect(requests.filter(path => path.startsWith(`/v${PENDING}/`)).some(path => path.endsWith('.sha256'))).toBe(true)
    await captureCard(launched, 'offer-clients')

    // One press. Grok Build is held at its second step, so the host can be seen waiting for forge's clients.
    await writeFile(join(steering, 'grok.hold'), '')
    await card.getByRole('button', { name: 'Update all: Sotto, 3 clients and forge' }).click()
    await expect(card.getByRole('listitem', { name: 'Update forge’s host, in progress' })).toContainText('Updates once forge’s clients have.', { timeout: 30_000 })
    await expect(card).toContainText('step 2 of 2', { timeout: 30_000 })
    await expect(card).toContainText(/\d of 6 done/u)
    await captureCard(launched, 'running-clients', [[1280, 800], [820, 560]])
    await rm(join(steering, 'grok.hold'))

    // Then forge's host, to the version Sotto is downloading; last, the restart.
    await expect(card.getByRole('listitem', { name: 'Restart Sotto, ready' })).toBeVisible({ timeout: 120_000 })
    await expect(card.getByRole('listitem', { name: 'Update forge’s host, done' })).toContainText(`forge runs Sotto host ${PENDING}.`)
    await expect(card.getByRole('listitem', { name: 'Restart Sotto, ready' })).toContainText(`Installs ${PENDING}.`)
    await expect(card.getByRole('button', { name: `Restart Sotto now and install ${PENDING}` })).toBeVisible()
    expect(clientsSorted(await stepNames(page), 1, 2)).toEqual(['Download Sotto Owl, done', 'Update Claude Code, done', 'Update Codex, done', 'Update Grok Build, done',
      'Update forge’s host, done', 'Restart Sotto, ready'])
    // forge's restart forgot what its update line ran; the clients it brought back are the new versions, and their steps stay done.
    await expect.poll(async () => Object.values(await updates(page)).map(value => value.split(' ')[1]).sort()).toEqual(['0.158.0', '1.0.43', '2.1.284'])
    await captureCard(launched, 'restart-clients')
  })
})

test('With every client current, Update all is Sotto’s download, forge’s host and the restart', async () => {
  test.setTimeout(300_000)
  await mkdir(hostsEvidence, { recursive: true })
  await withForgeBehindTheUpdate('sotto-e2e-update-all-host-', async ({ launched, page, forgeId }) => {
    // forge's clients are brought up to date first, from its own update line, so only Sotto and forge's host are behind.
    await page.evaluate(id => window.sotto!.hosts!.updateClients({ id, action: 'update', providers: ['claude', 'codex', 'grok'] }), forgeId)
    await expect.poll(() => updates(page), { timeout: 60_000 }).toEqual({ claude: 'updated 2.1.284', codex: 'updated 0.158.0', grok: 'updated 1.0.43' })
    await page.evaluate(() => window.sotto!.checkForUpdates())
    const card = page.getByRole('region', { name: 'Updates' })
    await expect.poll(() => stepNames(page), { timeout: 30_000 }).toEqual(['Download Sotto Owl, to do', 'Update forge’s host, to do', 'Restart Sotto, comes last'])
    await expect(card.locator('.update-all__notes')).toHaveCount(0)
    await captureCard(launched, 'offer-host')

    await card.getByRole('button', { name: 'Update all: Sotto and forge' }).click()
    // The releases page holds each answer back, so the host's download is seen under way.
    await expect(card.getByRole('listitem', { name: 'Update forge’s host, in progress' })).toContainText(/Step [12] of 4/u, { timeout: 30_000 })
    await captureCard(launched, 'running-host', [[1280, 800], [820, 560]])

    await expect(card.getByRole('listitem', { name: 'Restart Sotto, ready' })).toBeVisible({ timeout: 120_000 })
    expect(await stepNames(page)).toEqual(['Download Sotto Owl, done', 'Update forge’s host, done', 'Restart Sotto, ready'])
    await captureCard(launched, 'restart-host')
    // Later folds the card and keeps the download; forge keeps running ahead until Sotto restarts.
    await card.getByRole('button', { name: /^Later/u }).click()
    await expect(page.getByRole('button', { name: 'Restart to finish. Show updates' })).toBeFocused()
  })
})
