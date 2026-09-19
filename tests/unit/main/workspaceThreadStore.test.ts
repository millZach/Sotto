// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../../src/shared/agents'
import type { RestoredThreadHistory } from '../../../src/main/agents/host'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

/** A provider that remembers what the workspace handed back before it connected (ADR-0015). */
class RestoringProviderHost extends FakeProviderHost {
  restored: RestoredThreadHistory[] = []
  async restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    this.restored = threads.map(thread => ({ threadId: thread.threadId, messages: [...thread.messages] }))
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'sotto-thread-projection-'))
  cleanup.push(async () => {
    if (dirname(resolve(created)) !== resolve(tmpdir()) || !created.includes('sotto-thread-projection-')) throw new Error('Unexpected test directory')
    await rm(created, { recursive: true, force: true })
  })
  return created
}

async function opened(directory: string, adapter: FakeProviderHost, history: () => boolean = () => true) {
  const host = new WorkspaceHost(adapter, directory, history)
  cleanup.push(async () => { host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() })
  await host.initialize()
  return host
}

const at = (index: number): string => new Date(Date.UTC(2026, 8, 19, 10, 0, index)).toISOString()
/** `turns` exchanges, each a prompt and its reply, distinct enough to find in a file. */
function conversation(prefix: string, turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    { id: `${prefix}-u${index}`, role: 'user' as const, text: `Prompt ${prefix} ${index}`, createdAt: at(index * 2) },
    { id: `${prefix}-a${index}`, role: 'assistant' as const, text: `Reply ${prefix} ${index}`, createdAt: at(index * 2 + 1) },
  ]).flat()
}
/** Everything the profile holds on disk, so a search for what was said covers the log beside the database. */
async function onDisk(directory: string): Promise<string> {
  const names = await readdir(directory)
  const parts = await Promise.all(names.map(name => readFile(join(directory, name), 'latin1').catch(() => '')))
  return parts.join(' ')
}

describe('thread messages in the store rather than the workspace cache', () => {
  it('keeps messages out of workspace.json and gives a watched pane a window it can widen', async () => {
    const directory = await root()
    const adapter = new FakeProviderHost()
    const host = await opened(directory, adapter)
    await host.connect()
    adapter.state.threads[0]!.messages = conversation('workshop', 30)
    adapter.emit()
    await host.snapshot()

    const saved = await readFile(join(directory, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('Prompt workshop 0')
    expect(saved).not.toContain('Reply workshop 29')
    expect((JSON.parse(saved) as { snapshot: AgentHostSnapshot }).snapshot.threads.every(thread => thread.messages.length === 0)).toBe(true)

    // Nothing is watched, so every thread is its summary alone.
    host.observeThreads([])
    let thread = host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')!
    expect(thread.messages).toEqual([])
    expect(thread.summary).toMatchObject({ messageCount: 60, lastUser: { text: 'Prompt workshop 29' }, lastAssistant: { text: 'Reply workshop 29' } })

    // A pane opening on it is given ten turns, and told there are earlier messages.
    host.observeThreads(['session-workshop'])
    thread = host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')!
    expect(thread.messages).toHaveLength(20)
    expect(thread.messages[0]?.id).toBe('workshop-u20')
    expect(thread.earlierAvailable).toBe(true)
    expect(thread.summary?.messageCount).toBe(60)

    // Show earlier messages adds twenty more turns; the whole history fits, so nothing is left behind.
    await host.loadEarlierMessages('session-workshop')
    thread = host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')!
    expect(thread.messages).toHaveLength(60)
    expect(thread.earlierAvailable).toBeUndefined()

    // Closing the pane puts the history away again without losing what the sidebar reads.
    host.observeThreads([])
    thread = host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')!
    expect(thread.messages).toEqual([])
    expect(thread.summary?.messageCount).toBe(60)
  })

  it('moves an old workspace cache into the store once and hands it back before anything connects', async () => {
    const directory = await root()
    const messages = conversation('legacy', 4)
    const legacy: AgentThread = { id: 'session-workshop', projectId: 'project', title: 'Workshop', modelId: 'fake:model',
      status: 'idle', messages, requests: [], nativeSessionStarted: true }
    await writeFile(join(directory, 'workspace.json'), `${JSON.stringify({
      snapshot: { ...EMPTY_AGENT_HOST, name: 'Fake provider', version: '1', threads: [legacy] },
      projectAliases: [], creations: [],
    }, null, 2)}\n`, 'utf8')

    const adapter = new RestoringProviderHost()
    const host = await opened(directory, adapter)
    expect(adapter.restored).toEqual([{ threadId: 'session-workshop', messages }])
    const saved = await readFile(join(directory, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('Prompt legacy 0')
    expect(host.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')?.summary?.messageCount).toBe(8)
    host.disconnect(); await host.privacyChanged(); host.dispose()

    // Running it again finds nothing left to move, and the history is still exactly what it was.
    const second = new RestoringProviderHost()
    const restarted = await opened(directory, second)
    expect(second.restored).toEqual([{ threadId: 'session-workshop', messages }])
    restarted.observeThreads(['session-workshop'])
    expect(restarted.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')?.messages).toEqual(messages)
  })

  it('writes no message text to threads.sqlite while Keep local history is off', async () => {
    const directory = await root()
    const adapter = new FakeProviderHost()
    let history = true
    const host = await opened(directory, adapter, () => history)
    await host.connect()
    adapter.state.threads[0]!.messages = conversation('kept', 2)
    adapter.emit()
    await host.snapshot()
    expect(await onDisk(directory)).toContain('Prompt kept 0')

    history = false
    await host.privacyChanged()
    adapter.state.threads[0]!.messages = [...adapter.state.threads[0]!.messages, ...conversation('secret', 2)]
    adapter.emit()
    await host.snapshot()
    // The run still knows what was said; the disk does not.
    host.observeThreads(['session-workshop'])
    expect(host.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')?.messages.some(message => message.text === 'Prompt secret 0')).toBe(true)
    const disk = await onDisk(directory)
    expect(disk).not.toContain('Prompt secret 0')
    expect(disk).not.toContain('Prompt kept 0')
  })

  it('publishes fifty threads with long histories carrying summaries rather than messages', async () => {
    const directory = await root()
    const adapter = new FakeProviderHost()
    adapter.state.threads = Array.from({ length: 50 }, (_, index): AgentThread => ({
      id: `session-${index}`, projectId: 'project', title: `Thread ${index}`, modelId: 'fake:model',
      status: 'idle', messages: conversation(`t${index}`, 20), requests: [],
    }))
    const host = await opened(directory, adapter)
    await host.connect()
    host.observeThreads(['session-3'])

    const published: AgentHostSnapshot[] = []
    host.subscribe(snapshot => published.push(snapshot))
    adapter.emit()
    await host.snapshot()
    const snapshot = published.at(-1)!
    expect(snapshot.threads).toHaveLength(50)
    // The one thread a pane is looking at carries its window; the other forty-nine carry nothing.
    expect(snapshot.threads.filter(thread => thread.messages.length).map(thread => thread.id)).toEqual(['session-3'])
    expect(snapshot.threads.every(thread => thread.summary?.messageCount === 40)).toBe(true)
    const saved = await readFile(join(directory, 'workspace.json'), 'utf8')
    expect(saved).not.toContain('Prompt t7 0')
    expect(saved.length).toBeLessThan(20_000)
  })

  it('records a confirmed rewind as a reset and keeps only what the provider republished', async () => {
    const directory = await root()
    const adapter = new FakeProviderHost()
    const host = await opened(directory, adapter)
    await host.connect()
    const thread = adapter.state.threads[0]!
    thread.historyEpoch = 'first'
    thread.messages = conversation('before', 3)
    adapter.emit()
    await host.snapshot()

    thread.historyEpoch = 'second'
    thread.messages = conversation('before', 1)
    adapter.emit()
    await host.snapshot()
    host.observeThreads(['session-workshop'])
    const rewound = host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')!
    expect(rewound.messages.map(message => message.id)).toEqual(['before-u0', 'before-a0'])
    expect(rewound.summary?.messageCount).toBe(2)
  })

  it('records who answered a request, and never the words of the answer', async () => {
    const directory = await root()
    const adapter = new FakeProviderHost()
    const host = await opened(directory, adapter)
    await host.connect()
    host.recordAnswer('session-workshop', {
      kind: 'answer-given', at: at(0), requestId: 'request-1', approved: true, permissionChoice: 'allow-once',
      attribution: { clientId: 'desktop-window', user: 'tester', transport: 'ipc' },
    })
    // Nothing is projected from an answer, so the thread's messages are untouched by one.
    host.observeThreads(['session-workshop'])
    expect(host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')?.messages).toEqual([])
    const written = await onDisk(directory)
    expect(written).toContain('answer-given')
    expect(written).toContain('desktop-window')
    // The event has no answer field at all: an answer can read like a prompt, so it is never written.
    expect(written).not.toContain('"answer"')
  })
})
