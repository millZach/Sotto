// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import type { AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostPushSchema } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const at = '2026-11-21T09:00:00.000Z'
const first = { id: 'first', role: 'assistant' as const, text: 'The plan, in full', createdAt: at }
const later = { id: 'later', role: 'assistant' as const, text: 'Written after the read', createdAt: at }

/**
 * A host whose one thread's history the test sets, published whole the moment a client starts observing it, as the
 * coordinator publishes one, and a raw desktop of it.
 */
async function readHost() {
  const thread = { current: { threadId: 'clicked', revision: 1, messages: [first] } as AgentThreadDetail, emit: ((update: AgentThreadDetailUpdate) => { void update }) as (update: AgentThreadDetailUpdate) => void }
  const service: HostService = {
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadProvider: () => 'codex',
    threadDetail: id => id === 'clicked' ? structuredClone(thread.current) : null,
    command: (command, identity) => {
      if (command.type === 'observe-threads' && command.threadIds.includes('clicked')) thread.emit(structuredClone(thread.current))
      return fixture.host.service.command(command, identity)
    },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
    subscribeThreadDetail: listener => { thread.emit = listener; return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Read held')
  const desktop = async (accepts: readonly string[]) => {
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    const hello = await peer.call('hello', { op: 'hello', accepts })
    return { ...peer, features: (hello.result as { features: string[] }).features }
  }
  return { thread, server, desktop }
}
const pushes = (messages: Record<string, unknown>[], event: string) => messages.filter(item => item.event === event && item.threadId === 'clicked')
/** A click in the sidebar: the window's ask reads the thread, then its pane observes it. */
async function click(peer: Awaited<ReturnType<Awaited<ReturnType<typeof readHost>>['desktop']>>, between?: () => void) {
  const read = await peer.call('read', { op: 'detail', threadId: 'clicked' })
  between?.()
  await peer.call('observe', { op: 'observe', threadIds: ['clicked'] })
  return read.result as AgentThreadDetail
}

describe('a thread read whole before it is observed (#1990)', () => {
  it('is not sent again by the observe when it stands as it was read, and the pushes after it follow the read', async () => {
    const { thread, server, desktop } = await readHost()
    const peer = await desktop(['detail-delta', 'detail-read-held'])
    try {
      expect(peer.features).toContain('detail-read-held')
      expect((await click(peer)).revision).toBe(1)
      expect(pushes(peer.messages, 'detail')).toEqual([])
      expect(pushes(peer.messages, 'detail-delta')).toEqual([])
      // Held at the revision it read: the next change goes as a delta from it.
      thread.current = { ...thread.current, revision: 2, messages: [first, later] }
      thread.emit({ threadId: 'clicked', baseRevision: 1, revision: 2, messageDeltas: [{ message: later }], activityDeltas: [] })
      await expect.poll(() => pushes(peer.messages, 'detail-delta')).toHaveLength(1)
      expect((pushes(peer.messages, 'detail-delta')[0]!.delta as AgentThreadDetailDelta).baseRevision).toBe(1)
    } finally { peer.frames.close(); await server.close() }
  })

  it('is told by a delta that changes nothing when its history stands as it was read at a later revision', async () => {
    const { thread, server, desktop } = await readHost()
    const peer = await desktop(['detail-delta', 'detail-read-held'])
    try {
      // The host's own revisions can move with nothing changed, as one dropped while nobody observed the thread does.
      await click(peer, () => { thread.current = { ...thread.current, revision: 3 } })
      expect(pushes(peer.messages, 'detail')).toEqual([])
      const [told] = pushes(peer.messages, 'detail-delta')
      expect(hostPushSchema.parse(told)).toEqual(told)
      expect(told!.delta).toEqual({ threadId: 'clicked', baseRevision: 1, revision: 3, messageDeltas: [], activityDeltas: [] })
    } finally { peer.frames.close(); await server.close() }
  })

  it('is sent whole when its history changed after the read', async () => {
    const { thread, server, desktop } = await readHost()
    const peer = await desktop(['detail-delta', 'detail-read-held'])
    try {
      await click(peer, () => { thread.current = { ...thread.current, revision: 2, messages: [first, later] } })
      const [whole] = pushes(peer.messages, 'detail')
      expect((whole!.detail as AgentThreadDetail).messages).toEqual([first, later])
      expect(pushes(peer.messages, 'detail-delta')).toEqual([])
    } finally { peer.frames.close(); await server.close() }
  })

  it('is sent whole to a desktop that does not accept it, to one without deltas, and after a hello again', async () => {
    const { server, desktop } = await readHost()
    const older = await desktop(['detail-delta'])
    const deltaless = await desktop(['detail-read-held'])
    const again = await desktop(['detail-delta', 'detail-read-held'])
    try {
      await click(older)
      expect(pushes(older.messages, 'detail')).toHaveLength(1)
      await click(deltaless)
      expect(pushes(deltaless.messages, 'detail')).toHaveLength(1)
      await again.call('read', { op: 'detail', threadId: 'clicked' })
      await again.call('hello-again', { op: 'hello', accepts: ['detail-delta', 'detail-read-held'] })
      await again.call('observe', { op: 'observe', threadIds: ['clicked'] })
      expect(pushes(again.messages, 'detail')).toHaveLength(1)
    } finally { older.frames.close(); deltaless.frames.close(); again.frames.close(); await server.close() }
  })
})
