// @vitest-environment node
// Shared spending for a Meshy account (ADR-0205, the Meshy plan's ticket 6): one monthly limit wherever the account is.
// A recorded desktop and a host holding its copy tell each other what they spent, over the host's real socket listener.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { monthOf } from '../../src/main/plugins/spending'
import { PluginSpendingSync } from '../../src/main/plugins/spendingSync'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import type { SpendingReport } from '../../src/shared/pluginAccountCopies'
import type { PluginAccount } from '../../src/shared/plugins'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { holding } from '../fixtures/heldOwlFeatures'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const STUDIO: PluginAccount = { id: '44444444-4444-4444-8444-000000000001', plugin: 'meshy', name: 'Studio', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 1_000 } }
const MONTH = monthOf(new Date())
const SESSION = '66666666-6666-4666-8666-000000000001'
const report = (credits: number, revision = 1): SpendingReport => ({ accountId: STUDIO.id, month: MONTH, credits, session: SESSION, revision })

/** The fixture host's service, sharing spending as \`share\` says, or keeping no copies at all. */
function spendingHost(share: { told: { reports: readonly SpendingReport[]; clientId: string }[]; own: number; reading?: Promise<void> }, listeners: Set<() => void>, keeps = true): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    supportsPluginAccountCopies: keeps, supportsPluginMeshySpending: keeps,
    sharePluginMeshySpending: async (reports, client) => { share.told.push({ reports, clientId: client!.clientId }); return [report(share.own)] },
    pluginMeshySpending: async () => { await share.reading; return [report(share.own, 2)] },
    subscribePluginMeshySpending: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
const pushes = (messages: readonly Record<string, unknown>[]) => messages.filter(message => message.event === 'plugin-meshy-spending').map(message => message.reports)

describe('shared spending over a host’s listener', () => {
  it('keeps what a recorded desktop says and answers with the host’s own, and pushes the host’s own on change to a desktop that accepted it', async () => {
    const share = { told: [] as { reports: readonly SpendingReport[]; clientId: string }[], own: 0 }
    const listeners = new Set<() => void>()
    const known = new Set<string>()
    const server = await startSocketServer({ service: spendingHost(share, listeners), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const quietPaired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
    known.add(paired.clientId); known.add(quietPaired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    const older = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(quietPaired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-spending'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('plugin-meshy-spending')
      // A desktop from before shared spending accepts nothing of it.
      await older.call('hello', { op: 'hello', accepts: [] })
      const answer = await desktop.call('request', { op: 'plugin-meshy-spending', reports: [report(30)] }) as { result: unknown }
      expect(answer.result).toEqual([report(0)])
      expect(share.told).toEqual([{ reports: [report(30)], clientId: paired.clientId }])
      share.own = 60
      for (const listener of listeners) listener()
      await expect.poll(() => pushes(desktop.messages).length).toBe(1)
      expect(pushes(desktop.messages)[0]).toEqual([report(60, 2)])
      await older.call('shell', { op: 'shell' })
      expect(pushes(older.messages)).toEqual([])
    } finally { desktop.frames.close(); older.frames.close(); await server.close() }
  })

  it('pushes nothing read for a desktop whose hello took shared spending back while the read ran', async () => {
    // Sol's review: the count is read, a second hello withdraws the feature, and then the read ends.
    let release!: () => void
    const share = { told: [] as { reports: readonly SpendingReport[]; clientId: string }[], own: 60, reading: new Promise<void>(resolve => { release = resolve }) }
    const listeners = new Set<() => void>()
    const known = new Set<string>()
    const server = await startSocketServer({ service: spendingHost(share, listeners), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-spending'] })
      await desktop.call('shell-1', { op: 'shell' })
      // While it is accepted, a read that ends is pushed.
      for (const listener of listeners) listener()
      release()
      await expect.poll(() => pushes(desktop.messages).length).toBe(1)
      share.reading = new Promise<void>(resolve => { release = resolve })
      for (const listener of listeners) listener()
      await desktop.call('hello-again', { op: 'hello', accepts: [] })
      release()
      await share.reading
      await desktop.call('shell-2', { op: 'shell' })
      await desktop.call('shell-3', { op: 'shell' })
      expect(pushes(desktop.messages)).toHaveLength(1)
    } finally { desktop.frames.close(); await server.close() }
  })

  it('offers it to no client the launch script did not record, and not at all on a host that keeps no copies', async () => {
    const share = { told: [] as { reports: readonly SpendingReport[]; clientId: string }[], own: 0 }
    const known = new Set<string>()
    const server = await startSocketServer({ service: spendingHost(share, new Set()), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const phone = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const stranger = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    const none = await startSocketServer({ service: spendingHost(share, new Set(), false), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => true, refresh: async () => undefined } })
    const plain = await rawPeer(none.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    try {
      const refused = await stranger.call('hello', { op: 'hello', accepts: ['plugin-meshy-spending'] }) as { result: { features: string[] } }
      expect(refused.result.features).not.toContain('plugin-meshy-spending')
      const turnedAway = await stranger.call('request', { op: 'plugin-meshy-spending', reports: [] }) as { error?: { code: string } }
      expect(turnedAway.error?.code).toBe('invalid_request')
      const without = await plain.call('hello', { op: 'hello', accepts: ['plugin-meshy-spending'] }) as { result: { features: string[] } }
      expect(without.result.features).not.toContain('plugin-meshy-spending')
      expect(share.told).toEqual([])
    } finally { stranger.frames.close(); plain.frames.close(); await server.close(); await none.close() }
  })
})

describe('shared spending between a desktop and a real headless host', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  async function connected(version: string, owlFeatures?: ReturnType<typeof holding>) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-meshy-spending-host-'))
    const keyFile = join(root, 'host.key')
    await writeFile(keyFile, 'made-up-host-key-of-enough-length')
    const data = join(root, 'data')
    const host = await startFixtureHeadlessHost({ dataDirectory: data, port: 0, sottoVersion: version, keyFile, ...owlFeatures ? { owlFeatures } : {} })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId })
    const desktopData = await mkdtemp(join(tmpdir(), 'sotto-meshy-spending-desktop-'))
    cleanups.push(async () => {
      await socket.close(); await host.close()
      for (const made of [root, desktopData]) if (dirname(made) === tmpdir() && made.includes('sotto-meshy-spending-')) await rm(made, { recursive: true, force: true })
    })
    await socket.connect()
    const target = { hostId: pairing.hostId, kind: 'remote' as const, service: socket }
    const spending = new PluginSpendingSync(desktopData, { plugin: 'meshy', own: async () => new Map([[STUDIO.id, 30]]), accounts: async () => [STUDIO], connections: () => [target] })
    cleanups.push(async () => { spending.close() })
    return { socket, spending, target, data, pairing }
  }

  it('tells the host what the desktop spent once its copy is there, and hears the host’s own count back', async () => {
    const c = await connected('0.1.38-owl.20261013.1')
    expect(c.socket.supportsPluginMeshySpending).toBe(true)
    await expect(c.socket.keepPluginAccountCopy({ account: STUDIO, secret: 'msy_made_up_key_0123456789' })).resolves.toMatchObject({ kept: true })
    c.spending.connected(c.target)
    await c.spending.idle()
    const kept = JSON.parse(await readFile(join(c.data, 'plugin-meshy-spending.json'), 'utf8')) as { heard: Record<string, Record<string, { credits: number }>> }
    expect(kept.heard[c.pairing.clientId]?.[STUDIO.id]?.credits).toBe(30)
    await expect(c.spending.reportedBy(STUDIO.id)).resolves.toEqual([c.pairing.hostId])
    await expect(c.spending.monthTotal(STUDIO.id)).resolves.toBe(30)
  })

  it('tells a host that holds Plugins nothing, which lists no shared spending', async () => {
    const c = await connected('0.1.38', holding('plugins'))
    expect(c.socket.supportsPluginMeshySpending).toBe(false)
    c.spending.connected(c.target)
    await c.spending.idle()
    await expect(readFile(join(c.data, 'plugin-meshy-spending.json'), 'utf8')).rejects.toThrow()
    await expect(c.spending.reportedBy(STUDIO.id)).resolves.toEqual([])
  })
})
