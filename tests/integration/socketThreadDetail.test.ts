// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { AGENT_STATE_PUBLISH_INTERVAL_MS } from '../../src/main/agents/control'
import { type HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { agentActivitySchema, type AgentActivity } from '../../src/shared/agentActivity'
import { type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostPushSchema } from '../../src/shared/hostProtocol'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('thread detail over the socket', () => {
  const message = (text: string) => ({ id: 'reply', role: 'assistant' as const, text, createdAt: '2026-09-23T00:00:00.000Z' })
  const delta = (baseRevision: number, revision: number, appendText: string): AgentThreadDetailDelta => ({ threadId: 'streaming', baseRevision, revision, messageDeltas: [{ id: 'reply', appendText }], activityDeltas: [] })
  /**
   * A service whose two threads' histories the test sets, and whose detail stream the test drives. Like the
   * coordinator, it publishes a thread whole the moment some client starts observing it, and forgets what it
   * published once nobody does.
   */
  async function streamingHost() {
    const stream: { current: AgentThreadDetail; quiet: AgentThreadDetail; reads: number; emit: (update: AgentThreadDetailUpdate) => void } = { current: { threadId: 'streaming', revision: 1, messages: [message('Hello')] },
      quiet: { threadId: 'quiet', revision: 1, messages: [message('Quiet')] }, reads: 0, emit: () => undefined }
    const published = new Set<string>()
    const service: HostService = {
      shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
      threadDetail: id => {
        if (id === 'quiet') return structuredClone(stream.quiet)
        if (id !== 'streaming') return fixture.host.service.threadDetail(id)
        stream.reads++; return structuredClone(stream.current)
      },
      command: (command, identity) => {
        if (command.type === 'observe-threads') {
          const targets: string[] = command.threadIds.filter(id => id === 'streaming' || id === 'quiet')
          for (const id of [...published]) if (!targets.includes(id)) published.delete(id)
          for (const id of targets) if (!published.has(id)) { published.add(id); stream.emit(service.threadDetail(id)!) }
        }
        return fixture.host.service.command(command, identity)
      },
      events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
      subscribeThreadDetail: listener => { stream.emit = listener; return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Streaming')
    const pushErrors: (string | null)[] = []
    let connected = true
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: text => pushErrors.push(text),
      onPushErrorCleared: () => pushErrors.push(null), onConnectionChange: value => { connected = value } }); fixture.clients.push(client)
    await client.connect()
    const updates: AgentThreadDetailUpdate[] = []
    client.subscribeThreadDetail(update => updates.push(update))
    await client.observe(['streaming'])
    expect(client.threadDetail('streaming')?.revision).toBe(1)
    return { stream, server, client, updates, pushErrors, connected: () => connected, session: () => fixture.host.pairing.signSession(paired.clientId) }
  }

  it('stops materialising observed details after the peer closes while waiting for drain', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const ids = client.shell().host.threads.slice(0, 2).map(thread => thread.id)
    const details = vi.spyOn(fixture.host.service, 'threadDetail')
    const drain = vi.spyOn(SocketFrames.prototype, 'drained').mockImplementation(function (this: SocketFrames) {
      this.close(); return Promise.resolve()
    })
    try {
      await expect(client.observe(ids)).rejects.toMatchObject({ code: 'disconnected' })
      expect(drain).toHaveBeenCalled()
      expect(details).not.toHaveBeenCalled()
    } finally { drain.mockRestore(); details.mockRestore() }
  })
  it('receives each observed detail once on reconnect', async () => {
    const { stream, server, client } = await streamingHost()
    try {
      const reads = stream.reads
      await client.close()
      await client.connect()
      expect(stream.reads).toBe(reads + 1)
      expect(client.threadDetail('streaming')?.revision).toBe(1)
    } finally { await client.close(); await server.close() }
  })

  it('sends a thread whole once when a client starts observing it, and not again while it holds it (#700)', async () => {
    const { stream, server, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = (threadId: string) => phone.messages.filter(item => item.event === 'detail' && item.threadId === threadId)
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      // Nobody observed this thread: the service publishes it whole as the phone starts observing it, and that is the only copy.
      await phone.call('observe-quiet', { op: 'observe', threadIds: ['quiet'] })
      expect(wholes('quiet')).toHaveLength(1)
      // Adding a thread sends only that thread, and one the phone already holds is not sent again.
      await phone.call('observe-both', { op: 'observe', threadIds: ['quiet', 'streaming'] })
      expect(wholes('quiet')).toHaveLength(1)
      expect(wholes('streaming')).toHaveLength(1)
      // Opening the same thread again sends nothing, and the read the phone makes when it holds no copy still answers whole.
      await phone.call('observe-again', { op: 'observe', threadIds: ['quiet', 'streaming'] })
      expect(phone.messages.filter(item => item.event === 'detail')).toHaveLength(2)
      expect(await phone.call('read', { op: 'detail', threadId: 'streaming' })).toMatchObject({ ok: true, result: stream.current })
      // A thread let go and observed again is sent whole again: nothing kept it current in between.
      await phone.call('observe-one', { op: 'observe', threadIds: ['streaming'] })
      await phone.call('observe-back', { op: 'observe', threadIds: ['streaming', 'quiet'] })
      expect(wholes('quiet')).toHaveLength(2)
      expect(wholes('streaming')).toHaveLength(1)
    } finally { phone.frames.close(); await server.close() }
  })

  it('does not send a thread whole a second time when the copy published as it was observed was still waiting to go (#700)', async () => {
    const { stream, server, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = () => phone.messages.filter(item => item.event === 'detail' && item.threadId === 'quiet')
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // The thread was published a moment ago, so what the service publishes as the phone observes it waits for the window to close.
      stream.emit(structuredClone(stream.quiet))
      await phone.call('observe', { op: 'observe', threadIds: ['quiet'] })
      expect(wholes()).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      // A delta published after the waiting copy goes out behind it, so its arrival shows the copy was not sent.
      stream.quiet = { threadId: 'quiet', revision: 2, messages: [message('Quiet now')] }
      stream.emit({ threadId: 'quiet', baseRevision: 1, revision: 2, messageDeltas: [{ id: 'reply', appendText: ' now' }], activityDeltas: [] })
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      vi.useRealTimers()
      await expect.poll(() => phone.messages.some(item => item.event === 'detail-delta' && item.threadId === 'quiet')).toBe(true)
      expect(wholes()).toHaveLength(1)
    } finally { vi.useRealTimers(); phone.frames.close(); await server.close() }
  })

  it('sends a thread whole once to a client that starts observing it while another client\'s whole copy is still waiting to go (#700)', async () => {
    // Every coalescing window stays open until the test closes it, from the first copy the desktop client is sent.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stream, server, client, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = () => phone.messages.filter(item => item.event === 'detail' && item.threadId === 'streaming')
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      // The desktop client already observes the thread, so observing it publishes nothing. The thread went out a moment
      // ago and was then rewritten, so its whole copy is waiting to go.
      stream.emit(structuredClone(stream.current))
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Rewritten')] }
      stream.emit(structuredClone(stream.current))
      await phone.call('observe', { op: 'observe', threadIds: ['streaming'] })
      expect(wholes()).toEqual([expect.objectContaining({ detail: stream.current })])
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(2)
      // A delta published after the waiting copy goes out behind it, so its arrival shows the copy was not sent again.
      stream.current = { threadId: 'streaming', revision: 3, messages: [message('Rewritten!')] }
      stream.emit(delta(2, 3, '!'))
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      vi.useRealTimers()
      await expect.poll(() => phone.messages.some(item => item.event === 'detail-delta' && item.threadId === 'streaming')).toBe(true)
      expect(wholes()).toHaveLength(1)
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
    } finally { vi.useRealTimers(); phone.frames.close(); await client.close(); await server.close() }
  })

  it('sends no client a visual, only its words, in a whole thread, a delta and a read (ADR-0056)', async () => {
    const { stream, server, client, session } = await streamingHost()
    const visual = { id: 'v1', title: 'How a send moves', kind: 'diagram', source: 'flowchart LR\n  A --> B' }
    const drawn = { id: 'visual:v1', role: 'assistant' as const, text: '**How a send moves**\n\nThe visual is in Sotto on your computer.', createdAt: '2026-09-23T00:00:01.000Z', visual }
    const phone = await rawPeer(server.descriptor.port, session())
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-summaries'] })
      await phone.call('observe', { op: 'observe', threadIds: ['streaming'] })
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello'), drawn] }
      stream.emit({ threadId: 'streaming', baseRevision: 1, revision: 2, messageDeltas: [{ message: drawn }], activityDeltas: [] })
      await expect.poll(() => client.threadDetail('streaming')?.messages.length).toBe(2)
      expect(client.threadDetail('streaming')?.messages[1]).toEqual({ id: 'visual:v1', role: 'assistant', text: drawn.text, createdAt: drawn.createdAt })
      await expect.poll(() => phone.messages.some(item => item.event === 'detail-delta')).toBe(true)
      stream.current = { threadId: 'streaming', revision: 3, messages: [message('Hello'), drawn] }
      stream.emit(structuredClone(stream.current))
      await expect.poll(() => phone.messages.filter(item => item.event === 'detail').length).toBe(2)
      const read = await phone.call('read', { op: 'detail', threadId: 'streaming' })
      const wire = JSON.stringify([...phone.messages, read])
      expect(wire).toContain('The visual is in Sotto on your computer.')
      expect(wire).not.toContain('"visual":{')
      expect(wire).not.toContain('flowchart LR')
    } finally { phone.frames.close(); await client.close(); await server.close() }
  })

  it('pushes what changed as a delta the client applies and passes on, and the whole thread to a client that never asked for deltas', async () => {
    const { stream, server, client, updates, session } = await streamingHost()
    try {
      const reads = stream.reads
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello, world')] }
      stream.emit(delta(1, 2, ', world'))
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe('Hello, world')
      expect(client.threadDetail('streaming')?.revision).toBe(2)
      // The window gets the same delta to apply to the revision it holds, and the host read no whole thread.
      expect(updates.at(-1)).toEqual(delta(1, 2, ', world'))
      expect(stream.reads).toBe(reads)

      // A client from before the freeze says nothing about deltas in its hello, and keeps getting whole threads.
      const legacy = await rawPeer(server.descriptor.port, session())
      try {
        // This detail-only service has no native Check implementation, so it must not advertise answer-check.
        expect(await legacy.call('hello', { op: 'hello', afterSeq: 0 })).toMatchObject({ ok: true, result: { sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'background-refresh'] } })
        await legacy.call('observe', { op: 'observe', threadIds: ['streaming'] })
        stream.current = { threadId: 'streaming', revision: 3, messages: [message('Hello, world!')] }
        stream.emit(delta(2, 3, '!'))
        await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
        await expect.poll(() => legacy.messages.some(item => item.event === 'detail' && (item.detail as AgentThreadDetail).revision === 3)).toBe(true)
        expect(legacy.messages.some(item => item.event === 'detail-delta')).toBe(false)
        expect(updates.at(-1)).toEqual(delta(2, 3, '!'))
      } finally { legacy.frames.close() }
    } finally { await client.close(); await server.close() }
  })

  it('sends activity summaries to a client that accepts them, in every detail, delta and detail answer, and whole records to one that does not (#701)', async () => {
    const at = '2026-09-23T00:00:00.000Z'
    const running: AgentActivity = { id: 'build', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Run the build',
      command: 'npm run build', cwd: '/synthetic/project', output: 'compiled '.repeat(2_000), startedAt: at, timingSource: 'observed' }
    const activities: AgentActivity[] = [
      { id: 'turn', turnId: 'turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
      running,
      { id: 'edit', turnId: 'turn', sequence: 2, kind: 'file-change', status: 'completed', title: 'Edited two files', afterMessageId: 'reply',
        changes: [{ path: 'src/a.ts', kind: 'update', diff: '+a\n'.repeat(500) }, { path: 'src/b.ts', kind: 'add', diff: '+b\n'.repeat(500) }], durationMs: 40 },
      { id: 'think', turnId: 'turn', sequence: 3, kind: 'reasoning', status: 'completed', title: 'Thinking', text: 'considered '.repeat(500) },
      { id: 'plan', turnId: 'turn', sequence: 4, kind: 'plan', status: 'completed', title: 'Plan', steps: [{ text: 'Build it', status: 'running' }] },
      { id: 'agents', turnId: 'turn', sequence: 5, kind: 'subagent', status: 'failed', title: 'Reviewers', error: 'One reviewer stopped.', parentId: 'turn',
        agents: [{ id: 'reviewer', status: 'failed', message: 'review notes '.repeat(200), prompt: 'Review the change' }], context: { before: 1000, after: 400 } },
      { id: 'test', turnId: 'turn', sequence: 6, kind: 'command', status: 'failed', title: 'Run the tests', command: 'npm test', output: 'FAIL '.repeat(1_000),
        error: 'Exit 1', exitCode: 1, durationMs: 1234.5, startedAt: at, completedAt: at },
    ]
    /** What a summary row reads, and nothing else. */
    const summary = (record: AgentActivity) => {
      const kept: Record<string, unknown> = { id: record.id, turnId: record.turnId, sequence: record.sequence, kind: record.kind, status: record.status, title: record.title }
      for (const key of ['command', 'exitCode', 'durationMs', 'startedAt'] as const) if (record[key] !== undefined) kept[key] = record[key]
      if (record.changes) kept.changes = record.changes.map(change => ({ path: change.path, kind: change.kind }))
      return kept
    }
    /** Fields a summary row never reads, checked on the activity alone: a message has text of its own. */
    const bodies = ['text', 'output', 'error', 'cwd', 'diff', 'steps', 'agents', 'context', 'completedAt', 'timingSource', 'parentId', 'afterMessageId']
    const carriesNoBodies = (value: unknown) => { for (const key of bodies) expect(JSON.stringify(value)).not.toContain(`"${key}":`) }
    const { stream, server, client, session } = await streamingHost()
    const summaries = await rawPeer(server.descriptor.port, session())
    const wholePeer = await rawPeer(server.descriptor.port, session())
    // A client may take summaries without deltas: it is sent each change as a whole detail of summaries.
    const summariesNoDeltas = await rawPeer(server.descriptor.port, session())
    const peers = [summaries, wholePeer, summariesNoDeltas]
    try {
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello')], activities }
      await summaries.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-summaries'] })
      await wholePeer.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      await summariesNoDeltas.call('hello', { op: 'hello', accepts: ['activity-summaries'] })
      for (const peer of peers) await peer.call('observe', { op: 'observe', threadIds: ['streaming'] })
      const detailPush = (peer: typeof summaries, revision: number) => peer.messages.find(item => item.event === 'detail' && (item.detail as AgentThreadDetail).revision === revision)
      const summarised = (detail: AgentThreadDetail) => ({ ...detail, activities: detail.activities!.map(summary) })
      // The detail each observer is sent on observing.
      for (const peer of [summaries, summariesNoDeltas]) {
        const pushed = detailPush(peer, 2)!
        expect(hostPushSchema.parse(pushed)).toEqual(pushed)
        expect(pushed.detail).toEqual(summarised(stream.current))
        carriesNoBodies((pushed.detail as AgentThreadDetail).activities)
        for (const record of (pushed.detail as AgentThreadDetail).activities!) expect(agentActivitySchema.parse(record)).toEqual(record)
      }
      expect(detailPush(wholePeer, 2)!.detail).toEqual(stream.current)

      // The running command's output grew and the plan went. The record goes as its summary to the client that accepts
      // summaries and whole to the one that does not; the revisions are the same, so both apply it.
      const grown: AgentActivity = { ...running, output: running.output + 'linked '.repeat(1_000) }
      stream.current = { ...stream.current, revision: 3, activities: activities.filter(record => record.id !== 'plan').map(record => record.id === 'build' ? grown : record) }
      stream.emit({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: grown }, { id: 'plan', removed: true }] })
      const deltaPush = (peer: typeof summaries) => peer.messages.find(item => item.event === 'detail-delta' && (item.delta as AgentThreadDetailDelta).revision === 3)
      await expect.poll(() => deltaPush(summaries)).toBeTruthy()
      await expect.poll(() => deltaPush(wholePeer)).toBeTruthy()
      expect(hostPushSchema.parse(deltaPush(summaries))).toEqual(deltaPush(summaries))
      expect(deltaPush(summaries)!.delta).toEqual({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: summary(grown) }, { id: 'plan', removed: true }] })
      carriesNoBodies((deltaPush(summaries)!.delta as AgentThreadDetailDelta).activityDeltas)
      expect(deltaPush(wholePeer)!.delta).toEqual({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: grown }, { id: 'plan', removed: true }] })
      await expect.poll(() => detailPush(summariesNoDeltas, 3)).toBeTruthy()
      expect(detailPush(summariesNoDeltas, 3)!.detail).toEqual(summarised(stream.current))
      // The desktop's own client never asks for summaries and keeps every record whole.
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
      expect(client.threadDetail('streaming')).toEqual(stream.current)

      // A whole detail the service publishes, and the detail a client reads, follow the same rule.
      stream.current = { ...stream.current, revision: 4 }
      stream.emit(stream.current)
      await expect.poll(() => detailPush(summaries, 4)).toBeTruthy()
      await expect.poll(() => detailPush(wholePeer, 4)).toBeTruthy()
      expect(detailPush(summaries, 4)!.detail).toEqual(summarised(stream.current))
      expect(detailPush(wholePeer, 4)!.detail).toEqual(stream.current)
      expect((await summaries.call('read', { op: 'detail', threadId: 'streaming' })).result).toEqual(summarised(stream.current))
      expect((await wholePeer.call('read', { op: 'detail', threadId: 'streaming' })).result).toEqual(stream.current)
      expect(await client.readThreadDetail('streaming')).toEqual(stream.current)
    } finally { for (const peer of peers) peer.frames.close(); await client.close(); await server.close() }
  })

  it('delivers saved long messages in whole details and replacement deltas and reopens without disconnecting', async () => {
    const { stream, server, client, connected, pushErrors } = await streamingHost()
    const store = new ThreadStore(join(fixture.root, 'long-replies.sqlite'))
    store.open()
    const text = 'a'.repeat(200_001)
    const replacement = 'b'.repeat(300_001)
    const save = (kind: 'message-added' | 'message-replaced', text: string) => {
      store.appendMany('streaming', [
        { kind, at: message('').createdAt, message: message(text.slice(0, 100_000)) },
        ...Array.from({ length: Math.ceil(text.length / 100_000) - 1 }, (_, index) => ({
          kind: 'message-text-appended' as const, at: message('').createdAt, messageId: 'reply', appendText: text.slice((index + 1) * 100_000, (index + 2) * 100_000),
        })),
      ])
    }
    try {
      save('message-added', text)
      stream.current = { threadId: 'streaming', revision: 2, messages: store.readMessages('streaming').messages }
      stream.emit(stream.current)
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(text)
      save('message-replaced', replacement)
      stream.current = { threadId: 'streaming', revision: 3, messages: store.readMessages('streaming').messages }
      stream.emit({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [{ message: stream.current.messages[0]! }], activityDeltas: [] })
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(replacement)
      expect(connected()).toBe(true)
      expect(pushErrors).toEqual([])
      const suffix = 'c'.repeat(150_001)
      stream.current = { ...stream.current, revision: 4, messages: [message(replacement + suffix)] }
      stream.emit(delta(3, 4, suffix))
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(replacement + suffix)
      expect(connected()).toBe(true)
      store.close()
      store.open()
      store.rebuild()
      stream.current = { ...stream.current, messages: store.readMessages('streaming').messages }
      await client.close()
      await client.connect()
      await client.observe(['streaming'])
      expect((await client.readThreadDetail('streaming'))?.messages[0]?.text).toBe(replacement)
      expect(connected()).toBe(true)
      expect(pushErrors).toEqual([])
    } finally { store.close(); await client.close(); await server.close() }
  })

  it('reads the whole thread once when a delta does not follow the revision the client holds', async () => {
    const { stream, server, client, updates } = await streamingHost()
    try {
      const reads = stream.reads
      // The client holds revision 1 and never saw 1 to 3: neither delta applies, and one read catches it up.
      stream.current = { threadId: 'streaming', revision: 5, messages: [message('Hello, world, again')] }
      stream.emit(delta(3, 4, ', world'))
      stream.emit(delta(4, 5, ', again'))
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(5)
      expect(client.threadDetail('streaming')?.messages[0]?.text).toBe('Hello, world, again')
      await client.receipt('settled')
      expect(stream.reads).toBe(reads + 1)
      // What the window is given is the whole thread it can hold, not a delta it cannot follow either.
      expect(updates.at(-1)).toEqual(stream.current)
    } finally { await client.close(); await server.close() }
  })

  it('finishes a reconnect with an observed thread too large to send, reporting the thread instead of failing the connection', async () => {
    const { stream, server, client, pushErrors, connected } = await streamingHost()
    try {
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + 'x'.repeat(17 * 1024 * 1024))] }
      await client.close()
      // Failing here would have the desktop retry, and read the same thread whole, for as long as it stayed too large.
      await client.connect()
      expect(connected()).toBe(true)
      expect(pushErrors.at(-1)).toEqual(expect.stringContaining('A thread on this host is too large to send to this device'))
      expect(await client.receipt('still-open')).toEqual({ status: 'unknown' })
    } finally { await client.close(); await server.close() }
  })

  it('answers a delta too large for a frame with an error naming its thread, and does not ask for that thread again until it is observed again', async () => {
    const { stream, server, client, pushErrors, connected, session } = await streamingHost()
    // A second peer accepting deltas shows when the host has sent one: it sends to every peer in the same pass.
    const witness = await rawPeer(server.descriptor.port, session())
    try {
      await witness.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      await witness.call('observe', { op: 'observe', threadIds: ['streaming'] })
      const reads = stream.reads
      const huge = 'x'.repeat(17 * 1024 * 1024)
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + huge)] }
      stream.emit(delta(1, 2, huge))
      await expect.poll(() => pushErrors).toEqual([expect.stringContaining('A thread on this host is too large to send to this device')])
      expect(witness.messages).toContainEqual(expect.objectContaining({ event: 'error', threadId: 'streaming', error: expect.objectContaining({ code: 'too_large' }) }))
      // The next delta fits, but follows a revision the client never got; the whole thread would not fit either.
      stream.current = { threadId: 'streaming', revision: 3, messages: [message('Hello' + huge + '!')] }
      stream.emit(delta(2, 3, '!'))
      await expect.poll(() => witness.messages.some(item => item.event === 'detail-delta' && (item.delta as AgentThreadDetailDelta).revision === 3)).toBe(true)
      await client.receipt('settled')
      expect(stream.reads).toBe(reads)
      expect(pushErrors).toHaveLength(1)
      expect(connected()).toBe(true)
      // Observing the thread again sends it whole, and once it fits the error clears.
      stream.current = { threadId: 'streaming', revision: 4, messages: [message('Short again')] }
      await client.observe(['streaming'])
      expect(client.threadDetail('streaming')?.revision).toBe(4)
      expect(pushErrors.at(-1)).toBeNull()
    } finally { witness.frames.close(); await client.close(); await server.close() }
  })
})
