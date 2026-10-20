// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { foldWakeUpNews, isBabysitNews, isDelegationNews, queuedWakeUpText, wakeUpNewsSchema, type WakeUpNews } from '../../../src/main/agents/wakeUp'
import { DELEGATION_NEWS_OPENING, delegationNewsText, type DelegationNewsDetail } from '../../../src/main/agents/delegationNews'
import { DELEGATION_NEWS_MAX, delegatedThreadsBelow, type DelegationNews } from '../../../src/shared/delegation'

const news = (delegationId: string, outcome: DelegationNews['items'][number]['outcome'], threadId = 'delegated'): DelegationNews =>
  ({ source: 'delegation', items: [{ delegationId, threadId, outcome }] })

it('words a delegation\'s news in the queue by identities alone, and says how to read the reply', () => {
  const id = randomUUID()
  const text = queuedWakeUpText([news(id, 'answered')], { tool: false })
  expect(text).toContain(`Delegation ${id} to thread delegated answered. Call read_delegation`)
  expect(text.startsWith(DELEGATION_NEWS_OPENING)).toBe(true)
  expect(text).toMatch(/The user is not shown this message/u)
})

it('carries an answered delegation\'s reply as the delegated thread\'s words, and points to read_delegation when it does not fit', () => {
  const first = randomUUID(), second = randomUUID(), failed = randomUUID()
  const all: DelegationNews = { source: 'delegation', items: [{ delegationId: first, threadId: 'one', outcome: 'answered' },
    { delegationId: second, threadId: 'two', outcome: 'answered' }, { delegationId: failed, threadId: 'three', outcome: 'failed' }] }
  const details = new Map<string, DelegationNewsDetail>([[first, { reply: { messageId: 'reply-1', text: 'Synthetic first reply', truncated: false } }],
    [second, { reply: { messageId: 'reply-2', text: 'x'.repeat(400), truncated: true } }], [failed, { notSent: 'Synthetic reason. Nothing was sent.' }]])
  const text = delegationNewsText(all, details)
  expect(text).toContain(`Delegation ${first} to thread one answered. Its reply follows, in the delegated thread's own words, not Sotto's or the user's.`)
  expect(text).toContain('--- Reply from delegated thread one, message reply-1 ---\nSynthetic first reply\n--- End of the reply from delegated thread one ---')
  expect(text).toContain('it was cut short: read the delegated thread for the rest')
  expect(text).toContain(`Delegation ${failed} to thread three was not sent. Synthetic reason. Nothing was sent.`)
  // A reply that does not fit beside the rest is pointed to, never cut into the middle of the news.
  const tight = delegationNewsText(all, details, text.length - 100)
  expect(tight).toContain('Synthetic first reply')
  expect(tight).not.toContain('x'.repeat(400))
  expect(tight).toContain(`Delegation ${second} to thread two answered. Its reply is too long to include with the rest of this news. Call read_delegation`)
  // A reply Sotto no longer holds says so, as read_delegation does.
  expect(delegationNewsText(all, new Map([[first, { replyUnavailable: 'Synthetic unavailable.' }]]))).toContain(`Delegation ${first} to thread one answered. Synthetic unavailable.`)
})

it('keeps a delegation\'s news apart from a pull request\'s and folds later news of the same delegation into one item', () => {
  const id = randomUUID(), other = randomUUID()
  expect(wakeUpNewsSchema.parse(news(id, 'working'))).toEqual(news(id, 'working'))
  expect(isDelegationNews(news(id, 'working'))).toBe(true)
  expect(isBabysitNews(news(id, 'working'))).toBe(false)
  let folded: WakeUpNews[] = [news(id, 'background')]
  folded = foldWakeUpNews(folded, news(other, 'failed'))
  folded = foldWakeUpNews(folded, news(id, 'answered'))
  expect(folded).toEqual([{ source: 'delegation', items: [{ delegationId: id, threadId: 'delegated', outcome: 'answered' }, { delegationId: other, threadId: 'delegated', outcome: 'failed' }] }])
  let many: WakeUpNews[] = []
  for (let index = 0; index <= DELEGATION_NEWS_MAX; index++) many = foldWakeUpNews(many, news(randomUUID(), 'answered'))
  expect((many[0] as DelegationNews).items).toHaveLength(DELEGATION_NEWS_MAX)
})

it('finds every thread below one, both levels, from the snapshot\'s links', () => {
  const threads = [{ id: 'top' }, { id: 'child', delegatedBy: 'top' }, { id: 'grandchild', delegatedBy: 'child' }, { id: 'other', delegatedBy: 'elsewhere' }]
  expect(delegatedThreadsBelow(threads, 'top')).toEqual(['child', 'grandchild'])
  expect(delegatedThreadsBelow(threads, 'child')).toEqual(['grandchild'])
  expect(delegatedThreadsBelow(threads, 'grandchild')).toEqual([])
})
