// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, expectTypeOf, it, vi } from 'vitest'
import { FollowupStore, type WordWakeUp } from '../../../src/main/agents/followups'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { isBabysitNews, isWatcherNews, queuedWakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'
import { WATCHER_WAKE_UP_PROMPT } from '../../../src/main/agents/watcherNews'

it('requires stored-news callbacks to handle both babysitting and Watcher news', () => {
  expectTypeOf<WordWakeUp>().toEqualTypeOf<(news: readonly WakeUpNews[]) => string>()
  // Checked by tsc, without constructing or mutating a store at runtime.
  const rejectNarrowCallbacks = (store: FollowupStore, news: BabysitNews, word: (news: readonly BabysitNews[]) => string) => {
    // @ts-expect-error Folding can include saved Watcher news, even when this incoming item is babysitting.
    void store.queueWakeUp('thread', news, word)
    // @ts-expect-error Removing babysitting may leave only Watcher news to word.
    void store.withdrawWakeUp('thread', undefined, word)
    // @ts-expect-error Stored news and transformations must accept every source.
    void store.pruneWakeUp('item', (item: BabysitNews) => item.ended === null, word, (item: BabysitNews) => item)
  }
  expectTypeOf(rejectNarrowCallbacks).toBeFunction()
})

it('words, withdraws and prunes a stored queue containing both news sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const store = new FollowupStore(directory)
    await store.load()
    const babysit: BabysitNews = { pullRequest: { number: 1, title: 'Synthetic pull request', url: 'https://github.com/o/r/pull/1' },
      startedBy: 'user', head: 'head', changes: [], ended: null }
    const hostId = randomUUID()
    const watcher: WakeUpNews = { source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id: 'event', requestId: randomUUID(), target: { hostId, threadId: 'worker' },
        generation: 0, kind: 'turn-finished', turnId: 'turn', observedAt: new Date().toISOString() }] }
    const word = vi.fn<WordWakeUp>(items => queuedWakeUpText(items, { tool: true }))
    await store.queueWakeUp('thread', babysit, word)
    await store.queueWakeUp('thread', watcher, word)
    expect(word.mock.calls.at(-1)![0].map(isWatcherNews)).toEqual([false, true])
    await store.withdrawWakeUp('thread', babysit.pullRequest.url, word)
    expect(word.mock.calls.at(-1)![0].map(isWatcherNews)).toEqual([true])
    expect(store.peek().items[0]!.text).toBe(queuedWakeUpText([watcher], { tool: true }))
    await store.queueWakeUp('thread', babysit, word)
    const due = vi.fn((item: WakeUpNews) => !isWatcherNews(item))
    const transform = vi.fn((item: WakeUpNews) => item)
    await store.pruneWakeUp(store.peek().items[0]!.id, due, word, transform)
    expect(due.mock.calls.map(([item]) => isWatcherNews(item))).toEqual([false, true])
    expect(transform.mock.calls.map(([item]) => isWatcherNews(item))).toEqual([false, true])
    expect(store.peek().items[0]!.news).toEqual([babysit])
    expect(store.peek().items[0]!.text).toBe(queuedWakeUpText([babysit], { tool: true }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['paused', 'failed'] as const)('retains a %s wake-up explanation when pruning part of its news', async status => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const store = new FollowupStore(directory); await store.load()
    const news = (number: number): BabysitNews => ({ pullRequest: { number, title: 'Synthetic pull request', url: 'https://github.com/o/r/pull/' + number },
      startedBy: 'user', head: 'head', changes: [], ended: null })
    const word: WordWakeUp = items => queuedWakeUpText(items, { tool: true })
    await store.queueWakeUp('thread', news(1), word); await store.queueWakeUp('thread', news(2), word)
    const id = store.peek().items[0]!.id, error = 'Synthetic explanation for the held queue'
    if (status === 'paused') await store.pause('thread', error)
    else { await store.claim(id); await store.settle(id, 'failed', error) }
    await store.pruneWakeUp(id, item => isBabysitNews(item) && item.pullRequest.number === 2, word)
    expect(store.peek().items[0]).toMatchObject({ id, status, error, news: [news(2)] })
    expect(store.peek().items[0]!.text).toBe(word([news(2)]))
    await store.resume('thread')
    expect(store.peek().items[0]).toMatchObject({ status: 'queued' })
    expect(store.peek().items[0]!.error).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('sets a stopped wake-up for Watcher alone going again behind the user’s follow-ups, retries one not sent on new news, and lets an unknown one go', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const store = new FollowupStore(directory); await store.load()
    const hostId = randomUUID(), word: WordWakeUp = items => queuedWakeUpText(items, { tool: true })
    const news = (id: string): WakeUpNews => ({ source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id, requestId: randomUUID(), target: { hostId, threadId: 'worker' }, generation: 0, kind: 'turn-finished', turnId: id, observedAt: new Date().toISOString() }] })
    await store.queueWakeUp('thread', news('first'), word)
    const id = store.peek().items[0]!.id
    expect(store.peek().items[0]!.text).toBe(WATCHER_WAKE_UP_PROMPT)
    // Not sent, with the user's follow-up queued behind it while it was going.
    await store.claim(id)
    await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text: 'Synthetic user follow-up', attachments: [] })
    await store.settle(id, 'failed', 'Synthetic send failure')
    await store.reviveWakeUp(id, 'turn-after')
    expect(store.peek().items.map(item => [item.text, item.status])).toEqual([['Synthetic user follow-up', 'queued'], [WATCHER_WAKE_UP_PROMPT, 'queued']])
    expect(store.peek().items[1]).toMatchObject({ resumeAfterTurnId: 'turn-after' })
    // Not sent again: new news is a reason to try once more.
    await store.edit('thread', store.peek().items[0]!.id)
    await store.claim(id); await store.settle(id, 'failed', 'Synthetic send failure')
    // A thread's own facts moving only keep the news current: they never send it again, mid-turn or otherwise.
    const evidence: WakeUpNews = { source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id: 'evidence', requestId: randomUUID(), target: { hostId, threadId: 'worker' }, generation: 0, kind: 'evidence-changed', evidenceIds: ['fact'], revision: 'revision', observedAt: new Date().toISOString() }] }
    await store.queueWakeUp('thread', evidence, word)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'failed' })
    await store.queueWakeUp('thread', news('second'), word)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'queued' })
    // A wake-up a Stop paused starts again on news that needs Watcher, too.
    await store.pause('thread', 'Synthetic stop')
    await store.queueWakeUp('thread', evidence, word)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'paused' })
    // So does a pull request's change, which its caller says needs Watcher, though it is evidence.
    await store.pause('thread', 'Synthetic stop')
    await store.queueWakeUp('thread', evidence, word, undefined, true)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'queued' })
    await store.pause('thread', 'Synthetic stop')
    await store.queueWakeUp('thread', news('third'), word)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'queued' })
    // An unknown send is never sent twice.
    await store.claim(id); await store.settle(id, 'uncertain', 'Synthetic unknown send')
    await store.reviveWakeUp(id, 'turn-after')
    expect(store.peek().items).toEqual([])
    // A user's own follow-up is never revived.
    await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text: 'Synthetic paused follow-up', attachments: [] })
    await store.pause('thread', 'Synthetic pause')
    await store.reviveWakeUp(store.peek().items[0]!.id, 'turn-after')
    expect(store.peek().items[0]).toMatchObject({ status: 'paused' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('words a restored wake-up again from its news and saves it, leaving the user’s follow-ups as they are', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const hostId = randomUUID()
    const news: WakeUpNews = { source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id: 'event', requestId: randomUUID(), target: { hostId, threadId: 'worker' }, generation: 0, kind: 'turn-finished', turnId: 'turn', observedAt: new Date().toISOString() }] }
    // An earlier build put Watcher's news in the wake-up's words.
    const earlier = new FollowupStore(directory); await earlier.load()
    await earlier.enqueue({ threadId: 'thread', draftId: randomUUID(), text: 'Sotto saw changes, the user typed', attachments: [] })
    await earlier.queueWakeUp('thread', news, () => 'Sotto saw changes in watched threads. Synthetic earlier words')
    const store = new FollowupStore(directory); await store.load()
    await store.rewordWakeUps(item => item.wakeUp ? queuedWakeUpText(item.news ?? [], { tool: false }) : item.text)
    expect(store.peek().items.map(item => item.text)).toEqual(['Sotto saw changes, the user typed', WATCHER_WAKE_UP_PROMPT])
    const reloaded = new FollowupStore(directory); await reloaded.load()
    expect(reloaded.peek().items.map(item => item.text)).toEqual(['Sotto saw changes, the user typed', WATCHER_WAKE_UP_PROMPT])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('reorders the follow-ups the user sees around a wake-up no one is shown, and refuses an order a change overtook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const hostId = randomUUID(), store = new FollowupStore(directory); await store.load()
    const news: WakeUpNews = { source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id: 'event', requestId: randomUUID(), target: { hostId, threadId: 'worker' }, generation: 0, kind: 'turn-finished', turnId: 'turn', observedAt: new Date().toISOString() }] }
    for (const text of ['First', 'Second']) await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text, attachments: [] })
    await store.queueWakeUp('thread', news, items => queuedWakeUpText(items, { tool: false }))
    const id = (text: string) => store.peek().items.find(item => item.text === text)!.id
    // The window sends the order of what it shows: the user's two follow-ups.
    await store.reorder('thread', [id('Second'), id('First')])
    expect(store.peek().items.map(item => item.text)).toEqual(['Second', 'First', WATCHER_WAKE_UP_PROMPT])
    // An order naming every item still works.
    await store.reorder('thread', [id('First'), id(WATCHER_WAKE_UP_PROMPT), id('Second')])
    expect(store.peek().items.map(item => item.text)).toEqual(['First', 'Second', WATCHER_WAKE_UP_PROMPT])
    // A follow-up queued since the order was read is a real change.
    const stale = [id('Second'), id('First')]
    await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text: 'Third', attachments: [] })
    await expect(store.reorder('thread', stale)).rejects.toThrow('The follow-up order changed')
    expect(store.peek().items.map(item => item.text)).toEqual(['First', 'Second', 'Third', WATCHER_WAKE_UP_PROMPT])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('folds news into a wake-up no one is shown while it is sent, and keeps what the send did not carry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try {
    const hostId = randomUUID(), store = new FollowupStore(directory); await store.load()
    const word: WordWakeUp = items => queuedWakeUpText(items, { tool: false })
    const news = (id: string): WakeUpNews => ({ source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
      events: [{ id, requestId: randomUUID(), target: { hostId, threadId: `worker-${id}` }, generation: 0, kind: 'turn-finished', turnId: id, observedAt: new Date().toISOString() }] })
    await store.queueWakeUp('thread', news('first'), word)
    const id = store.peek().items[0]!.id
    await store.claim(id)
    await store.queueWakeUp('thread', news('second'), word)
    expect(store.peek().items.map(item => [item.id, item.status])).toEqual([[id, 'dispatching']])
    await store.settleSent(id, new Set(['first']), word)
    expect(store.peek().items).toHaveLength(1)
    expect(store.peek().items[0]).toMatchObject({ id, status: 'queued' })
    expect(store.peek().items[0]!.news!.flatMap(item => 'events' in item ? item.events.map(event => event.id) : [])).toEqual(['second'])
    await store.claim(id); await store.settleSent(id, new Set(['second']), word)
    expect(store.peek().items).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})