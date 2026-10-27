// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { AgentCommand } from '../../src/shared/agents'
import type { AgentThreadPrompts } from '../../src/shared/threadPrompts'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const stored: AgentThreadPrompts = { prompts: [
  { id: 'u0', createdAt: '2026-10-24T09:00:00.000Z', text: 'Why does the pill flicker?', reply: { id: 'a0', text: 'Both hosts write the list in the same frame.' } },
  { id: 'u1', createdAt: '2026-10-24T09:05:00.000Z', text: 'Batch the writes.', attachments: 1 },
] }

/** A host whose store answers the scrubber's read for one thread; `opencode-thread` is one a client that does not accept OpenCode may not be sent. */
async function promptsHost(options: { admin?: boolean; reads?: boolean } = {}) {
  const read = vi.fn(async (threadId: string, beforeMessageId: string) => threadId === 'long' && beforeMessageId === 'u2' ? stored : { prompts: [] })
  const commands: AgentCommand[] = []
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadProvider: id => id === 'opencode-thread' ? 'opencode' : 'codex',
    threadDetail: () => null,
    command: (command, identity) => { commands.push(command); return fixture.host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    ...(options.reads === false ? {} : { threadPrompts: read }),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, ...(options.admin === false ? { admin: false } : {}) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Prompts')
  const peer = () => rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
  const desktop = async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
    await client.connect(); return client
  }
  return { server, peer, desktop, read, commands }
}

describe('the message scrubber’s prompts over the socket (ADR-0109)', () => {
  it('answers a desktop’s thread-prompts from the host’s store, and takes a window widened back to one', async () => {
    const { server, desktop, read, commands } = await promptsHost()
    const client = await desktop()
    try {
      expect(server.descriptor.features).toContain('thread-prompts')
      expect(await client.threadPrompts('long', 'u2')).toEqual(stored)
      expect(read).toHaveBeenCalledExactlyOnceWith('long', 'u2')
      expect(await client.threadPrompts('long', 'u0')).toEqual({ prompts: [] })
      await client.command({ type: 'load-earlier-messages', threadId: 'long', throughMessageId: 'u0' }, { clientId: 'desktop', user: '', transport: 'socket' })
      expect(commands).toContainEqual({ type: 'load-earlier-messages', threadId: 'long', throughMessageId: 'u0' })
    } finally { await client.close(); await server.close() }
  })

  it('refuses a thread the client may not be sent', async () => {
    const { server, peer, read } = await promptsHost()
    const desktop = await peer()
    try {
      // This desktop's hello does not accept `provider-opencode`, so OpenCode's threads are hidden from it (#1107).
      await desktop.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      expect(await desktop.call('hidden', { op: 'thread-prompts', threadId: 'opencode-thread', beforeMessageId: 'u2' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(read).not.toHaveBeenCalled()
    } finally { desktop.frames.close(); await server.close() }
  })

  it('is not offered by a host whose store cannot answer, whose desktop reads null', async () => {
    const { server, desktop, peer } = await promptsHost({ reads: false })
    const client = await desktop()
    const raw = await peer()
    try {
      expect(server.descriptor.features).not.toContain('thread-prompts')
      expect(await client.threadPrompts('long', 'u2')).toBeNull()
      await raw.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      expect(await raw.call('read', { op: 'thread-prompts', threadId: 'long', beforeMessageId: 'u2' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { raw.frames.close(); await client.close(); await server.close() }
  })

  it('is not offered by the desktop’s own phone listener', async () => {
    const { server, peer, read } = await promptsHost({ admin: false })
    const phone = await peer()
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      expect((hello.result as { features: string[] }).features).not.toContain('thread-prompts')
      expect(await phone.call('read', { op: 'thread-prompts', threadId: 'long', beforeMessageId: 'u2' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(read).not.toHaveBeenCalled()
    } finally { phone.frames.close(); await server.close() }
  })
})
