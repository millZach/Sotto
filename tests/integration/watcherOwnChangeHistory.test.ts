// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { CodexActivityProjection, codexItemSchema } from '../../src/main/agents/codexActivity'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const at = '2026-10-13T00:00:00.000Z'
const privatePath = '/project/PRIVATE_WATCHER_FILE.ts'
const privateReason = 'PRIVATE_WATCHER_REASON'
const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: at })
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

class EventProvider extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
}

async function fixture(events = false, history = true) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-watcher-change-history-'))
  cleanup.push(async () => {
    const target = resolve(directory)
    if (dirname(target) !== resolve(tmpdir()) || !target.includes('sotto-watcher-change-history-')) throw new Error('Unexpected test directory')
    await rm(target, { recursive: true, force: true })
  })
  const provider = events ? new EventProvider() : new FakeProviderHost()
  const id = provider.state.threads[0]!.id
  const closed = new Set<WorkspaceHost>()
  const close = async (host: WorkspaceHost) => { if (!closed.has(host)) { await host.close(); closed.add(host) } }
  const open = async () => {
    const host = new WorkspaceHost(provider, directory, () => history, undefined, true)
    cleanup.push(() => close(host))
    await host.initialize(); await host.connect(); host.observeThreads([id])
    return host
  }
  const host = await open()
  await host.setWatcherKind(id, 'watcher')
  const send = async (messages: AgentMessage[], activities: AgentActivity[], status: 'idle' | 'running' = 'idle', destination = host) => {
    const thread = provider.state.threads[0]!
    thread.messages = messages; thread.activities = activities; thread.status = status
    if (provider instanceof EventProvider) provider.log.set(id, messages)
    provider.emit()
    return (await destination.snapshot()).threads.find(thread => thread.id === id)!
  }
  const messages = [message('user', 'user', 'Coordinate'), message('reply', 'assistant', `Changed a file.\nWatcher change reason: ${privateReason}`)]
  const native = provider.state.threads[0]!
  native.messages = messages
  const projection = new CodexActivityProjection()
  projection.anchor(native, 'native-turn', 'user')
  projection.item(native, codexItemSchema.parse({ id: 'patch', type: 'fileChange', status: 'completed',
    changes: [{ path: privatePath, kind: { type: 'update' } }] }), { turnId: 'native-turn', afterMessageId: 'user', phase: 'completed' })
  projection.turn(native, { id: 'native-turn', status: 'completed' })
  return { directory, provider, id, host, close, open, send, messages, activities: native.activities! }
}

it.each([false, true])('keeps detected marks through provider refresh, activity eviction and restart (events: %s)', async events => {
  const f = await fixture(events)
  const changed = await f.send(f.messages, f.activities)
  const expected = { replyMessageId: 'reply', turnId: 'native-turn', files: [privatePath], fileCount: 1, reason: privateReason, source: 'provider-file-change' }
  expect(changed.messages.find(message => message.id === 'reply')?.watcherOwnChange).toEqual(expected)
  const evicted: AgentActivity[] = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => ({ id: `later-${index}`, turnId: 'later-turn', sequence: index,
    kind: 'tool', status: 'completed', title: 'Read' }))
  const afterEviction = await f.send(f.messages, evicted)
  expect(afterEviction.activities?.some(activity => activity.kind === 'file-change')).toBe(false)
  expect(afterEviction.messages.find(message => message.id === 'reply')?.watcherOwnChange).toEqual(expected)
  await f.close(f.host)
  const reopened = await f.open()
  expect(reopened.threadMessages(f.id).find(message => message.id === 'reply')?.watcherOwnChange).toEqual(expected)
  const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
  store.open()
  try {
    expect(store.message(f.id, 'reply')?.watcherOwnChange).toEqual(expected)
    expect(store.eventsAfter(0, f.id).some(({ event }) => event.kind === 'message-replaced' && event.message.watcherOwnChange?.files.includes(privatePath))).toBe(events)
  } finally { store.close() }
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain(privatePath)
  expect(await readFile(join(f.directory, 'workspace.json'), 'utf8')).not.toContain(privateReason)
})

it.each([false, true])('keeps paths and reasons in memory only while history is off (events: %s)', async events => {
  const f = await fixture(events, false)
  const snapshot = await f.send(f.messages, f.activities)
  expect(snapshot.messages.at(-1)?.watcherOwnChange).toMatchObject({ files: [privatePath], reason: privateReason })
  await f.close(f.host)
  const disk = (await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'latin1').catch(() => '')))).join(' ')
  expect(disk).not.toContain(privatePath)
  expect(disk).not.toContain(privateReason)
})

it.each([false, true])('keeps early edits when a running turn exceeds the activity window before its first reply (events: %s)', async events => {
  const f = await fixture(events)
  const native = f.provider.state.threads[0]!
  native.lastTurn = { id: 'native-turn', status: 'running' }
  const working = f.activities.map(activity => activity.kind === 'turn' ? { ...activity, status: 'running' as const } : activity)
  const started = await f.send([f.messages[0]!], working, 'running')
  expect(started.messages).toHaveLength(1)
  expect(started.messages[0]?.watcherObservedChanges).toEqual([{ turnId: 'native-turn', files: [privatePath] }])
  const later: AgentActivity[] = Array.from({ length: MAX_AGENT_ACTIVITIES }, (_, index) => ({ id: `long-turn-${index}`, turnId: 'native-turn', sequence: index,
    afterMessageId: 'user', kind: 'tool', status: 'completed', title: 'Read' }))
  const afterEviction = await f.send([f.messages[0]!], later, 'running')
  expect(afterEviction.activities?.some(activity => activity.kind === 'file-change')).toBe(false)
  expect(afterEviction.messages[0]?.watcherObservedChanges).toEqual([{ turnId: 'native-turn', files: [privatePath] }])
  await f.close(f.host)
  const resumed = await f.open()
  expect(resumed.threadMessages(f.id)[0]?.watcherObservedChanges).toEqual([{ turnId: 'native-turn', files: [privatePath] }])
  native.lastTurn.status = 'completed'
  const secondPath = '/project/SECOND_WATCHER_FILE.ts'
  const finalEdit: AgentActivity = { id: 'final-edit', turnId: 'native-turn', sequence: later.length, afterMessageId: 'user',
    kind: 'file-change', status: 'completed', title: 'File changes', changes: [{ path: secondPath, kind: 'edit' }] }
  const finished = await f.send(f.messages, [finalEdit], 'idle', resumed)
  expect(finished.messages.find(message => message.id === 'reply')?.watcherOwnChange).toEqual({
    replyMessageId: 'reply', turnId: 'native-turn', files: [privatePath, secondPath], fileCount: 2, reason: privateReason, source: 'provider-file-change',
  })
  await f.close(resumed)
  const reopened = await f.open()
  expect(reopened.threadMessages(f.id).find(message => message.id === 'reply')?.watcherOwnChange).toMatchObject({ files: [privatePath, secondPath], fileCount: 2 })
})

it('records a mark-only message update and preserves the mark through native log refresh', () => {
  const log = new ThreadMessageLog(); const events: ThreadHostEvent[] = []
  log.subscribeEvents(event => events.push(event))
  const plain = message('reply', 'assistant', 'Changed.')
  const mark = { replyMessageId: 'reply', turnId: 'native-turn', files: [privatePath], fileCount: 1, reason: null, source: 'provider-file-change' as const }
  log.set('thread', [plain]); events.length = 0
  log.add('thread', { ...plain, watcherOwnChange: mark })
  expect(events).toHaveLength(1)
  expect(events[0]?.event).toMatchObject({ kind: 'message-replaced', message: { watcherOwnChange: mark } })
  log.set('thread', [plain])
  expect(log.message('thread', 'reply')?.watcherOwnChange).toEqual(mark)
  expect(events).toHaveLength(1)
})

it('records staged user-message evidence and preserves it through native log refresh', () => {
  const log = new ThreadMessageLog(); const events: ThreadHostEvent[] = []
  log.subscribeEvents(event => events.push(event))
  const plain = message('user', 'user', 'Coordinate')
  const observed = [{ turnId: 'native-turn', files: [privatePath] }]
  log.set('thread', [plain]); events.length = 0
  log.add('thread', { ...plain, watcherObservedChanges: observed })
  expect(events[0]?.event).toMatchObject({ kind: 'message-replaced', message: { watcherObservedChanges: observed } })
  log.set('thread', [plain])
  expect(log.message('thread', 'user')?.watcherObservedChanges).toEqual(observed)
  expect(events).toHaveLength(1)
})

it('redacts already saved file paths and reasons when local history is turned off', async () => {
  const f = await fixture()
  await f.send(f.messages, f.activities); await f.close(f.host)
  const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
  store.open()
  expect(store.message(f.id, 'reply')?.watcherOwnChange).toBeDefined()
  store.becomeEphemeral(); store.close()
  const disk = (await Promise.all((await readdir(f.directory)).map(name => readFile(join(f.directory, name), 'latin1').catch(() => '')))).join(' ')
  expect(disk).not.toContain(privatePath)
  expect(disk).not.toContain(privateReason)
})
