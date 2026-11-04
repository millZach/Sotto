import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { RemoteHostE2EConnection } from '../../src/main/e2e/remoteHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

// Real paired headless host -> socket -> desktop router -> transcript -> preload's host guard -> main. Only the OS
// browser activation is recorded. The setting is Sotto browser, the one in use when the owner's laptop showed the failure.
const evidence = evidenceDirectory('artifacts/thread-links-paired-host')
const PUBLIC = 'https://example.com/docs'
const TAILNET = 'https://forge.tail5728ca.ts.net/lonely-robot/'
const FAILING = 'https://fail.example/status'
// A thought's text is drawn by the same MessageContent, under the same ThreadWebLinks, as a reply's words.
const thought: AgentActivity = { id: 'remote-thought', turnId: 'turn', sequence: 0, kind: 'reasoning', status: 'completed', title: 'Thinking',
  text: `[Public page](${PUBLIC}), [tailnet page](${TAILNET}) and [failing page](${FAILING}).` }

test('a link in a paired host\'s thread opens in the system browser, and a real failure still offers Copy link', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-remote-links-' })).directory
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', webLinkDestination: 'embedded' }))
    const native = new E2EAgentHost()
    await native.initializeWorkingFolders(join(profile, 'working-folders', 'codex'))
    host = await startHeadlessHost({ dataDirectory: join(profile, 'remote-host'), port: 0, providers: { codex: native } })
    const url = `http://127.0.0.1:${host.descriptor!.port}`
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic laptop')
    await writeFile(join(profile, 'remote-hosts.json'), JSON.stringify([{ id: randomUUID(), name: 'Forge fixture', target: 'forge', identityFile: '',
      installPath: '/opt/sotto', dataDirectory: '/data/sotto', enabled: false, hostId: paired.hostId, clientId: paired.clientId }]))
    const setup = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await setup.connect()
    await setup.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await setup.command({ type: 'connect', provider: 'codex' })
    const nativeId = setup.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await setup.command({ type: 'rename-thread', threadId: nativeId, title: 'Forge links fixture' })
    await setup.close()
    native.event({ type: 'ready', threadId: 'workshop', text: 'Done.', status: 'idle', activities: [thought] })

    launched = await launchSotto('success', profile)
    const { app, page } = launched
    const opened = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { remoteLinksOpened: string[] }).remoteLinksOpened)
    await app.evaluate(({ shell }, failing) => {
      const state = globalThis as unknown as { remoteLinksOpened: string[] }
      state.remoteLinksOpened = []
      shell.openExternal = async link => { if (link === failing) throw new Error('No browser.'); state.remoteLinksOpened.push(link) }
    }, FAILING)
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
    await app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Forge links fixture', exact: true }).click()
    const log = page.getByRole('log', { name: 'Thread transcript' })
    const row = log.getByRole('button', { name: /Thinking/u })
    await expect(log.locator('.thread-work__summary, .thread-activity__summary').first()).toBeVisible()
    if (!await row.isVisible()) await log.locator('.thread-work__summary, .thread-activity__summary').first().click()
    await row.click()

    await page.getByRole('link', { name: 'Public page', exact: true }).click()
    await expect.poll(opened).toEqual([PUBLIC])
    await page.getByRole('link', { name: 'tailnet page', exact: true }).click()
    await expect.poll(opened).toEqual([PUBLIC, TAILNET])
    await expect(page.getByText(/^Could not open/u)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(evidence, 'remote-thread-links-opened.png'), animations: 'disabled' })

    // Sotto's browser is on this computer, so that thread's menu does not offer it.
    await page.getByRole('link', { name: 'Public page', exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Open in system browser', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open in Sotto browser', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('link', { name: 'failing page', exact: true }).click()
    await expect(page.getByText('Could not open fail.example.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
    await page.screenshot({ path: join(evidence, 'remote-thread-links-failed.png'), animations: 'disabled' })
    expect(await opened()).toEqual([PUBLIC, TAILNET])
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
    await removeOwnedE2EProfile(profile)
  }
})
