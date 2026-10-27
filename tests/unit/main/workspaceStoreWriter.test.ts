// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_LIMIT_MS } from '../../../src/main/agents/storeWorker'
import { eventsOfWrite, writeThreads } from '../../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { DeferredStoreWriter } from '../../fixtures/deferredStoreWriter'
import { added, aliased, answer, appended, cleanUp, cleanup, DOCS, EventProvider, fixture, message, isSettled, pumped, record, releaseUntilPosted, replaced, reset, runEquivalence, settle, shown, storedMessages, visual, WORKSHOP } from '../../fixtures/storeWriterEquivalence'

// The seam every thread-store write goes through (#1457, step 1 of docs/plans/store-worker.md). These tests run the
// workspace over a writer that holds each confirmation until the test releases it, the way the store worker does.

afterEach(cleanUp)

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

  it('answers a stored message from what is posted, and holds the cursor gate until the writer confirms', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Words'))
    f.host.workspaceSnapshot()
    f.adapter.publish(appended('reply', ' and more'))
    f.adapter.publish(added('copy', 'Words and more'))
    f.adapter.publish(aliased('copy', 'reply'))
    // One message is read with what is posted for it laid over it, so an adapter that cannot wait, such as Codex
    // aliasing a rollout's duplicate, finds the message while the thread is busy (step 2 of docs/plans/store-worker.md).
    expect(f.host.message(WORKSHOP, 'reply')).toMatchObject({ text: 'Words and more' })
    expect(f.host.message(WORKSHOP, 'copy')).toBeUndefined()
    expect(f.host.flushEvents(WORKSHOP)).toBe(false)
    settle(f)
    expect(f.host.flushEvents(WORKSHOP)).toBe(true)
    expect(f.host.message(WORKSHOP, 'reply')).toMatchObject({ text: 'Words and more' })
  })

  it('says not yet for a stored message while words wait behind a batch that failed', async () => {
    const f = await fixture({ deferred: true })
    f.writer!.failing = write => write.kind === 'event-batches'
    f.adapter.publish(added('reply', 'Words'))
    f.host.workspaceSnapshot()
    f.writer!.release()
    expect(f.host.message(WORKSHOP, 'reply')).toBeUndefined()
    f.writer!.failing = undefined
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
  it('holds an answer behind a history write in flight, and behind one that failed until its retry lands', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Asked'), message('reply', 'assistant', 'Answered with a question')]
    f.adapter.emit()
    f.host.recordAnswer(WORKSHOP, answer('request-1'))
    const answers = () => f.writer!.log.filter(write => eventsOfWrite(write, WORKSHOP).some(event => event.kind === 'answer-given')).length
    // The history write is in flight, so the answer waits behind it rather than going with it.
    expect(answers()).toBe(0)
    f.writer!.failing = write => eventsOfWrite(write, WORKSHOP).some(event => event.kind === 'message-added')
    f.writer!.release()
    f.host.workspaceSnapshot()
    // The history failed: the answer still waits, for the comparison that retries it.
    expect(answers()).toBe(0)
    f.writer!.failing = undefined
    thread.messages = [...thread.messages]
    f.adapter.emit()
    settle(f)
    const kinds = f.writer!.attempted.map(write => eventsOfWrite(write, WORKSHOP).map(event => event.kind).join(','))
      .filter(kind => kind.includes('message-added') || kind.includes('answer-given'))
    expect(kinds.at(-1)).toBe('answer-given')
    expect(kinds.filter(kind => kind.includes('message-added'))).toHaveLength(2)
    expect(storedMessages(f.directory).map(item => item.id)).toEqual(['ask', 'reply'])
  })

  it('holds a history write behind an answer in flight, and posts it once the answer lands', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Asked')]
    f.adapter.emit()
    settle(f)
    f.host.recordAnswer(WORKSHOP, answer('request-1'))
    const posted = f.writer!.log.length
    thread.messages = [...thread.messages, message('reply', 'assistant', 'After the answer')]
    f.adapter.emit()
    // The answer is in flight: the history the host published waits for it.
    expect(f.writer!.log.slice(posted)).toEqual([])
    f.writer!.release()
    expect(f.writer!.log.slice(posted).map(write => eventsOfWrite(write, WORKSHOP).map(event => event.kind))).toEqual([['message-added']])
    settle(f)
    expect(storedMessages(f.directory).map(item => item.id)).toEqual(['ask', 'reply'])
  })

  it('publishes once a history write is confirmed, so a client catching up reads the commit', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Pushed before it committed')]
    f.adapter.emit()
    await vi.advanceTimersByTimeAsync(5_000)
    let publishes = 0
    const unsubscribe = f.host.subscribe(() => { publishes++ })
    publishes = 0
    f.writer!.release()
    await vi.advanceTimersByTimeAsync(5_000)
    unsubscribe()
    expect(publishes).toBeGreaterThan(0)
    expect(f.host.eventsAfter(0, WORKSHOP).map(item => item.event.kind)).toContain('message-added')
  })
  it('holds a second answer behind the history it answers when that history waits behind the first answer', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'First question')]
    f.adapter.emit()
    settle(f)
    f.host.recordAnswer(WORKSHOP, answer('request-a'))
    // The provider asks again while the first answer is in flight, so its history waits; then the second answer comes.
    thread.messages = [...thread.messages, message('ask-b', 'assistant', 'Second question')]
    f.adapter.emit()
    f.host.recordAnswer(WORKSHOP, answer('request-b'))
    settle(f)
    const order = f.writer!.attempted.flatMap(write => eventsOfWrite(write, WORKSHOP))
      .flatMap(event => event.kind === 'answer-given' ? [event.requestId] : event.kind === 'message-added' ? [event.message.id] : [])
    expect(order).toEqual(['ask', 'request-a', 'ask-b', 'request-b'])
  })

  it('lets answers go once a comparison finds the store already holds the history whose write failed', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Asked')]
    f.adapter.emit()
    settle(f)
    // An append that fails, an answer behind it, then the provider back at the history the store already holds.
    thread.messages = [message('ask', 'user', 'Asked, and more')]
    f.adapter.emit()
    f.writer!.failing = write => eventsOfWrite(write, WORKSHOP).some(event => event.kind === 'message-text-appended')
    f.writer!.release()
    f.writer!.failing = undefined
    f.host.recordAnswer(WORKSHOP, answer('request-1'))
    thread.messages = [message('ask', 'user', 'Asked')]
    f.adapter.emit()
    settle(f)
    expect(f.host.eventsAfter(0, WORKSHOP).map(item => item.event.kind)).toEqual(['message-added', 'answer-given'])
  })

  it('retries a failed history write on its own a second later, and the answer behind it follows', async () => {
    const f = await fixture({ deferred: true, wholeHistories: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const thread = f.adapter.state.threads.find(item => item.id === WORKSHOP)!
    thread.messages = [message('ask', 'user', 'Asked before a failed save')]
    f.adapter.emit()
    f.writer!.failing = () => true
    f.writer!.release()
    f.writer!.failing = undefined
    f.host.recordAnswer(WORKSHOP, answer('request-1'))
    // The provider says nothing more: the retry is the workspace's own.
    for (let second = 0; second < 5; second++) { await vi.advanceTimersByTimeAsync(1_000); settle(f) }
    expect(f.host.eventsAfter(0, WORKSHOP).map(item => item.event.kind)).toEqual(['message-added', 'answer-given'])
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

  it('stops waiting for a writer that never answers a minute after closing began, and says what was not saved', async () => {
    const f = await fixture({ deferred: true })
    f.adapter.publish(added('reply', 'Never answered'))
    f.host.workspaceSnapshot()
    expect(f.writer!.waiting).toBeGreaterThan(0)
    // A store worker that has stopped answering: nothing posted is ever confirmed, even when closing asks.
    f.writer!.drain = () => undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    f.host.disconnect()
    let failure: unknown
    const closing = f.host.close().catch((error: unknown) => { failure = error })
    await vi.advanceTimersByTimeAsync(CLOSE_LIMIT_MS - 1_000)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    await closing
    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).message)).toContain('Thread messages could not be saved')
    expect(warn).toHaveBeenCalledWith('thread-store-close-timed-out')
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

describe('the writer on main and a writer that confirms later agree (#1457)', () => {
  it.each([1457, 1026, 2026, 3, 6, 7])('leaves the same rows and shows the same threads over a seeded run of every operation family (seed %i)', async seed => {
    await runEquivalence(seed)
  })
})
