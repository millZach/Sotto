// @vitest-environment node
// #1312, fourth part: a host sends its own check queue to a recorded desktop's window, and to nothing else.
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { CheckQueueEntry } from '../../src/shared/checkQueue'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

/**
 * The fixture host's service with a check queue. A thread's provider is looked up among the threads the host holds, as the
 * real service does, so a waiting check's thread, not made yet, has none (Sol's review of #1678).
 */
function queueingHost(queue: { checks: readonly CheckQueueEntry[] }, listeners: Set<() => void>, keeps = true): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    threadProvider: threadId => base.shell().host.threads.find(thread => thread.id === threadId)?.providerId,
    supportsCheckQueueViews: keeps, checkQueue: () => queue.checks,
    subscribeCheckQueue: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

const pushes = (messages: readonly Record<string, unknown>[]) => messages.filter(message => message.event === 'check-queue').map(message => message.checks)

describe('a host’s check queue in the desktop’s window (#1312)', () => {
  it('pushes the queue after a recorded desktop’s hello and on each change, naming no thread that desktop is not sent', async () => {
    const queue: { checks: readonly CheckQueueEntry[] } = { checks: [
      { id: 'running', whose: 'watcher', thread: 'capture', title: 'Omarchy capture check' },
      // An OpenCode check waiting its turn: its thread is not made yet, so only the check says its provider.
      { id: 'waiting', whose: 'thread', thread: 'opencode-child', by: 'parent', title: 'Linux journeys', work: 'building', provider: 'opencode' },
    ] }
    const listeners = new Set<() => void>()
    const known = new Set<string>()
    const server = await startSocketServer({ service: queueingHost(queue, listeners), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['check-queue-views'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('check-queue-views')
      await expect.poll(() => pushes(desktop.messages).length).toBe(1)
      // A check on OpenCode is hidden from a peer that does not know OpenCode, though its thread is not made yet: it keeps
      // its place, with no thread, title or provider.
      expect(pushes(desktop.messages)[0]).toEqual([{ id: 'running', whose: 'watcher', thread: 'capture', title: 'Omarchy capture check' }, { id: 'waiting', whose: 'thread' }])
      queue.checks = [queue.checks[1]!]
      for (const listener of listeners) listener()
      await expect.poll(() => pushes(desktop.messages).length).toBe(2)
      expect(pushes(desktop.messages)[1]).toEqual([{ id: 'waiting', whose: 'thread' }])
    } finally { desktop.frames.close(); await server.close() }
  })

  it('offers it to no client the launch script did not record as a desktop, and pushes nothing to a desktop that did not accept it', async () => {
    const listeners = new Set<() => void>()
    const known = new Set<string>()
    const server = await startSocketServer({ service: queueingHost({ checks: [{ id: 'running', whose: 'watcher' }] }, listeners), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const phone = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const desktop = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(desktop.clientId)
    const stranger = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phone.clientId))
    const quiet = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(desktop.clientId))
    try {
      const refused = await stranger.call('hello', { op: 'hello', accepts: ['check-queue-views'] }) as { result: { features: string[] } }
      expect(refused.result.features).not.toContain('check-queue-views')
      const plain = await quiet.call('hello', { op: 'hello', accepts: [] }) as { result: { features: string[] } }
      expect(plain.result.features).toContain('check-queue-views')
      for (const listener of listeners) listener()
      await quiet.call('shell', { op: 'shell' })
      expect(pushes(stranger.messages)).toEqual([])
      expect(pushes(quiet.messages)).toEqual([])
    } finally { stranger.frames.close(); quiet.frames.close(); await server.close() }
  })

  it('is not listed by a host that keeps no queue, as a stable host keeps none', async () => {
    const known = new Set<string>()
    const server = await startSocketServer({ service: queueingHost({ checks: [] }, new Set(), false), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['check-queue-views'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('check-queue-views')
      await desktop.call('shell', { op: 'shell' })
      expect(pushes(desktop.messages)).toEqual([])
    } finally { desktop.frames.close(); await server.close() }
  })
})
