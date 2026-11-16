// @vitest-environment node
// Shared spending for an ElevenLabs account (the plugins plan's slice 12, part 4a): one monthly limit wherever the
// account is, in whole cents. A recorded desktop and a host holding its copy tell each other what they spent, over the
// host's real socket listener, as they do for Meshy.
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
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const VOICES: PluginAccount = { id: '55555555-5555-4555-8555-000000000001', plugin: 'elevenlabs', name: 'Voices', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 10 } }
const MONTH = monthOf(new Date())
const SESSION = '66666666-6666-4666-8666-000000000001'
const report = (cents: number, revision = 1): SpendingReport => ({ accountId: VOICES.id, month: MONTH, credits: cents, session: SESSION, revision })

/** The fixture host's service, sharing ElevenLabs spending as `share` says, keeping copies as `keeps` says. */
function spendingHost(share: { told: { reports: readonly SpendingReport[]; clientId: string }[]; own: number }, listeners: Set<() => void>, keeps = { copies: true, spending: true }): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    supportsPluginAccountCopies: keeps.copies, supportsPluginElevenLabsSpending: keeps.spending,
    sharePluginElevenLabsSpending: async (reports, client) => { share.told.push({ reports, clientId: client!.clientId }); return [report(share.own)] },
    pluginElevenLabsSpending: async () => [report(share.own, 2)],
    subscribePluginElevenLabsSpending: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
const pushes = (messages: readonly Record<string, unknown>[], event = 'plugin-elevenlabs-spending') => messages.filter(message => message.event === event).map(message => message.reports)

describe('ElevenLabs shared spending over a host’s listener', () => {
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
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-spending'] }) as { result: { features: string[] } }
      expect(hello.result.features).toEqual(expect.arrayContaining(['plugin-elevenlabs-copies', 'plugin-elevenlabs-spending']))
      // This host shares no Meshy spending.
      expect(hello.result.features).not.toContain('plugin-meshy-spending')
      await older.call('hello', { op: 'hello', accepts: [] })
      const answer = await desktop.call('request', { op: 'plugin-elevenlabs-spending', reports: [report(30)] }) as { result: unknown }
      expect(answer.result).toEqual([report(0)])
      expect(share.told).toEqual([{ reports: [report(30)], clientId: paired.clientId }])
      // Meshy's request is not this host's to answer.
      const meshy = await desktop.call('meshy', { op: 'plugin-meshy-spending', reports: [] }) as { error?: { code: string } }
      expect(meshy.error?.code).toBe('invalid_request')
      share.own = 60
      for (const listener of listeners) listener()
      await expect.poll(() => pushes(desktop.messages).length).toBe(1)
      expect(pushes(desktop.messages)[0]).toEqual([report(60, 2)])
      expect(pushes(desktop.messages, 'plugin-meshy-spending')).toEqual([])
      await older.call('shell', { op: 'shell' })
      expect(pushes(older.messages)).toEqual([])
    } finally { desktop.frames.close(); older.frames.close(); await server.close() }
  })

  it('offers it to no client the launch script did not record, nor without copies, nor where the host counts none of its own', async () => {
    const share = { told: [] as { reports: readonly SpendingReport[]; clientId: string }[], own: 0 }
    const known = new Set<string>()
    const server = await startSocketServer({ service: spendingHost(share, new Set()), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const phone = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const stranger = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    const noCopies = await startSocketServer({ service: spendingHost(share, new Set(), { copies: false, spending: true }), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => true, refresh: async () => undefined } })
    const noCount = await startSocketServer({ service: spendingHost(share, new Set(), { copies: true, spending: false }), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => true, refresh: async () => undefined } })
    const plain = await rawPeer(noCopies.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    const counting = await rawPeer(noCount.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    try {
      const refused = await stranger.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-spending'] }) as { result: { features: string[] } }
      expect(refused.result.features).not.toContain('plugin-elevenlabs-spending')
      const turnedAway = await stranger.call('request', { op: 'plugin-elevenlabs-spending', reports: [] }) as { error?: { code: string } }
      expect(turnedAway.error?.code).toBe('invalid_request')
      const without = await plain.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-spending'] }) as { result: { features: string[] } }
      expect(without.result.features).not.toContain('plugin-elevenlabs-copies')
      expect(without.result.features).not.toContain('plugin-elevenlabs-spending')
      // Copies, but no count of its own: the copies are offered, and shared spending is not.
      const copiesOnly = await counting.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-spending'] }) as { result: { features: string[] } }
      expect(copiesOnly.result.features).toContain('plugin-elevenlabs-copies')
      expect(copiesOnly.result.features).not.toContain('plugin-elevenlabs-spending')
      expect(share.told).toEqual([])
    } finally { stranger.frames.close(); plain.frames.close(); counting.frames.close(); await server.close(); await noCopies.close(); await noCount.close() }
  })
})

describe('ElevenLabs shared spending between a desktop and a real headless host', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  async function connected(version: string) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-elevenlabs-spending-host-'))
    const keyFile = join(root, 'host.key')
    await writeFile(keyFile, 'made-up-host-key-of-enough-length')
    const data = join(root, 'data')
    const host = await startFixtureHeadlessHost({ dataDirectory: data, port: 0, sottoVersion: version, keyFile })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId })
    const desktopData = await mkdtemp(join(tmpdir(), 'sotto-elevenlabs-spending-desktop-'))
    cleanups.push(async () => {
      await socket.close(); await host.close()
      for (const made of [root, desktopData]) if (dirname(made) === tmpdir() && made.includes('sotto-elevenlabs-spending-')) await rm(made, { recursive: true, force: true })
    })
    await socket.connect()
    const target = { hostId: pairing.hostId, kind: 'remote' as const, service: socket }
    const spending = new PluginSpendingSync(desktopData, { plugin: 'elevenlabs', own: async () => new Map([[VOICES.id, 120]]), accounts: async () => [VOICES], connections: () => [target] })
    cleanups.push(async () => { spending.close() })
    return { socket, spending, target, data, pairing }
  }

  it('tells the host in cents what the desktop spent once its copy is there, and hears the host’s own count back', async () => {
    const c = await connected('0.1.38-owl.20261013.1')
    expect(c.socket.supportsPluginElevenLabsSpending).toBe(true)
    await expect(c.socket.keepPluginAccountCopy({ account: VOICES, secret: 'sk_made_up_elevenlabs_key_0123456789' })).resolves.toMatchObject({ kept: true })
    c.spending.connected(c.target)
    await c.spending.idle()
    const kept = JSON.parse(await readFile(join(c.data, 'plugin-elevenlabs-spending.json'), 'utf8')) as { heard: Record<string, Record<string, { credits: number }>> }
    expect(kept.heard[c.pairing.clientId]?.[VOICES.id]?.credits).toBe(120)
    await expect(c.spending.reportedBy(VOICES.id)).resolves.toEqual([c.pairing.hostId])
    await expect(c.spending.monthTotal(VOICES.id)).resolves.toBe(120)
  })

  it('tells a stable host nothing, which lists no shared spending', async () => {
    const c = await connected('0.1.38')
    expect(c.socket.supportsPluginElevenLabsSpending).toBe(false)
    c.spending.connected(c.target)
    await c.spending.idle()
    await expect(readFile(join(c.data, 'plugin-elevenlabs-spending.json'), 'utf8')).rejects.toThrow()
    await expect(c.spending.reportedBy(VOICES.id)).resolves.toEqual([])
  })
})
