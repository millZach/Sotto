// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { DelegationsRead } from '../../src/shared/delegation'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const at = '2026-10-26T10:00:00.000Z'
const delegated = (thread: string) => ({ id: randomUUID(), thread, action: 'start' as const, work: 'code-review' as const, rootUserMessageId: 'root', anchorMessageId: 'anchor',
  briefMessageId: 'brief', outcome: 'working' as const, told: false, createdAt: at, waiting: true })

/** The fixture host's service with delegation views (#1310), whose OpenCode threads a peer that does not know OpenCode is not sent. */
function delegatingHost(read: (threadId: string) => DelegationsRead): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    threadProvider: threadId => threadId.startsWith('opencode') ? 'opencode' : 'codex',
    supportsDelegationViews: true, delegationViews: async (threadId: string) => read(threadId),
  }
}

describe('a desktop reading a remote thread\u2019s delegations (#1310)', () => {
  it('is not named a delegated thread it is not sent, in what the thread delegated or what it was sent', async () => {
    const known = new Set<string>()
    const desktops = { has: (clientId: string) => known.has(clientId), refresh: async () => undefined }
    const server = await startSocketServer({ service: delegatingHost(threadId => ({ threadId,
      delegations: [delegated('review'), delegated('opencode-child')],
      received: [delegated('opencode-parent')] })), pairing: fixture.host.pairing, watcherDesktops: desktops })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      // A hello that does not accept OpenCode: the host hides that provider's threads from this peer.
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['delegation-views'] }) as { result: { features: string[] } }
      expect(hello).toMatchObject({ ok: true })
      expect(hello.result.features).toContain('delegation-views')
      const answer = await desktop.call('read', { op: 'delegation-views', threadId: 'owner' }) as { ok: boolean, result: DelegationsRead }
      expect(answer.ok).toBe(true)
      expect(answer.result.delegations.map(row => row.thread)).toEqual(['review'])
      expect(answer.result.received).toEqual([])
    } finally { desktop.frames.close(); await server.close() }
  })
})
