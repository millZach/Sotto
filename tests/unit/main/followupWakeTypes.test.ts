// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, expectTypeOf, it, vi } from 'vitest'
import { FollowupStore, type WordWakeUp } from '../../../src/main/agents/followups'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { isBabysitNews, isWatcherNews, queuedWakeUpText, wakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'
import { WATCHER_WAKE_UP_PROMPT, watcherNewsText } from '../../../src/main/agents/watcherNews'
import { RESUME_NOTE } from '../../../src/shared/restartResume'

async function inDirectory(test: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-wake-types-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-wake-types-')) throw new Error('Unexpected fixture path')
  try { await test(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const hostId = randomUUID()
const babysit = (number = 1): BabysitNews => ({ pullRequest: { number, title: 'Synthetic pull request', url: `https://github.com/o/r/pull/${number}` },
  startedBy: 'user', head: 'head', changes: [], ended: null })
const watcher = (...ids: string[]): Extract<WakeUpNews, { source: 'watcher' }> => ({ source: 'watcher', watcher: { hostId, threadId: 'thread' }, omitted: 0,
  events: ids.map(id => ({ id, requestId: randomUUID(), target: { hostId, threadId: `worker-${id}` }, generation: 0, kind: 'turn-finished' as const, turnId: id, observedAt: new Date().toISOString() })) })
const word: WordWakeUp = items => queuedWakeUpText(items, { tool: true })

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

it('keeps Watcher’s news in a wake-up of its own that no news joins, and that withdrawing, pruning and pausing pass by', () => inDirectory(async directory => {
  const store = new FollowupStore(directory); await store.load()
  await store.queueWakeUp('thread', babysit(), word)
  await store.queueWakeUp('thread', watcher('first'), word)
  // Two items, never one mixed: the hidden one says only Sotto's short message.
  expect(store.peek().items.map(item => item.news!.map(isWatcherNews))).toEqual([[false], [true]])
  const hidden = store.peek().items[1]!
  expect(hidden.text).toBe(WATCHER_WAKE_UP_PROMPT)
  // A second is refused, while the first waits and while it is sent: news waits in Watcher's own news instead.
  await expect(store.queueWakeUp('thread', watcher('second'), word)).rejects.toThrow('Watcher already has news on its way.')
  await store.withdrawWakeUp('thread', babysit().pullRequest.url, word)
  await store.claim(hidden.id)
  await expect(store.queueWakeUp('thread', watcher('third'), word)).rejects.toThrow('Watcher already has news on its way.')
  // Pull request news never folds into it either.
  await store.queueWakeUp('thread', babysit(2), word)
  expect(store.peek().items.map(item => [item.id === hidden.id, item.status, item.news!.map(isWatcherNews)]))
    .toEqual([[true, 'dispatching', [true]], [false, 'queued', [false]]])
  expect(store.peek().items[0]!.news).toEqual(hidden.news)
  // A pause holds the user's queue and passes it by: no one could resume it.
  await store.removeWakeUp(hidden.id)
  await store.queueWakeUp('thread', watcher('fourth'), word)
  await store.pause('thread', 'Synthetic stop')
  expect(store.peek().items.map(item => [isWatcherNews(item.news![0]!), item.status])).toEqual([[false, 'paused'], [true, 'queued']])
  // It leaves whole; a user's follow-up is never taken for it.
  await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text: 'Synthetic user follow-up', attachments: [] })
  await store.removeWakeUp(store.peek().items.find(item => item.text === 'Synthetic user follow-up')!.id)
  await store.removeWakeUp(store.peek().items.find(item => item.text === WATCHER_WAKE_UP_PROMPT)!.id)
  expect(store.peek().items.map(item => item.text)).toEqual(['Synthetic user follow-up', word([babysit(2)])])
}))

it.each(['paused', 'failed'] as const)('retains a %s wake-up explanation when pruning part of its news', status => inDirectory(async directory => {
  const store = new FollowupStore(directory); await store.load()
  await store.queueWakeUp('thread', babysit(1), word); await store.queueWakeUp('thread', babysit(2), word)
  const id = store.peek().items[0]!.id, error = 'Synthetic explanation for the held queue'
  if (status === 'paused') await store.pause('thread', error)
  else { await store.claim(id); await store.settle(id, 'failed', error) }
  await store.pruneWakeUp(id, item => isBabysitNews(item) && item.pullRequest.number === 2, word)
  expect(store.peek().items[0]).toMatchObject({ id, status, error, news: [babysit(2)] })
  expect(store.peek().items[0]!.text).toBe(word([babysit(2)]))
  await store.resume('thread')
  expect(store.peek().items[0]).toMatchObject({ status: 'queued' })
  expect(store.peek().items[0]!.error).toBeUndefined()
}))

it('takes Watcher’s news out of every queue an earlier build saved, keeping a mixed wake-up’s other words, and returns its events', () => inDirectory(async directory => {
  const now = new Date().toISOString()
  const item = (patch: Record<string, unknown>): Record<string, unknown> => ({ id: randomUUID(), threadId: 'thread', draftId: randomUUID(), attachments: [], status: 'queued',
    wakeUp: true, createdAt: now, updatedAt: now, ...patch })
  const items = [
    item({ text: 'Synthetic user follow-up', wakeUp: undefined }),
    // Main's: a wake-up with Watcher's news in its words.
    item({ text: watcherNewsText(watcher('legacy')), news: [watcher('legacy')] }),
    // Mixed: a resume note, pull request news and Watcher's news in one, worded together.
    item({ text: `${RESUME_NOTE}\n\n${watcherNewsText(watcher('mixed'))}`, news: [{ source: 'restart', since: now, resumes: 1 }, watcher('mixed')] }),
    item({ threadId: 'other', text: [wakeUpText([babysit()], { tool: false }), watcherNewsText(watcher('pulled'))].join('\n\n'), news: [babysit(), watcher('pulled')] }),
    // This branch's earlier rounds: hidden, with what it kept beside the news, two for one Watcher, one being sent.
    item({ text: WATCHER_WAKE_UP_PROMPT, news: [watcher('kept', 'facts')], attention: ['kept'], carried: ['kept'], attempts: 2, status: 'dispatching', commandId: randomUUID(), messageId: randomUUID() }),
    item({ text: WATCHER_WAKE_UP_PROMPT, news: [watcher('second')], status: 'paused', error: 'Synthetic stop' }),
    // A thread no longer here keeps everything it had.
    item({ threadId: 'dormant', text: WATCHER_WAKE_UP_PROMPT, news: [watcher('dormant')] }),
  ]
  await writeFile(join(directory, 'followups.json'), JSON.stringify({ items, receipts: [] }))
  const store = new FollowupStore(directory); await store.load(undefined, undefined, thread => thread !== 'dormant')
  const dropped = await store.dropWatcherNews(news => queuedWakeUpText(news, { tool: false }))
  expect(dropped.map(event => event.id).sort()).toEqual(['facts', 'kept', 'legacy', 'mixed', 'pulled', 'second'])
  const left = store.peek().items
  expect(left.map(entry => [entry.threadId, entry.text])).toEqual([['thread', 'Synthetic user follow-up'], ['thread', RESUME_NOTE],
    ['other', wakeUpText([babysit()], { tool: false })], ['dormant', WATCHER_WAKE_UP_PROMPT]])
  expect(left.filter(entry => entry.threadId !== 'dormant').some(entry => entry.news?.some(isWatcherNews))).toBe(false)
  // Saved so, and the dormant thread's item whole as it was.
  const saved = JSON.parse(await readFile(join(directory, 'followups.json'), 'utf8')) as { items: { threadId: string; text: string; news?: unknown[] }[] }
  expect(saved.items.map(entry => entry.text)).toEqual(left.map(entry => entry.text))
  expect(saved.items.find(entry => entry.threadId === 'dormant')!.news).toEqual(items.find(entry => entry.threadId === 'dormant')!.news)
  // Nothing left to take: nothing written.
  const write = vi.spyOn((store as unknown as { store: { write: (value: unknown) => Promise<void> } }).store, 'write')
  expect(await store.dropWatcherNews(word)).toEqual([])
  expect(write).not.toHaveBeenCalled()
}))

it('reorders the follow-ups the user sees around a wake-up no one is shown, and refuses an order a change overtook', () => inDirectory(async directory => {
  const store = new FollowupStore(directory); await store.load()
  for (const text of ['First', 'Second']) await store.enqueue({ threadId: 'thread', draftId: randomUUID(), text, attachments: [] })
  await store.queueWakeUp('thread', watcher('event'), items => queuedWakeUpText(items, { tool: false }))
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
}))
