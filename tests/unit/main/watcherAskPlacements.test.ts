// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { watcherAskPlacements } from '../../../src/main/agents/watcherAskPlacements'
import { WATCHER_WAKE_UP_PROMPT, watcherNewsText } from '../../../src/main/agents/watcherNews'
import type { AgentMessage } from '../../../src/shared/agents'
import { watcherToolSchemas, type WatcherRecord } from '../../../src/shared/watcher'
import { WATCHER_ASKS_MAX, watcherAsksOf, type WatcherAsk } from '../../../src/shared/watcherAsks'
import type { WatcherEvent } from '../../../src/shared/watcherNews'

const HOST = '11111111-1111-4111-8111-111111111111'
const REQUEST = '22222222-2222-4222-8222-222222222222'
const AT = '2026-10-19T10:00:00.000Z'
const ask = (requestCardId: string, threadId = 'worker'): WatcherAsk => ({ target: { hostId: HOST, threadId }, requestCardId, kind: 'question' })
const user = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'user', text: `Asked ${id}`, createdAt: AT, ...extra })
const reply = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'assistant', text: `Replied ${id}`, createdAt: AT, ...extra })
const wakeUp = (id: string, asks: WatcherAsk[] = []): AgentMessage => user(id, { text: WATCHER_WAKE_UP_PROMPT, wakeUp: true, ...(asks.length ? { watcherAsks: asks } : {}) })
const event = (id: string, extra: Partial<WatcherEvent>): WatcherEvent =>
  ({ id, kind: 'needs-user', requestId: REQUEST, target: { hostId: HOST, threadId: 'worker' }, generation: 0, observedAt: AT, ...extra })

describe('where a waiting request’s card shows in Watcher’s conversation', () => {
  it('goes under the reply of the turn its wake-up began, since the wake-up itself is shown nowhere', () => {
    const placed = watcherAskPlacements({ messages: [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1'), ask('card-2', 'other')]), reply('r2a'), reply('r2b'), user('u2'), reply('r3')] })
    expect(placed).toEqual([{ ...ask('card-1'), messageId: 'r2b', wakeUpMessageId: 'w1' }, { ...ask('card-2', 'other'), messageId: 'r2b', wakeUpMessageId: 'w1' }])
  })

  it('goes under the last shown message before the wake-up while Watcher has not replied, and under a shown wake-up itself', () => {
    expect(watcherAskPlacements({ messages: [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')]), reply('empty', { text: '' })] }).map(item => item.messageId)).toEqual(['r1'])
    const resumed = user('w2', { text: 'Sotto restarted. Review the last turn.', wakeUp: true, watcherAsks: [ask('card-1')] })
    expect(watcherAskPlacements({ messages: [user('u1'), resumed] }).map(item => item.messageId)).toEqual(['w2'])
  })

  it('goes under the reply that came after the user wrote into the wake-up’s running turn, never back before the wake-up', () => {
    const messages = [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')]), user('steer'), reply('r2')]
    expect(watcherAskPlacements({ messages, status: 'idle' }).map(item => item.messageId)).toEqual(['r2'])
  })

  it('never crosses a message that began a turn of its own, a wake-up or one the record ties to a turn', () => {
    const turns = { current: { target: { hostId: HOST, threadId: 'watcher' } },
      promptTurns: [{ id: 't2', watcher: { hostId: HOST, threadId: 'watcher' }, rootUserMessageId: 'u2' }] } as unknown as Pick<WatcherRecord, 'promptTurns' | 'current'>
    expect(watcherAskPlacements({ messages: [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')]), user('u2'), reply('r2')], status: 'idle' }, turns)
      .map(item => item.messageId)).toEqual(['r1'])
    expect(watcherAskPlacements({ messages: [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')]), wakeUp('w2'), reply('r2')], status: 'idle' })
      .map(item => item.messageId)).toEqual(['r1'])
  })

  it('waits for the reply while the wake-up’s turn still runs, so the card does not move once it shows', () => {
    const messages = [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')])]
    expect(watcherAskPlacements({ messages, status: 'running' })).toEqual([])
    expect(watcherAskPlacements({ messages: [...messages, reply('r2')], status: 'running' }).map(item => item.messageId)).toEqual(['r2'])
    // A turn that ended without a reply keeps its card in view, under the last message shown before it.
    expect(watcherAskPlacements({ messages, status: 'idle' }).map(item => item.messageId)).toEqual(['r1'])
  })

  it('reads a history again only when it changed', () => {
    const messages = [user('u1'), reply('r1'), wakeUp('w1', [ask('card-1')]), reply('r2')]
    const first = watcherAskPlacements({ messages, status: 'idle' })
    expect(watcherAskPlacements({ messages, status: 'idle' })).toBe(first)
    expect(watcherAskPlacements({ messages: [...messages], status: 'idle' })).toEqual(first)
  })

  it('places nothing for a history with no asks, or a wake-up with nothing shown before or after it', () => {
    expect(watcherAskPlacements({ messages: [user('u1'), wakeUp('w1'), reply('r1')] })).toEqual([])
    expect(watcherAskPlacements(undefined)).toEqual([])
    expect(watcherAskPlacements({ messages: [wakeUp('w1', [ask('card-1')])] })).toEqual([])
  })
})

describe('the asks a wake-up carries', () => {
  it('are the needs-user events’ threads and requests, once each, and nothing else', () => {
    const asks = watcherAsksOf([
      event('e1', { requestCardId: 'card-1', requestCardKind: 'permission' }),
      event('e2', { requestCardId: 'card-1', requestCardKind: 'permission', revision: 'later' }),
      event('e3', { kind: 'turn-finished', turnId: 't1' }),
      event('e4', { requestCardId: 'card-2', requestCardKind: 'question', target: { hostId: HOST, threadId: 'remote-worker' } }),
    ])
    expect(asks).toEqual([{ target: { hostId: HOST, threadId: 'worker' }, requestCardId: 'card-1', kind: 'permission' },
      { target: { hostId: HOST, threadId: 'remote-worker' }, requestCardId: 'card-2', kind: 'question' }])
    expect(watcherAsksOf(Array.from({ length: WATCHER_ASKS_MAX + 5 }, (_, index) => event(`e${index}`, { requestCardId: `card-${index}`, requestCardKind: 'question' }))))
      .toHaveLength(WATCHER_ASKS_MAX)
  })
})

describe('Watcher answers nothing', () => {
  it('has no tool that answers a request, and its news still says only the user answers', () => {
    expect(Object.keys(watcherToolSchemas).filter(name => /answer|approve|allow|permission|respond/iu.test(name))).toEqual([])
    const text = watcherNewsText({ source: 'watcher', watcher: { hostId: HOST, threadId: 'watcher' }, omitted: 0,
      events: [event('e1', { requestCardId: 'card-1', requestCardKind: 'question' })] })
    expect(text).toContain('Only the user can answer it.')
    expect(text).toContain('answers no request')
  })
})
