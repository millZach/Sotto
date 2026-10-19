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
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

// Real paired headless host -> socket (with activity-bodies) -> desktop router -> IPC -> activity row. The main-only,
// unpackaged harness bypasses SSH launch, never the remote protocol (ADR-0025, October 18 amendment).
const lines = Array.from({ length: 400 }, (_, index) => `ok ${String(index).padStart(3, '0')} remote thread opens on its prefix`).join('\n')
const build: AgentActivity = { id: 'remote-build', turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'Run the tests',
  command: 'npm test', output: lines, exitCode: 0, durationMs: 48_000 }

test('opens a remote row on the part its host sent and reads the rest from the host', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-remote-body-' })).directory
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  let launched: Awaited<ReturnType<typeof launchSotto>> | undefined
  try {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, localHostEnabled: false, reducedMotion: 'on', historyEnabled: false }))
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
    await setup.command({ type: 'rename-thread', threadId: nativeId, title: 'Forge body fixture' })
    await setup.close()
    native.event({ type: 'ready', threadId: 'workshop', text: 'The tests pass.', status: 'idle', activities: [build] })

    launched = await launchSotto('success', profile)
    const errors: string[] = []
    launched.page.on('pageerror', error => errors.push(error.message))
    const connection: RemoteHostE2EConnection = { url, token: paired.token, hostId: paired.hostId }
    await launched.app.evaluate(async (_, input) => { await globalThis.sottoRemoteHostE2E!.connect(input) }, connection)
    const { page } = launched
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Forge body fixture', exact: true }).click()
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.title === 'Forge body fixture')!.id)

    // The window holds the record cut: the end of the output, and its whole size.
    await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))?.activities?.find(record => record.id === 'remote-build')?.cut?.output, threadId))
      .toBe(Buffer.byteLength(lines))
    const held = await page.evaluate(async id => (await window.sotto!.agents!.threadDetail!(id))!.activities!.find(record => record.id === 'remote-build')!.output!, threadId)
    expect(held.length).toBeLessThan(2_049)
    expect(lines.endsWith(held)).toBe(true)

    const log = page.getByRole('log', { name: 'Thread transcript' })
    const row = log.getByRole('button', { name: /npm test/u })
    if (!await row.isVisible()) await log.locator('.thread-work__summary, .thread-activity__summary').first().click()
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(row).toBeFocused()
    // The whole output replaces the part, opened at its end, and Copy works.
    const block = log.getByLabel('output code block')
    await expect(block).toContainText('ok 000 remote thread opens on its prefix')
    await expect(block).toContainText('ok 399 remote thread opens on its prefix')
    await expect(log.getByRole('button', { name: 'Copy output code', exact: true })).toBeVisible()
    await expect(log.getByText(/earlier lines are on/u)).toHaveCount(0)
    expect(await block.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2)
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath('remote-body-loaded.png') })

    // Folded and opened again, it shows at once from what the window kept.
    await page.keyboard.press('Escape')
    await expect(block).toHaveCount(0)
    await row.press('Enter')
    await expect(log.getByLabel('output code block')).toContainText('ok 000 remote thread opens on its prefix')
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    await host?.close()
    await removeOwnedE2EProfile(profile)
  }
})
