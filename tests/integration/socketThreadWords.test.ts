// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentThreadWords } from '../../src/shared/threadWords'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const found: AgentThreadWords = { found: [
  { threadId: 'boiler', messageId: 'a0', role: 'assistant', quote: 'The purge runs 90 s before the pilot.', more: 1 },
  { threadId: 'opencode-thread', messageId: 'u0', role: 'user', quote: 'Purge the cache too.', more: 0 },
] }

/** A host whose store answers Search threads' read; `opencode-thread` is one a client that does not accept OpenCode may not be sent. */
async function wordsHost(options: { admin?: boolean; reads?: boolean } = {}) {
  const read = vi.fn(async (query: string) => query === 'purge' ? found : { found: [] })
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadProvider: id => id === 'opencode-thread' ? 'opencode' : 'codex',
    threadDetail: () => null,
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    ...(options.reads === false ? {} : { threadWords: read }),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, ...(options.admin === false ? { admin: false } : {}) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Words')
  const peer = () => rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  const desktop = async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
    await client.connect(); return client
  }
  return { server, peer, desktop, read }
}

describe('Search threads’ words over the socket', () => {
  it('answers a desktop’s thread-words from the host’s store', async () => {
    const { server, desktop, read } = await wordsHost()
    const client = await desktop()
    try {
      expect(server.descriptor.features).toContain('thread-words')
      expect((await client.threadWords('purge'))?.found.map(match => match.threadId)).toEqual(['boiler', 'opencode-thread'])
      expect(read).toHaveBeenCalledExactlyOnceWith('purge')
    } finally { await client.close(); await server.close() }
  })

  it('answers a phone on the desktop’s own phone listener, leaving out a thread it may not be sent', async () => {
    const { server, peer, read } = await wordsHost({ admin: false })
    const phone = await peer()
    try {
      // This phone's hello does not accept `provider-opencode`, so OpenCode's threads are hidden from it (#1107).
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      expect((hello.result as { features: string[] }).features).toContain('thread-words')
      expect(await phone.call('read', { op: 'thread-words', query: '  purge ' })).toMatchObject({ ok: true, result: { found: [{ threadId: 'boiler', quote: 'The purge runs 90 s before the pilot.', more: 1 }] } })
      expect((phone.messages.find(message => message.id === 'read') as { result: AgentThreadWords }).result.found).toHaveLength(1)
      // The same search again a moment later is answered from the same read of the store.
      await phone.call('again', { op: 'thread-words', query: 'purge' })
      expect(read).toHaveBeenCalledTimes(1)
      expect(await phone.call('empty', { op: 'thread-words', query: '   ' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { phone.frames.close(); await server.close() }
  })

  it('is not offered by a host whose store cannot answer, whose desktop reads null', async () => {
    const { server, desktop, peer } = await wordsHost({ reads: false })
    const client = await desktop()
    const raw = await peer()
    try {
      expect(server.descriptor.features).not.toContain('thread-words')
      expect(await client.threadWords('purge')).toBeNull()
      await raw.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      expect(await raw.call('read', { op: 'thread-words', query: 'purge' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { raw.frames.close(); await client.close(); await server.close() }
  })
})
