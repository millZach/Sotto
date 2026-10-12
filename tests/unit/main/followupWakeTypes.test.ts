// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, expectTypeOf, it, vi } from 'vitest'
import { FollowupStore, type WordWakeUp } from '../../../src/main/agents/followups'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { isWatcherNews, queuedWakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'

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
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
    await rm(directory, { recursive: true, force: true })
  }
})
