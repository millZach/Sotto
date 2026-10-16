// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { foldWakeUpNews, isBabysitNews, isDelegationNews, queuedWakeUpText, wakeUpNewsSchema, type WakeUpNews } from '../../../src/main/agents/wakeUp'
import { DELEGATION_NEWS_MAX, delegatedThreadsBelow, type DelegationNews } from '../../../src/shared/delegation'

const news = (delegationId: string, outcome: DelegationNews['items'][number]['outcome'], threadId = 'delegated'): DelegationNews =>
  ({ source: 'delegation', items: [{ delegationId, threadId, outcome }] })

it('tells a delegation\'s outcome by identities alone and says how to read the reply', () => {
  const id = randomUUID()
  const text = queuedWakeUpText([news(id, 'answered')], { tool: false })
  expect(text).toContain(`Delegation ${id} to thread delegated answered. Call read_delegation`)
  expect(text).toMatch(/carries none of the delegated threads' words, and it approves nothing/u)
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
