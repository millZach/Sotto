// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThreadSummary } from '../../../src/shared/agents'
import type { AnswerGivenEvent, ThreadEvent } from '../../../src/shared/threadEvents'
import type { VisualInput } from '../../../src/shared/visuals'
import { writeThreads } from '../../../src/main/agents/threadStoreWriter'
import { DeferredStoreWriter } from '../../fixtures/deferredStoreWriter'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

// The seam every thread-store write goes through (#1457, step 1 of docs/plans/store-worker.md). These tests run the
// workspace over a writer that holds each confirmation until the test releases it, the way the store worker will.

/** A provider that says what changed, event by event, as the native adapters do. */
class EventProvider extends FakeProviderHost {
  private readonly events = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  publish(event: ThreadEvent, threadId = WORKSHOP): void {
    for (const listener of this.events) listener({ threadId, event })
  }
}

const WORKSHOP = 'session-workshop'
const DOCS = 'session-docs'
const at = '2026-10-26T00:00:00.000Z'
const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: at })
const added = (id: string, text: string, role: AgentMessage['role'] = 'assistant'): ThreadEvent => ({ kind: 'message-added', at, message: message(id, role, text) })
const appended = (messageId: string, appendText: string): ThreadEvent => ({ kind: 'message-text-appended', at, messageId, appendText })
const replaced = (id: string, text: string, role: AgentMessage['role'] = 'assistant'): ThreadEvent => ({ kind: 'message-replaced', at, message: message(id, role, text) })
const reset = (): ThreadEvent => ({ kind: 'messages-reset', at })
const aliased = (messageId: string, canonicalId: string): ThreadEvent => ({ kind: 'message-aliased', at, messageId, canonicalId })
const answer = (requestId: string): AnswerGivenEvent => ({ kind: 'answer-given', at, requestId, attribution: { clientId: 'test-client', transport: 'ipc' } })
const visual = (title: string): VisualInput => ({ title, kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', intro: 'The short way.', steps: [{ text: 'A draft is sent.', highlight: ['A->B'] }] })
const record = (id: string, sequence: number, status: AgentActivity['status'] = 'completed'): AgentActivity =>
  ({ id, turnId: 'turn', sequence, kind: 'tool', status, title: `Tool ${id}`, output: `Output ${id}` })

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

interface Fixture { directory: string; adapter: EventProvider | FakeProviderHost; host: WorkspaceHost; writer: DeferredStoreWriter | undefined }

/**
 * A workspace with one provider. `deferred` runs it over the holding writer, which confirms nothing until released; the
 * start commits at once, as nothing reads the store before it, and the writer holds from then on.
 */
async function fixture(options: { deferred?: boolean; streamingPublishCost?: boolean; providerId?: 'claude'; watcher?: boolean; wholeHistories?: boolean; history?: () => boolean } = {}): Promise<Fixture & { adapter: EventProvider }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-store-writer-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-store-writer-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  // A provider that publishes whole histories is the one whose snapshots the workspace compares (`record`).
  const adapter = (options.wholeHistories ? new FakeProviderHost() : new EventProvider()) as EventProvider
  if (options.providerId) for (const thread of adapter.state.threads) thread.providerId = options.providerId
  // A send looks at its project's folder, so the project is a folder that is there.
  const project = join(directory, 'project')
  await mkdir(project)
  adapter.state.projects[0]!.path = project
  let writer: DeferredStoreWriter | undefined
  const host = options.deferred === false
    ? new WorkspaceHost(adapter, directory, options.history ?? (() => true), undefined, options.watcher ?? false, false, options.streamingPublishCost ?? true)
    : new WorkspaceHost(adapter, directory, options.history ?? (() => true), undefined, options.watcher ?? false, false, options.streamingPublishCost ?? true,
      store => { writer = new DeferredStoreWriter(store); writer.holding = false; return writer })
  cleanup.push(async () => { host.disconnect(); if (writer) { writer.holding = false; writer.release() } await host.close().catch(() => undefined) })
  await host.initialize()
  await host.connect()
  host.observeThreads([WORKSHOP])
  if (writer) writer.holding = true
  return { directory, adapter, host, writer }
}

/** What the file itself holds, read through a connection of its own: nothing a commit has not reached. */
function storedMessages(directory: string, threadId = WORKSHOP): AgentMessage[] {
  const disk = new ThreadStore(join(directory, 'threads.sqlite'), undefined, null)
  disk.open()
  try { return disk.readMessages(threadId).messages } finally { disk.close() }
}
const shown = (host: WorkspaceHost, threadId = WORKSHOP) => host.workspaceSnapshot().threads.find(thread => thread.id === threadId)!

/** Releases every write, and every write a confirmation let go behind it, until nothing is posted. */
function settle(f: Fixture): void {
  for (;;) {
    f.host.workspaceSnapshot()
    if (!f.writer?.waiting) return
    f.writer.release()
  }
}

/** Whether a promise has settled, read after the tasks queued ahead of this check have run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  return settled
}

/** Releases what is posted until a write of this kind has been posted, and leaves that one and what follows it held. */
async function releaseUntilPosted(writer: DeferredStoreWriter, kind: string): Promise<void> {
  for (let tries = 0; !writer.log.some(write => write.kind === kind); tries++) {
    if (tries > 1_000) throw new Error(`No ${kind} write was posted`)
    writer.release()
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Runs `work` to the end while releasing what it posts, the way the store worker confirms without being asked. */
async function pumped<T>(f: Fixture, work: Promise<T>): Promise<T> {
  let done = false
  const result = work.finally(() => { done = true })
  // Handled at once, so a rejection while the writer is pumped reaches the caller rather than reading as unhandled.
  result.catch(() => undefined)
  while (!done) {
    f.writer?.release()
    await new Promise(resolve => setImmediate(resolve))
  }
  return result
}

describe('the publish lays what is posted over the store (#1457)', () => {
  it('shows a posted message, its appends and its summary at once, and never waits for the commit', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('ask', 'How far?', 'user'))
    f.adapter.publish(added('reply', 'First'))
    expect(shown(f.host).messages).toMatchObject([{ id: 'ask', text: 'How far?' }, { id: 'reply', text: 'First' }])
    f.adapter.publish(appended('reply', ' and more'))
    f.adapter.publish(added('other', 'Elsewhere'), DOCS)
    const workshop = shown(f.host)
    expect(workshop.messages).toMatchObject([{ id: 'ask' }, { id: 'reply', text: 'First and more' }])
    expect(workshop.summary).toMatchObject({ messageCount: 2, lastUser: { text: 'How far?' }, lastAssistant: { text: 'First and more' } })
    // A thread no pane is looking at shows its summary from the same posted events.
    expect(shown(f.host, DOCS).summary).toMatchObject({ messageCount: 1, lastAssistant: { id: 'other', text: 'Elsewhere' } })
    // Nothing has committed: the store is behind main, and the writer holds what was posted.
    expect(storedMessages(f.directory)).toEqual([])
    expect(f.writer!.waiting).toBeGreaterThan(0)

    settle(f)
    expect(storedMessages(f.directory)).toMatchObject([{ id: 'ask' }, { id: 'reply', text: 'First' }])
    expect(shown(f.host).messages).toMatchObject([{ id: 'ask' }, { id: 'reply', text: 'First and more' }])
  })

  it('lays a reset, a replacement and an alias as the store applies them', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('one', 'Ask', 'user'))
    f.adapter.publish(added('two', 'Reply'))
    settle(f)
    f.adapter.publish(added('copy', 'Ask', 'user'))
    f.adapter.publish(aliased('copy', 'one'))
    f.adapter.publish(replaced('two', 'Reply, corrected'))
    const before = shown(f.host)
    settle(f)
    const after = shown(f.host)
    expect(before.messages).toEqual(after.messages)
    expect(before.summary).toEqual(after.summary)
    expect(after.messages).toMatchObject([{ id: 'one' }, { id: 'two', text: 'Reply, corrected' }])

    f.adapter.publish(reset())
    f.adapter.publish(added('fresh', 'Start again', 'user'))
    const held = shown(f.host)
    expect(held.messages).toMatchObject([{ id: 'fresh', text: 'Start again' }])
    expect(held.summary).toMatchObject({ messageCount: 1, lastUser: { id: 'fresh' } })
    expect(held.summary?.lastAssistant).toBeUndefined()
    settle(f)
    expect(shown(f.host).messages).toEqual(held.messages)
    expect(shown(f.host).summary).toEqual(held.summary)
  })
})

describe('a read that cannot wait answers from what is posted, or says not yet', () => {
  it('lists posted identities and history, and finds a posted user message, before the commit', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('ask', 'Question', 'user'))
    f.adapter.publish(added('reply', 'Answer'))
    expect(f.host.messageIdentities(WORKSHOP)).toEqual([{ id: 'ask', role: 'user' }, { id: 'reply', role: 'assistant' }])
    expect(f.host.threadMessages(WORKSHOP)).toMatchObject([{ id: 'ask' }, { id: 'reply', text: 'Answer' }])
    expect(f.host.threadMessage(WORKSHOP, 'reply')).toMatchObject({ text: 'Answer' })
    expect(f.host.hasRecordedUserMessage(WORKSHOP, 'ask')).toBe(true)
    expect(f.host.recordedUserMessages([{ threadId: WORKSHOP, messageId: 'ask' }])).toEqual([{ threadId: WORKSHOP, messageId: 'ask' }])
    expect(storedMessages(f.directory)).toEqual([])
  })

  it('holds a stored message and the cursor gate until the writer confirms', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Words'))
    expect(f.host.message(WORKSHOP, 'reply')).toBeUndefined()
    expect(f.host.flushEvents(WORKSHOP)).toBe(false)
    f.writer!.release()
    expect(f.host.flushEvents(WORKSHOP)).toBe(true)
    expect(f.host.message(WORKSHOP, 'reply')).toMatchObject({ text: 'Words' })
  })

  it('holds the cursor gate until the writer confirms with the Owl feature off too', async () => {
    const f = await fixture({ deferred: true, streamingPublishCost: false })
    f.adapter.publish(added('reply', 'Words'))
    f.host.workspaceSnapshot()
    expect(f.host.flushEvents(WORKSHOP)).toBe(false)
    f.writer!.release()
    expect(f.host.flushEvents(WORKSHOP)).toBe(true)
  })

  it('answers a catching-up client with what has committed, and the rest in order once it does', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Words'))
    expect(f.host.eventsAfter(0, WORKSHOP)).toEqual([])
    settle(f)
    expect(f.host.eventsAfter(0, WORKSHOP).map(row => row.event.kind)).toEqual(['message-added'])
  })

  it('reads a handover from what is posted while a write is in flight', async () => {
    const f = await fixture({ deferred: true, providerId: 'claude' })
    f.adapter.publish(added('ask', 'Carry this over', 'user'))
    f.adapter.publish(added('reply', 'Carried'))
    const held = f.host.threadHandover(WORKSHOP)
    expect(held?.summary.total).toBe(2)
    expect(held?.text).toContain('Carry this over')
    settle(f)
    expect(f.host.threadHandover(WORKSHOP)?.text).toBe(held?.text)
  })
})

describe('a read that needs the store waits for what was posted for its thread', () => {
  it('waits for the prompts above a window, the turns to widen it, Usage’s import and a visual', async () => {
    const f = await fixture({ deferred: true, providerId: 'claude' })
    f.adapter.publish(added('ask', 'First question', 'user'))
    f.adapter.publish(added('reply', 'First answer'))
    f.adapter.publish(added('next', 'Second question', 'user'))

    const prompts = f.host.threadPrompts(WORKSHOP, 'next')
    expect(await isSettled(prompts)).toBe(false)
    f.writer!.release()
    expect(await prompts).toMatchObject({ prompts: [{ id: 'ask', text: 'First question', reply: { id: 'reply' } }] })

    f.adapter.publish(added('third', 'Third question', 'user'))
    const earlier = f.host.loadEarlierMessages(WORKSHOP, 'ask')
    expect(await isSettled(earlier)).toBe(false)
    f.writer!.release()
    await earlier

    f.adapter.publish(added('fourth', 'Fourth question', 'user'))
    const seen: string[] = []
    const imported = f.host.visitRecordedUserMessages(message => seen.push(message.messageId), '2027-01-01T00:00:00.000Z')
    expect(await isSettled(imported)).toBe(false)
    f.writer!.release()
    expect(await imported).toBe(true)
    expect(seen).toEqual(expect.arrayContaining(['ask', 'next', 'third', 'fourth']))

    f.adapter.publish(added('drawn-after', 'Here is the picture'))
    const drawn = f.host.addVisual(WORKSHOP, visual('Flow'))
    expect(await isSettled(drawn)).toBe(false)
    // The words are confirmed first; then the visual is posted, and shown only once it is confirmed too.
    f.writer!.release()
    expect(await isSettled(drawn)).toBe(false)
    expect(f.writer!.waiting).toBe(1)
    f.writer!.release()
    expect(await drawn).toMatchObject({ added: true, anchor: 'assistant' })
  })

  it('waits for Watcher’s read of a thread, whose positions and epoch are the store’s', async () => {
    const f = await fixture({ deferred: true, watcher: true })
    f.adapter.publish(added('ask', 'Look at this', 'user'))
    f.adapter.publish(added('reply', 'Looked'))
    const read = f.host.watcherRead(WORKSHOP)
    expect(await isSettled(read)).toBe(false)
    const result = await pumped(f, read)
    expect(result?.messages.map(item => item.message.id)).toEqual(['ask', 'reply'])
  })

  it('commits an answer after the words it answered, even when they wait behind a batch in flight', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Asked'))
    f.host.workspaceSnapshot()
    f.adapter.publish(appended('reply', ' and asked again'))
    f.host.recordAnswer(WORKSHOP, answer('request-1'))
    settle(f)
    await pumped(f, f.host.flush())
    expect(f.host.eventsAfter(0, WORKSHOP).map(row => row.event.kind)).toEqual(['message-added', 'message-text-appended', 'answer-given'])
  })
})

describe('an answer behind a batch that failed', () => {
  it('waits with the words it answered and commits after them once their retry lands', async () => {
    const f = await fixture({ deferred: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    f.writer!.failing = write => write.kind === 'event-batches'
    f.adapter.publish(added('reply', 'Asked'))
    f.host.workspaceSnapshot()
    f.writer!.release()
    expect(f.host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
    f.host.recordAnswer(WORKSHOP, answer('request-3'))
    // Nothing is posted for the answer on its own: it waits behind the words for their retry.
    expect(f.writer!.waiting).toBe(0)
    f.writer!.failing = undefined
    await vi.advanceTimersByTimeAsync(1_000)
    f.writer!.release()
    expect(f.host.workspaceSnapshot().error).toBeUndefined()
    expect(f.host.eventsAfter(0, WORKSHOP).map(row => row.event.kind)).toEqual(['message-added', 'answer-given'])
  })
})

describe('a provider that publishes whole histories', () => {
  it('records what it published through the seam, and compares again after a failure heard late', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Whole history'), message('reply', 'assistant', 'Published whole')]
    f.adapter.emit()
    expect(shown(f.host).messages).toMatchObject([{ id: 'ask' }, { id: 'reply', text: 'Published whole' }])
    expect(storedMessages(f.directory)).toEqual([])
    f.writer!.failing = () => true
    f.writer!.release()
    expect(f.host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
    f.writer!.failing = undefined
    thread.messages = [...thread.messages, message('more', 'user', 'And then')]
    f.adapter.emit()
    settle(f)
    expect(storedMessages(f.directory).map(item => item.id)).toEqual(['ask', 'reply', 'more'])
  })
})

describe('order, failure and durability through the seam', () => {
  it('commits writes in the order they were posted, however they are released', async () => {
    const f = await fixture({ deferred: true, streamingPublishCost: false })
    for (let index = 0; index < 12; index++) {
      f.adapter.publish(added(`w${index}`, `Workshop ${index}`), WORKSHOP)
      f.adapter.publish(added(`d${index}`, `Docs ${index}`), DOCS)
      f.host.workspaceSnapshot()
      if (index % 5 === 4) f.writer!.release(2)
    }
    settle(f)
    const posted = f.writer!.log.flatMap(write => write.kind === 'events' ? write.events.map(event => `${write.threadId}:${event.kind === 'message-added' ? event.message.id : event.kind}`) : [])
    const stored = f.host.eventsAfter(0).map(row => `${row.threadId}:${row.event.kind === 'message-added' ? row.event.message.id : row.event.kind}`)
    expect(stored).toEqual(posted)
    expect(stored).toHaveLength(24)
  })

  it('keeps a failed batch waiting, retries it at a second doubling to thirty, and shows the history-save notice', async () => {
    const f = await fixture({ deferred: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    f.writer!.failing = write => write.kind === 'event-batches'
    f.adapter.publish(added('reply', 'Kept in memory'))
    f.host.workspaceSnapshot()
    expect(f.host.workspaceSnapshot().error).toBeUndefined()
    f.writer!.release()
    expect(f.host.workspaceSnapshot().error).toContain('Thread messages could not be saved')
    // The batch stays waiting, whole, and nothing else of the thread is posted ahead of its retry.
    f.adapter.publish(appended('reply', ' and more'))
    f.host.workspaceSnapshot()
    expect(f.writer!.waiting).toBe(0)
    const attempts = (): number => f.writer!.attempted.filter(write => write.kind === 'event-batches').length
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = attempts()
      await vi.advanceTimersByTimeAsync(delay - 1)
      f.writer!.release()
      expect(attempts()).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      f.writer!.release()
      expect(attempts()).toBe(before + 1)
    }
    f.writer!.failing = undefined
    await vi.advanceTimersByTimeAsync(30_000)
    f.writer!.release()
    expect(f.host.workspaceSnapshot().error).toBeUndefined()
    expect(storedMessages(f.directory)).toMatchObject([{ id: 'reply', text: 'Kept in memory and more' }])
  })

  it('reports a removal done only once it is confirmed, and commits every removal waiting for the disk', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Take this out'))
    settle(f)
    const realExec = DatabaseSync.prototype.exec
    const commits: number[] = []
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.trim() === 'COMMIT') commits.push(Number(this.prepare('PRAGMA main.synchronous').get()?.synchronous))
      return realExec.call(this, sql)
    })
    const FULL = 2
    const cleared = f.host.deleteThreads([WORKSHOP], { automatic: false, hold: () => null })
    await releaseUntilPosted(f.writer!, 'forget')
    expect(await isSettled(cleared)).toBe(false)
    // Each write ahead of it goes first; the commits the forget itself makes are read alone.
    const forget = f.writer!.log.find(write => write.kind === 'forget')!
    while (!f.writer!.attempted.includes(forget)) { commits.length = 0; f.writer!.release(1) }
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.every(level => level === FULL)).toBe(true)
    expect(await pumped(f, cleared)).toMatchObject({ deleted: [WORKSHOP] })
    expect(storedMessages(f.directory)).toEqual([])
  })

  it('takes nothing more of a thread into the store once its forget is posted, so nothing outlives the removal', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Before clearing'))
    settle(f)
    f.adapter.publish(appended('reply', ' held for the write window'))
    const cleared = f.host.deleteThreads([WORKSHOP], { automatic: false, hold: () => null })
    await releaseUntilPosted(f.writer!, 'forget')
    const forgetAt = f.writer!.log.findIndex(write => write.kind === 'forget')
    // A provider's late event, and the write window's flush, arrive while the forget is held.
    f.adapter.publish(added('late', 'Late words'))
    f.host.workspaceSnapshot()
    const flushing = f.host.flush()
    expect(await pumped(f, cleared)).toMatchObject({ deleted: [WORKSHOP] })
    await pumped(f, flushing)
    expect(f.writer!.log.slice(forgetAt + 1).filter(write => writeThreads(write).includes(WORKSHOP))).toEqual([])
    expect(storedMessages(f.directory)).toEqual([])
    const db = new DatabaseSync(join(f.directory, 'threads.sqlite'), { readOnly: true })
    try {
      expect(db.prepare("SELECT COUNT(*) AS found FROM events WHERE payload LIKE '%Late words%' OR payload LIKE '%Before clearing%' OR payload LIKE '%held for the write window%'").get()?.found).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS found FROM messages WHERE thread_id = ?').get(WORKSHOP)?.found).toBe(0)
    } finally { db.close() }
  })

  it('saves the other threads’ records, and fails nothing, when a flush meets a thread whose forget is held', async () => {
    const f = await fixture({ deferred: true })
    for (const [threadId, id] of [[WORKSHOP, 'cleared-record'], [DOCS, 'kept-record']] as const) {
      f.adapter.state.threads.find(item => item.id === threadId)!.activities = [record(id, 0)]
    }
    f.adapter.emit()
    settle(f)
    const cleared = f.host.deleteThreads([WORKSHOP], { automatic: false, hold: () => null })
    await releaseUntilPosted(f.writer!, 'forget')
    // The cleared thread's records are still in the snapshot; the save leaves them to the forget instead of failing.
    f.adapter.state.threads.find(item => item.id === DOCS)!.activities = [record('kept-record', 0), record('kept-later', 1)]
    f.adapter.emit()
    await expect(pumped(f, f.host.flush())).resolves.toBeUndefined()
    expect(await pumped(f, cleared)).toMatchObject({ deleted: [WORKSHOP] })
    settle(f)
    const db = new DatabaseSync(join(f.directory, 'threads.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('SELECT thread_id, activity_id FROM activities ORDER BY thread_id, position').all()).toEqual([
        { thread_id: DOCS, activity_id: 'kept-record' }, { thread_id: DOCS, activity_id: 'kept-later' }])
    } finally { db.close() }
  })

  it('takes the words out at the disk when history turns off, and answers once the writer has', async () => {
    let history = true
    const directory = await mkdtemp(join(tmpdir(), 'sotto-store-writer-'))
    cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const adapter = new EventProvider()
    let writer: DeferredStoreWriter | undefined
    const host = new WorkspaceHost(adapter, directory, () => history, undefined, false, false, true, store => { writer = new DeferredStoreWriter(store); writer.holding = false; return writer })
    cleanup.push(async () => { host.disconnect(); writer!.holding = false; writer!.release(); await host.close().catch(() => undefined) })
    await host.initialize(); await host.connect(); host.observeThreads([WORKSHOP])
    writer!.holding = true
    adapter.publish(added('reply', 'Private words'))
    host.workspaceSnapshot()
    history = false
    const switched = host.privacyChanged()
    await releaseUntilPosted(writer!, 'history-off')
    expect(await isSettled(switched)).toBe(false)
    const off = writer!.log.find(write => write.kind === 'history-off')!
    while (!writer!.attempted.includes(off)) writer!.release(1)
    await pumped({ directory, adapter, host, writer }, switched)
    expect(storedMessages(directory)).toEqual([])
  })

  it('closing commits everything posted before the store closes', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Said before quitting'))
    f.host.workspaceSnapshot()
    f.adapter.publish(appended('reply', ', and this'))
    f.adapter.publish(added('later', 'Behind the batch in flight'))
    f.host.recordAnswer(WORKSHOP, answer('request-2'))
    expect(f.writer!.waiting).toBeGreaterThan(0)
    f.host.disconnect()
    await pumped(f, f.host.close())
    expect(f.writer!.waiting).toBe(0)
    expect(storedMessages(f.directory)).toMatchObject([{ id: 'reply', text: 'Said before quitting, and this' }, { id: 'later' }])
  })
})

/** A small seeded generator, so a failing run can be read again exactly (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * What the file holds, in a form both writers must agree on. Event boundaries are folded, since the write window may
 * cut a streamed reply's appends differently, and sequences are left out for the same reason; a reset an activity save
 * followed is named by its place among its thread's resets.
 */
function rows(directory: string, unwrittenThreads: ReadonlySet<string> = new Set()) {
  const db = new DatabaseSync(join(directory, 'threads.sqlite'), { readOnly: true })
  try {
    const events: Record<string, unknown[]> = {}
    const resets: Record<string, number[]> = {}
    for (const row of db.prepare('SELECT seq, thread_id, payload FROM events ORDER BY seq').all()) {
      const threadId = String(row.thread_id)
      const { at: _at, ...event } = JSON.parse(String(row.payload)) as ThreadEvent & { appendText?: string; messageId?: string }
      void _at
      // Words that moved to memory when history went off, or were dropped with a thread cleared while they were held,
      // never reached this file, where the reference wrote them and took them out, keeping a record of each event it was
      // given. Those threads' logs are left out; their projection, records, visuals and wake-ups below are not.
      if (unwrittenThreads.has(threadId)) continue
      const list = events[threadId] ??= []
      const last = list.at(-1) as { kind?: string; messageId?: string; appendText?: string } | undefined
      if (event.kind === 'message-text-appended' && last?.kind === 'message-text-appended' && last.messageId === event.messageId) last.appendText += event.appendText!
      else list.push(event)
      if (event.kind === 'messages-reset') (resets[threadId] ??= []).push(Number(row.seq))
    }
    return {
      events,
      messages: db.prepare('SELECT thread_id, position, message_id, role, text, created_at, command_id, attachments, turn_message_id FROM messages ORDER BY thread_id, position').all(),
      activities: db.prepare('SELECT thread_id, activity_id, payload FROM activities ORDER BY thread_id, position').all(),
      epochs: db.prepare('SELECT thread_id, epoch, message_reset_seq FROM activity_epochs ORDER BY thread_id').all()
        .map(row => ({ ...row, message_reset_seq: row.message_reset_seq === null || unwrittenThreads.has(String(row.thread_id)) ? null : (resets[String(row.thread_id)] ?? []).filter(seq => seq <= Number(row.message_reset_seq)).length })),
      visuals: db.prepare('SELECT thread_id, anchor_message_id, anchor_user_message_id, json_extract(payload, \'$.title\') AS title FROM visuals ORDER BY seq').all(),
      wakeUps: db.prepare('SELECT thread_id, message_id FROM wake_ups ORDER BY thread_id, message_id').all(),
    }
  } finally { db.close() }
}

/** A visual's identity is drawn at random; each is named by its title instead, so two runs compare. */
function namedVisuals(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map(item => item.visual ? { ...item, id: `visual:${item.visual.title}`, visual: { ...item.visual, id: item.visual.title } } : item)
}

/** The events a workspace lays over the store for a thread, read for the comparison below and nowhere else. */
function heldEvents(host: WorkspaceHost, threadId: string): readonly ThreadEvent[] {
  return (host as unknown as { heldEvents(threadId: string, withWaitingAppends: boolean): readonly ThreadEvent[] }).heldEvents(threadId, true)
}

/** Whether a workspace still holds events for a thread that it has not posted, read for the comparison below alone. */
function waitingIn(host: WorkspaceHost, threadId: string): boolean {
  return (host as unknown as { pendingEvents: ReadonlyMap<string, unknown> }).pendingEvents.has(threadId)
}

/**
 * What each thread shows, as the publish gives it: its window, its summary and its activity records. Left out, each for
 * a reason the plan names (docs/plans/store-worker.md, step 1):
 * - the summary's record count and running turn, which are taken from the records when the summary is read again, and
 *   a confirmation that comes later reads it again sooner; the records themselves are compared;
 * - while an alias is held for a thread, its summary's count and excerpts, which show the alias once it is confirmed;
 * - while writes are held, the window's messages before the reference's first: a window asked for in turns keeps every
 *   message the events add until it is read again, and then the reference must have earlier messages too;
 * - a thread in `switched`: Keep local history changed the store it is read from, and the screen keeps what it showed
 *   until the thread is read again (ADR-0016). When that is depends on when its commits were confirmed, so it is
 *   compared again once it has had an event since the switch, which reads it again on both.
 * The driver also leaves out, while history stays off, a thread with a write in flight or words held when it went off: turning it off
 * moves what still waits to this run's memory store (ADR-0016, September 27), and words waiting behind a batch in flight
 * wait longer than the writer on main holds them, so they move to memory where the reference committed them to the file
 * and took them out. Turning history back on drops the memory store on both, and the file is compared at the end.
 */
function compareShown(reference: WorkspaceHost, later: WorkspaceHost, switched: ReadonlySet<string>): void {
  const shownBy = (host: WorkspaceHost) => new Map(host.workspaceSnapshot().threads.map(thread => [thread.id, thread]))
  const expected = shownBy(reference), received = shownBy(later)
  expect([...received.keys()]).toEqual([...expected.keys()])
  for (const [id, mine] of received) {
    if (switched.has(id)) continue
    const theirs = expected.get(id)!
    const strip = (summary: AgentThreadSummary | undefined, aliasHeld: boolean) => {
      const { activityCount: _count, runningTurnStartedAt: _running, ...rest } = summary ?? ({} as AgentThreadSummary)
      void _count; void _running
      if (!aliasHeld) return rest
      const { messageCount: _messages, lastUser: _user, lastAssistant: _assistant, lastMessageAt: _at, ...left } = rest
      void _messages; void _user; void _assistant; void _at
      return left
    }
    const aliasHeld = heldEvents(later, id).some(event => event.kind === 'message-aliased')
    expect(strip(mine.summary, aliasHeld), id).toEqual(strip(theirs.summary, aliasHeld))
    expect(mine.activities?.map(activity => activity.id), id).toEqual(theirs.activities?.map(activity => activity.id))
    const shown = namedVisuals(mine.messages), reference = namedVisuals(theirs.messages)
    const first = reference[0] ? shown.findIndex(message => message.id === reference[0]!.id) : shown.length
    if (first > 0) {
      expect(theirs.earlierAvailable, id).toBe(true)
      expect(shown.slice(first), id).toEqual(reference)
    } else {
      expect(shown, id).toEqual(reference)
      expect(mine.earlierAvailable === true, id).toBe(theirs.earlierAvailable === true)
    }
  }
}

describe('the writer on main and a writer that confirms later agree (#1457)', () => {
  it.each([1457, 1026, 2026, 3, 6, 7])('leaves the same rows and shows the same threads over a seeded run of every operation family (seed %i)', async seed => {
    const families = ['add-user', 'add-assistant', 'append', 'replace', 'reset', 'alias', 'answer', 'visual', 'activities', 'observe',
      'wake-up', 'clear', 'privacy', 'read-now', 'read-waiting', 'publish', 'flush', 'release', 'checkpoint'] as const
    type Family = typeof families[number]
    const random = mulberry32(seed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    let history = true
    const onMain = await fixture({ deferred: false, history: () => history })
    const later = await fixture({ deferred: true, history: () => history })
    // Timers wait for the test, so neither workspace's windows fire on their own, and both stamp the same instant.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const both = [onMain, later]
    const ran = new Map<Family, number>(families.map(family => [family, 0]))
    /** Comparisons and reads made while the later writer held writes: the case the overlay and the wait exist for. */
    let held = 0, compared = 0
    /** The driver's own picture of each live thread, so every event it makes is one a provider could send. */
    const model = new Map<string, AgentMessage[]>([[WORKSHOP, []], [DOCS, []]])
    let serial = 0
    /** Threads not read again since Keep local history last switched, and threads whose held words moved to memory. */
    const switched = new Set<string>(), moved = new Set<string>(), unwritten = new Set<string>()
    const unlike = (): ReadonlySet<string> => moved.size ? new Set([...switched, ...moved]) : switched
    const publish = (threadId: string, event: ThreadEvent): void => {
      switched.delete(threadId)
      for (const f of both) f.adapter.publish(structuredClone(event), threadId)
    }
    const compare = (settled: boolean): void => {
      if (settled) settle(later)
      compared++
      compareShown(onMain.host, later.host, unlike())
      // The publish posts what waited, then lays it over the store: held, if the writer still holds anything now.
      if (!settled && later.writer!.waiting > 0) held++
    }

    // The publish and the reads that cannot wait are drawn more often: they are what the overlay is for.
    const drawn: readonly Family[] = [...families, 'publish', 'publish', 'publish', 'read-now', 'read-now']
    for (let step = 0; step < 500; step++) {
      const family = pick(drawn)
      const threadId = pick([...model.keys()])
      const messages = model.get(threadId)!
      switch (family) {
        case 'add-user':
        case 'add-assistant': {
          const id = `m${++serial}`
          const role = family === 'add-user' ? 'user' : 'assistant'
          messages.push(message(id, role, `Words ${serial}`))
          publish(threadId, added(id, `Words ${serial}`, role))
          break
        }
        case 'append': {
          const last = messages.at(-1)
          if (!last) continue
          last.text += ` more ${++serial}`
          publish(threadId, appended(last.id, ` more ${serial}`))
          break
        }
        case 'replace': {
          if (!messages.length) continue
          const target = pick(messages)
          target.text = `Replaced ${++serial}`
          publish(threadId, replaced(target.id, target.text, target.role))
          break
        }
        case 'reset': {
          messages.length = 0
          publish(threadId, reset())
          const id = `m${++serial}`
          messages.push(message(id, 'user', `After reset ${serial}`))
          publish(threadId, added(id, `After reset ${serial}`, 'user'))
          break
        }
        case 'alias': {
          if (!messages.length) continue
          const canonical = pick(messages)
          const id = `copy${++serial}`
          publish(threadId, added(id, canonical.text, canonical.role))
          publish(threadId, aliased(id, canonical.id))
          break
        }
        case 'answer': {
          const event = answer(`request-${++serial}`)
          for (const f of both) f.host.recordAnswer(threadId, structuredClone(event))
          break
        }
        case 'visual': {
          if (!messages.length) continue
          const title = `Visual ${++serial}`
          const results = [await onMain.host.addVisual(threadId, visual(title)), await pumped(later, later.host.addVisual(threadId, visual(title)))]
          if (!moved.has(threadId)) expect(results[1]).toMatchObject({ added: results[0]!.added, ...(results[0]!.added ? { anchor: (results[0] as { anchor: string }).anchor } : {}) })
          break
        }
        case 'activities': {
          const records = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => record(`a${threadId}-${serial}-${index}`, index, random() < 0.2 ? 'running' : 'completed'))
          serial++
          for (const f of both) {
            const thread = f.adapter.state.threads.find(item => item.id === threadId)!
            thread.activities = structuredClone([...(thread.activities ?? []).slice(-6), ...records])
            f.adapter.emit()
          }
          break
        }
        case 'observe': {
          const live = [...model.keys()]
          const watched = live.filter(() => random() < 0.5)
          for (const f of both) f.host.observeThreads(watched)
          break
        }
        case 'wake-up': {
          const id = `wake${++serial}`
          // Babysitting's send: the wake-up is marked before the provider hears it, then the provider echoes the prompt.
          await onMain.host.execute({ type: 'send', commandId: `send-${serial}`, threadId, messageId: id, text: `Wake-up ${serial}`, wakeUp: true })
          await pumped(later, later.host.execute({ type: 'send', commandId: `send-${serial}`, threadId, messageId: id, text: `Wake-up ${serial}`, wakeUp: true }))
          for (const f of both) {
            const thread = f.adapter.state.threads.find(item => item.id === threadId)!
            thread.status = 'idle'
            f.adapter.emit()
          }
          messages.push(message(id, 'user', `Wake-up ${serial}`))
          publish(threadId, added(id, `Wake-up ${serial}`, 'user'))
          break
        }
        case 'clear': {
          // Words still held when the forget is posted go with the thread, never written; the reference wrote them first.
          if (later.writer!.unconfirmed(threadId) || waitingIn(later.host, threadId)) unwritten.add(threadId)
          const options = { automatic: false, hold: () => null }
          const results = [await onMain.host.deleteThreads([threadId], options), await pumped(later, later.host.deleteThreads([threadId], options))]
          expect(results[1]).toEqual(results[0])
          if (!results[0]!.deleted.length) break
          model.delete(threadId)
          // A thread the provider starts next takes its place, so the run keeps two threads to write to.
          const id = `session-t${++serial}`
          for (const f of both) {
            f.adapter.state.threads.push({ id, projectId: 'project', title: `Thread ${serial}`, modelId: 'fake:model', status: 'idle', messages: [], requests: [] })
            f.adapter.emit()
          }
          model.set(id, [])
          break
        }
        case 'privacy': {
          history = !history
          if (history) moved.clear()
          else for (const id of model.keys()) if (later.writer!.unconfirmed(id) || waitingIn(later.host, id)) { moved.add(id); unwritten.add(id) }
          await onMain.host.privacyChanged()
          await pumped(later, later.host.privacyChanged())
          for (const id of model.keys()) switched.add(id)
          break
        }
        case 'read-now': {
          if (moved.has(threadId)) continue
          if (later.writer!.unconfirmed(threadId)) held++
          expect(later.host.messageIdentities(threadId)).toEqual(onMain.host.messageIdentities(threadId))
          // A pane's loaded window answers both of these for a watched thread, and the screen keeps it across a switch
          // until the thread is read again (`compareShown`).
          if (switched.has(threadId)) break
          expect(namedVisuals(later.host.threadMessages(threadId))).toEqual(namedVisuals(onMain.host.threadMessages(threadId)))
          const user = messages.findLast(item => item.role === 'user')
          if (user) expect(later.host.hasRecordedUserMessage(threadId, user.id)).toBe(onMain.host.hasRecordedUserMessage(threadId, user.id))
          break
        }
        case 'read-waiting': {
          if (moved.has(threadId)) continue
          const user = messages.findLast(item => item.role === 'user')
          if (!user) continue
          expect(await pumped(later, later.host.threadPrompts(threadId, user.id))).toEqual(await onMain.host.threadPrompts(threadId, user.id))
          break
        }
        case 'publish':
          // The publish reads the store and lays what is held over it: compared as it is, with writes held.
          compare(false)
          break
        case 'flush':
          await onMain.host.flush()
          await pumped(later, later.host.flush())
          break
        case 'release':
          later.writer!.release(Math.floor(random() * 3))
          break
        case 'checkpoint':
          compare(true)
          break
      }
      ran.set(family, ran.get(family)! + 1)
    }

    for (const family of families) expect(ran.get(family), family).toBeGreaterThan(0)
    // A good share of what was compared or read was compared or read with writes held.
    expect(held).toBeGreaterThanOrEqual(20)
    expect(held / (compared + ran.get('read-now')!)).toBeGreaterThan(0.2)
    if (!history) {
      history = true
      moved.clear()
      await onMain.host.privacyChanged()
      await pumped(later, later.host.privacyChanged())
      for (const id of model.keys()) switched.add(id)
    }
    compare(true)
    await onMain.host.flush()
    await pumped(later, later.host.flush())
    for (const f of both) f.host.disconnect()
    await onMain.host.close()
    await pumped(later, later.host.close())
    expect(later.writer!.waiting).toBe(0)
    const expected = rows(onMain.directory, unwritten)
    // Clearing and history off take words out, so what is left is compared whatever it holds; it holds the log at least.
    expect(Object.keys(expected.events).length).toBeGreaterThan(0)
    expect(rows(later.directory, unwritten)).toEqual(expected)
  })
})
