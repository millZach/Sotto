import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { findBrowser } from '../../src/host/browser/findBrowser'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { OWL_E2E_VERSION, onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow, toggleTools } from './support/sottoLaunch'

// A thread on a paired host browses in the host's own Chromium, and this computer shows its page from pictures (ADR-0198).
// It needs Chrome, Chromium or Edge where the test runs, which plays the host; forge has Chromium.
const SHOTS = evidenceDirectory('artifacts/paired-host-browser')
const SIGN_IN = `<!doctype html><title>Sign in</title><body style="margin:0;font:16px sans-serif;background:#fafafa">
  <h1 style="margin:20px">Sign in</h1>
  <input id="email" placeholder="Email" style="position:absolute;left:20px;top:100px;width:240px;height:32px" oninput="document.title='Typed ' + this.value">
  <button style="position:absolute;left:20px;top:150px;width:120px;height:36px">Sign in</button></body>`

test('a thread on a paired host browses in the host\'s Chromium, shown and driven from Tools and the player', async () => {
  test.skip(!await findBrowser(), 'No Chrome, Chromium or Edge here to play the host\'s browser.')
  test.setTimeout(240_000)
  await mkdir(SHOTS, { recursive: true })
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(SIGN_IN) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const signIn = `http://localhost:${(server.address() as AddressInfo).port}/`
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-host-browser-' })).directory
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
  try {
    await onReleaseTrack('owl', async () => {
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', appearance: 'dark' }))
      const native = new E2EAgentHost()
      await native.initializeWorkingFolders(join(profile, 'working-folders', 'codex'))
      host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native }, sottoVersion: OWL_E2E_VERSION })
      const url = `http://127.0.0.1:${host.descriptor!.port}`
      const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
      await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '',
        installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
      const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false, clientVersion: OWL_E2E_VERSION })
      await setup.connect()
      await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
      await setup.command({ type: 'connect', provider: 'codex' })
      const thread = setup.shell().host.threads.find(item => item.title === 'Workshop')!
      await setup.command({ type: 'rename-thread', threadId: thread.id, title: 'Check the sign-in page' })
      await setup.close()
      // The host gave its threads Sotto's browser tools; the agent's call is made here as its provider would make it, by
      // the provider's own session (`workshop`), which the host turns into its thread.
      expect(native.browserTools?.definitions.map(tool => tool.name)).toEqual(['browser_pages', 'browser_open', 'browser_start', 'browser_action', 'browser_status', 'browser_finish'])

      launched = await launchSotto('success', profile)
      const { app, page } = launched
      const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
      await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
      await resizeWindow(launched, 1280, 800)
      await openThreads(page)
      await page.getByRole('button', { name: 'Check the sign-in page', exact: true }).click()

      // The agent opens its dev server, which is the host's own localhost; with the setting on it runs without asking.
      const opened = await native.browserTools!.call('workshop', 'browser_open', { url: signIn, description: 'Check the sign-in page' })
      expect(opened.isError).toBeUndefined()
      expect(JSON.parse((opened.content[0] as { text: string }).text)).toMatchObject({ approvalRequired: false })

      await toggleTools(page)
      const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
      await panel.getByRole('tab', { name: 'Browser' }).click()
      // Named after the page's title, which the user's typing changes below.
      const picture = panel.getByRole('application', { name: /^Page: /u })
      await expect(panel.getByRole('application', { name: 'Page: Sign in' })).toBeVisible()
      await expect(picture.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/u, { timeout: 30_000 })
      await expect(panel.getByTitle('This page runs on Forge')).toHaveText('on Forge')
      await expect(panel.getByRole('button', { name: 'Point at something' })).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Screenshot to message' })).toHaveCount(0)
      await page.screenshot({ path: join(SHOTS, 'pane-dark-1280.png'), animations: 'disabled' })

      // The user's own click and typing go to the page on the host, and its title comes back in the row.
      const box = (await picture.boundingBox())!
      await page.mouse.click(box.x + 80, box.y + 116)
      await expect(picture).toBeFocused()
      await page.keyboard.type('forge')
      await expect(panel.locator('.browser-pane__title')).toHaveText('Typed forge', { timeout: 15_000 })
      // The agent reads the same page the user typed into.
      const pages = JSON.parse(((await native.browserTools!.call('workshop', 'browser_pages', {})).content[0] as { text: string }).text) as { pages: { title?: string }[] }
      expect(pages.pages[0]?.title).toBe('Typed forge')
      await page.screenshot({ path: join(SHOTS, 'pane-typed-dark-1280.png'), animations: 'disabled' })

      // Light, and the smallest window.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
      await page.screenshot({ path: join(SHOTS, 'pane-light-1280.png'), animations: 'disabled' })
      await resizeWindow(launched, 820, 560)
      // The page lays out again at the smaller pane, and the next picture is drawn at its size.
      const fits = (): Promise<boolean> => picture.evaluate(element => element.querySelector('img')?.dataset.size === `${element.clientWidth}x${element.clientHeight}`)
      await expect.poll(fits, { timeout: 15_000 }).toBe(true)
      await page.screenshot({ path: join(SHOTS, 'pane-light-820.png'), animations: 'disabled' })
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

      // Float the browser over the thread: the player draws the host's page from its pictures too.
      await panel.getByRole('button', { name: 'More browser actions' }).click()
      await page.getByRole('menuitem', { name: 'Float the browser over the thread' }).click()
      const player = page.locator('.browser-player').getByRole('application', { name: 'Page: Typed forge' })
      await expect(player.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/u, { timeout: 30_000 })
      await page.screenshot({ path: join(SHOTS, 'player-dark-1280.png'), animations: 'disabled' })

      // The connection drops: the page stays open on the host, and the pane greys its last picture and says so.
      await app.evaluate(async (_, hostId) => { await globalThis.sottoRemoteHostE2E!.disconnect(hostId, true) }, paired.hostId)
      await toggleTools(page)
      await panel.getByRole('tab', { name: 'Browser' }).click()
      await expect(panel.getByText('Reconnecting to Forge. The page stays open there, and the agent keeps browsing.')).toBeVisible()
      await expect(panel.locator('.host-page[data-off] img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/u)
      await page.screenshot({ path: join(SHOTS, 'pane-reconnecting-dark-1280.png'), animations: 'disabled' })
      // And it comes back where it was.
      await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
      await expect(panel.getByText(/Reconnecting to Forge/u)).toHaveCount(0, { timeout: 30_000 })
      await expect(panel.getByRole('application', { name: 'Page: Typed forge' }).locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/u)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
    await new Promise(done => server.close(done))
    await removeOwnedE2EProfile(profile)
  }
})
