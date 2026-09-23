// @vitest-environment node
/**
 * The activity a pane is given beside a thread's history window: the work of a turn above the window
 * waits there with its messages, while the store, the summary and the adapters keep every record.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import type { ThreadEvent } from '../../../src/shared/threadEvents'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'sotto-pane-activity-'))
  cleanup.push(async () => {
    if (dirname(resolve(created)) !== resolve(tmpdir()) || !created.includes('sotto-pane-activity-')) throw new Error('Unexpected test directory')
    await rm(created, { recursive: true, force: true })
  })
  return created
}

async function opened(directory: string, adapter: FakeProviderHost) {
  const host = new WorkspaceHost(adapter, directory)
  cleanup.push(async () => { host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() })
  await host.initialize()
  return host
}

const at = (index: number): string => new Date(Date.UTC(2026, 8, 22, 9, 0, index)).toISOString()
function conversation(prefix: string, from: number, to: number): AgentMessage[] {
  return Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset
    return [
      { id: `${prefix}-u${index}`, role: 'user' as const, text: `Prompt ${index}`, createdAt: at(index * 2) },
      { id: `${prefix}-a${index}`, role: 'assistant' as const, text: `Reply ${index}`, createdAt: at(index * 2 + 1) },
    ]
  }).flat()
}
const record = (id: string, turnId: string, patch: Partial<AgentActivity> = {}): AgentActivity =>
  ({ id, turnId, sequence: 0, kind: 'command', status: 'completed', title: 'npm test', ...patch })
/** Each turn's lifecycle after its prompt, a command after its reply, and a note that names no message at all. */
function work(prefix: string, from: number, to: number): AgentActivity[] {
  return Array.from({ length: to - from }, (_, offset) => {
    const index = from + offset
    return [
      record(`turn-${index}`, `t${index}`, { kind: 'turn', afterMessageId: `${prefix}-u${index}` }),
      record(`cmd-${index}`, `t${index}`, { afterMessageId: `${prefix}-a${index}` }),
      record(`note-${index}`, `t${index}`, { kind: 'status' }),
    ]
  }).flat()
}
const ids = (records: readonly AgentActivity[] | undefined): string[] => (records ?? []).map(item => item.id)
const turnsOf = (records: readonly AgentActivity[] | undefined): number[] =>
  [...new Set((records ?? []).filter(item => item.kind === 'turn').map(item => Number(item.turnId.slice(1))))]

/** Thirty turns published whole by a provider, with a pane open on the thread. */
async function longThread() {
  const directory = await root()
  const adapter = new FakeProviderHost()
  const host = await opened(directory, adapter)
  await host.connect()
  const provider = adapter.state.threads[0]!
  provider.messages = conversation('long', 0, 30)
  provider.activities = work('long', 0, 30)
  adapter.emit()
  await host.snapshot()
  host.observeThreads([provider.id])
  const published = (): AgentThread => host.workspaceSnapshot().threads.find(item => item.id === provider.id)!
  const pane = (): readonly AgentActivity[] => { const thread = published(); return host.paneActivities(thread.id, thread.activities!) }
  return { directory, adapter, host, provider, published, pane }
}

describe('the activity a pane is given beside a history window', () => {
  it('keeps back the work above the window and gives it back when the window widens', async () => {
    const f = await longThread()
    // The window holds the newest ten turns, and only their work goes beside it, notes included.
    expect(f.published().messages[0]?.id).toBe('long-u20')
    expect(turnsOf(f.pane())).toEqual(Array.from({ length: 10 }, (_, index) => index + 20))
    expect(f.pane()).toHaveLength(30)
    expect(ids(f.pane())).toContain('note-20')
    expect(ids(f.pane())).not.toContain('note-19')

    // Show earlier messages loads the rest of the history, and every turn's work with it.
    await f.host.loadEarlierMessages(f.provider.id)
    expect(f.published().earlierAvailable).toBeUndefined()
    expect(f.pane()).toHaveLength(90)
  })

  it('leaves every record in the published state, the summary, the adapters and the store', async () => {
    const f = await longThread()
    expect(f.pane()).toHaveLength(30)
    expect(f.published().activities).toHaveLength(90)
    expect(f.published().summary?.activityCount).toBe(90)
    expect(f.host.activities(f.provider.id)).toHaveLength(90)
    await f.host.snapshot()
    const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
    store.open()
    try { expect(store.readActivities(f.provider.id)).toHaveLength(90) }
    finally { store.close() }
  })

  it('keeps back an old turn a provider read again after a restart, however new its number', async () => {
    const f = await longThread()
    // A history re-read hands back records the store no longer held; each is numbered after all the rest.
    f.provider.activities = [
      record('reread-cmd', 'provider-turn-3', { afterMessageId: 'long-a3' }),
      record('reread-note', 'provider-turn-3', { kind: 'reasoning' }),
      record('claude-tool', 'long-u5', { kind: 'tool' }),
    ]
    f.adapter.emit()
    await f.host.snapshot()
    const published = f.published().activities!
    const reread = new Set(['reread-cmd', 'reread-note', 'claude-tool'])
    const newest = Math.max(...published.filter(item => !reread.has(item.id)).map(item => item.sequence))
    expect(published.find(item => item.id === 'reread-cmd')!.sequence).toBeGreaterThan(newest)
    expect(ids(f.pane())).not.toContain('reread-cmd')
    expect(ids(f.pane())).not.toContain('reread-note')
    expect(ids(f.pane())).not.toContain('claude-tool')
    expect(f.pane()).toHaveLength(30)

    await f.host.loadEarlierMessages(f.provider.id)
    expect(ids(f.pane())).toEqual(expect.arrayContaining(['reread-cmd', 'reread-note', 'claude-tool']))
  })

  it('always gives the live turn and work it cannot place', async () => {
    const f = await longThread()
    f.provider.activities = [
      record('elsewhere', 'provider-turn-x', { afterMessageId: 'not-in-the-store' }),
      record('placeless', 'provider-turn-y'),
      record('live-turn', 'provider-turn-z', { kind: 'turn', afterMessageId: 'long-u2', status: 'running' }),
      record('live-read', 'provider-turn-z', { afterMessageId: 'long-a2' }),
    ]
    f.adapter.emit()
    await f.host.snapshot()
    expect(ids(f.pane())).toEqual(expect.arrayContaining(['elsewhere', 'placeless', 'live-turn', 'live-read']))
  })

  it('keeps back an old turn a re-read left with a running command, while the live turn is given', async () => {
    const f = await longThread()
    // Claude re-reads a tool call that never got its result as a running record, numbered after everything.
    f.provider.activities = [
      record('stale-call', 'long-u4', { kind: 'tool', afterMessageId: 'long-a4', status: 'running' }),
      record('live-turn', 'provider-turn-z', { kind: 'turn', afterMessageId: 'long-u29', status: 'running' }),
    ]
    f.adapter.emit()
    await f.host.snapshot()
    expect(ids(f.pane())).toContain('live-turn')
    expect(ids(f.pane())).not.toContain('stale-call')

    // With no running turn record, only a running thread's newest turn counts as live.
    f.provider.activities = [record('live-turn', 'provider-turn-z', { kind: 'turn', afterMessageId: 'long-u29', status: 'completed' })]
    f.adapter.emit()
    await f.host.snapshot()
    expect(ids(f.pane())).not.toContain('stale-call')
    f.provider.status = 'running'
    f.provider.activities = [record('newest', 'provider-turn-3', { afterMessageId: 'long-a3', status: 'running' })]
    f.adapter.emit()
    await f.host.snapshot()
    expect(ids(f.pane())).toContain('newest')
    expect(ids(f.pane())).not.toContain('stale-call')
  })

  it('gives a thread no pane is looking at its live turn alone', async () => {
    const f = await longThread()
    f.provider.activities = [
      record('live', 'provider-turn-z', { kind: 'turn', afterMessageId: 'long-u29', status: 'running' }),
      record('stale-call', 'long-u4', { afterMessageId: 'long-a4', status: 'running' }),
      record('placeless', 'provider-turn-y'),
    ]
    f.adapter.emit()
    await f.host.snapshot()
    f.host.observeThreads([])
    expect(f.published().messages).toEqual([])
    expect(ids(f.pane())).toEqual(['live'])
    expect(f.published().activities).toHaveLength(93)
  })

  it('asks the store once per turn above the window, never for the whole thread', async () => {
    const wholeReads = vi.spyOn(ThreadStore.prototype, 'messageIdentities')
    const lookups = vi.spyOn(ThreadStore.prototype, 'hasMessage')
    const f = await longThread()
    expect(f.pane()).toHaveLength(30)
    // Twenty turns sit above the window, and each is settled by the first message it names.
    expect(lookups).toHaveBeenCalledTimes(20)
    for (let turn = 30; turn < 40; turn += 1) {
      f.provider.messages = [...f.provider.messages, ...conversation('long', turn, turn + 1)]
      f.provider.activities = work('long', turn, turn + 1)
      f.adapter.emit()
      await f.host.snapshot()
      expect(f.pane().at(-1)!.id).toBe(`note-${turn}`)
    }
    expect(lookups).toHaveBeenCalledTimes(20)
    expect(wholeReads).not.toHaveBeenCalled()
    // The window started at turn 20 and grows as new turns arrive, so turn 19's work still waits above it.
    expect(turnsOf(f.pane())[0]).toBe(20)

    // Closing the pane lets the answers go; opening it again asks afresh.
    f.host.observeThreads([])
    f.host.observeThreads([f.provider.id])
    expect(turnsOf(f.pane())[0]).toBe(30)
    expect(lookups).toHaveBeenCalledTimes(50)
  })

  it('gives every record once a failed write has sent the pane the whole history', async () => {
    const f = await longThread()
    expect(f.pane()).toHaveLength(30)
    vi.spyOn(ThreadStore.prototype, 'appendMany').mockImplementationOnce(() => { throw new Error('disk full') })
    f.provider.messages = [...f.provider.messages, ...conversation('long', 30, 31)]
    f.adapter.emit()
    await f.host.snapshot()
    expect(f.published().messages[0]?.id).toBe('long-u0')
    expect(f.pane()).toHaveLength(90)
  })
})

/** A provider that says what changed rather than publishing a whole history (issue #120). */
class EventProviderHost extends FakeProviderHost {
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }
  publish(threadId: string, event: ThreadEvent): void {
    for (const listener of this.eventListeners) listener({ threadId, event })
  }
  add(threadId: string, messages: readonly AgentMessage[]): void {
    for (const message of messages) this.publish(threadId, { kind: 'message-added', at: message.createdAt, message })
  }
}

describe('the activity beside a window a provider writes as events', () => {
  it('keeps its answers with the events and asks again after a reset', async () => {
    const wholeReads = vi.spyOn(ThreadStore.prototype, 'messageIdentities')
    const lookups = vi.spyOn(ThreadStore.prototype, 'hasMessage')
    const directory = await root()
    const adapter = new EventProviderHost()
    const host = await opened(directory, adapter)
    await host.connect()
    const id = adapter.state.threads[0]!.id
    host.observeThreads([id])
    adapter.add(id, conversation('ev', 0, 15))
    adapter.state.threads[0]!.activities = work('ev', 0, 15)
    adapter.emit()
    await host.snapshot()
    const pane = (): readonly AgentActivity[] => {
      const thread = host.workspaceSnapshot().threads.find(item => item.id === id)!
      return host.paneActivities(id, thread.activities!)
    }
    expect(turnsOf(pane())).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(lookups).toHaveBeenCalledTimes(5)

    // A streamed reply and a new turn are written as events; turn 5 slides above the window and is asked about once.
    for (const chunk of [' and', ' more', ' still']) adapter.publish(id, { kind: 'message-text-appended', at: at(40), messageId: 'ev-a14', appendText: chunk })
    adapter.add(id, conversation('ev', 15, 16))
    adapter.state.threads[0]!.activities = work('ev', 15, 16)
    adapter.emit()
    await host.snapshot()
    expect(turnsOf(pane())).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(lookups).toHaveBeenCalledTimes(6)

    // A compaction rewrites the history from turn 3 on, so the answers from before it no longer hold.
    adapter.publish(id, { kind: 'messages-reset', at: at(50) })
    adapter.add(id, conversation('ev', 3, 16))
    adapter.emit()
    await host.snapshot()
    expect(host.workspaceSnapshot().threads.find(item => item.id === id)!.messages[0]?.id).toBe('ev-u6')
    // Turns 3 to 5 are above the window; turns 0 to 2 name messages the store no longer holds, so the pane places them.
    expect(turnsOf(pane())).toEqual([0, 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(wholeReads).not.toHaveBeenCalled()
  })
})
