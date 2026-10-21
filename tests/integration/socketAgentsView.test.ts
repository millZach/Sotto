// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { HostThreadDelegations } from '../../src/shared/agentsView'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

/** The fixture host's own service, with the Agents view turned on or off as its Owl answer would. */
function agentsHost(on: boolean, read: (threadId: string) => HostThreadDelegations, provider: (threadId: string) => 'codex' | 'opencode' = () => 'codex'): HostService {
  const base = fixture.host.service
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    threadProvider: provider,
    ...on ? { supportsAgentsView: true, threadDelegations: async (threadId: string) => read(threadId) } : {},
  }
}

async function phoneOn(service: HostService) {
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
  const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  return { server, phone }
}

describe('the iPhone’s Agents view over the socket (ADR-0101)', () => {
  it('is offered where the Owl answer turns it on, and answers a thread’s delegated threads without naming one the phone is not sent', async () => {
    const asked: string[] = []
    const service = agentsHost(true, threadId => {
      asked.push(threadId)
      return { threadId, threads: [
        { thread: 'review', by: threadId, work: 'code-review', outcome: 'working', startedAt: '2026-10-21T10:00:00.000Z', waiting: true, brief: 'Review the login fix.' },
        { thread: 'held', by: threadId, work: 'research', outcome: 'answered', waiting: false },
      ] }
    }, threadId => threadId === 'held' ? 'opencode' : 'codex')
    const { server, phone } = await phoneOn(service)
    try {
      expect(server.descriptor.features).toContain('agents-view')
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('agents-view')
      const answer = await phone.call('read', { op: 'thread-delegations', threadId: 'owner' })
      // An OpenCode thread is hidden from a phone that does not accept its provider (#1107), so its row is too.
      expect(answer).toMatchObject({ ok: true, result: { threadId: 'owner', threads: [{ thread: 'review', by: 'owner', outcome: 'working', brief: 'Review the login fix.' }] } })
      expect((answer as { result: { threads: unknown[] } }).result.threads).toHaveLength(1)
      expect(asked).toEqual(['owner'])
      // A thread the phone is not sent is not read for it at all.
      expect(await phone.call('hidden', { op: 'thread-delegations', threadId: 'held' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(asked).toEqual(['owner'])
    } finally { phone.frames.close(); await server.close() }
  })

  it('is neither offered nor answered on stable, and says the host is unavailable when the read fails', async () => {
    const off = await phoneOn(agentsHost(false, threadId => ({ threadId, threads: [] })))
    try {
      expect(off.server.descriptor.features).not.toContain('agents-view')
      await off.phone.call('hello', { op: 'hello' })
      expect(await off.phone.call('read', { op: 'thread-delegations', threadId: 'owner' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { off.phone.frames.close(); await off.server.close() }
    const failing = await phoneOn(agentsHost(true, () => { throw new Error('private detail') }))
    try {
      await failing.phone.call('hello', { op: 'hello' })
      const answer = await failing.phone.call('read', { op: 'thread-delegations', threadId: 'owner' })
      expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable' } })
      expect(JSON.stringify(answer)).not.toContain('private detail')
    } finally { failing.phone.frames.close(); await failing.server.close() }
  })
})
