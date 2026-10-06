// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ThreadMessageLog } from '../../../src/main/agents/threadMessageLog'
import type { AgentMessage, AgentThreadSummary } from '../../../src/shared/agents'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import type { AgentActivity } from '../../../src/shared/agentActivity'

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: '2026-09-19T10:00:00.000Z' })

describe('the append path a provider rail is handed to', () => {
  it('keeps seeded aliases until their saved content is known and agrees', () => {
    const log = new ThreadMessageLog()
    const canonical = { ...message('own', 'user', 'Ask'), commandId: 'sent' }
    const duplicate = message('native', 'user', 'Ask')
    log.seed('t', [canonical, duplicate].map(({ id, role }) => ({ id, role })))
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.alias('t', 'native', 'own')
    expect(log.userMessageIds('t')).toEqual(['own', 'native'])
    const saved = new Map([['own', canonical], ['native', { ...duplicate, text: 'Different' }]])
    log.alias('t', 'native', 'own', id => saved.get(id))
    expect(log.count('t')).toBe(2)
    expect(events).toEqual([])
    saved.set('native', duplicate)
    log.alias('t', 'native', 'own', id => saved.get(id))
    expect(log.userMessageIds('t')).toEqual(['own'])
    expect(events.map(item => item.event.kind)).toEqual(['message-aliased'])
  })
  it('keeps the newest message summary when an unwatched duplicate is repaired', () => {
    const log = new ThreadMessageLog()
    const canonical = message('own', 'user', 'Ask'), duplicate = message('native', 'user', 'Ask')
    const reply = message('reply', 'assistant', 'Answer'), next = message('next', 'user', 'Another prompt')
    log.add('t', canonical); log.add('t', reply); log.add('t', next); log.add('t', duplicate)
    log.observe([])
    const saved = new Map([['own', canonical], ['reply', reply], ['next', next], ['native', duplicate]])
    log.alias('t', 'native', 'own', id => saved.get(id))
    expect(log.summary('t')).toMatchObject({ messageCount: 3, lastUser: { text: 'Another prompt' }, lastAssistant: { text: 'Answer' } })
    expect(log.lastMessageId('t')).toBe('next')
    expect(log.lastTextMessageId('t')).toBe('next')
  })
  it('reuses immutable activity facts without retaining stale messages or mutable activity facts', () => {
    const log = new ThreadMessageLog()
    const source: AgentActivity[] = [{ id: 'turn', turnId: 'turn', sequence: 0, kind: 'turn', status: 'running', title: 'Work', startedAt: '2026-09-23T10:00:00Z' }]
    const owned = immutableActivities(source)
    log.set('t', [message('a', 'assistant', 'First')])
    expect(log.summaryBeside('t', owned)).toMatchObject({ activityCount: 1, runningTurnStartedAt: source[0]!.startedAt, lastAssistant: { text: 'First' } })
    log.set('t', [message('a', 'assistant', 'First and more')])
    expect(log.summaryBeside('t', owned).lastAssistant?.text).toBe('First and more')
    const completed = immutableActivities([{ ...owned[0]!, status: 'completed' }])
    expect(log.summaryBeside('t', completed).runningTurnStartedAt).toBeUndefined()
    expect(log.summaryBeside('t', source).runningTurnStartedAt).toBe(source[0]!.startedAt)
    source[0]!.status = 'completed'
    expect(log.summaryBeside('t', source).runningTurnStartedAt).toBeUndefined()
    expect(log.summaryBeside('t', owned).runningTurnStartedAt).toBe('2026-09-23T10:00:00Z')
  })
  it('summarizes a held thread for the activity subscription without copying the messages its snapshot carries (#322)', () => {
    const log = new ThreadMessageLog()
    log.pin('t')
    log.set('t', [message('u', 'user', 'Ask'), message('a', 'assistant', 'Answer')])
    const thread: { id: string; messages: AgentMessage[]; summary?: AgentThreadSummary } = { id: 't', messages: [] }
    const published = log.publishedThread(thread)
    expect(published.messages.map(item => item.id)).toEqual(['u', 'a'])
    expect(log.activityThread(thread, false).messages.map(item => item.id)).toEqual(['u', 'a'])
    const summarized = log.activityThread(thread, true)
    expect(summarized.messages).toEqual([])
    expect(summarized.summary).toMatchObject({ messageCount: 2, lastUser: { text: 'Ask' }, lastAssistant: { text: 'Answer' } })
    // Summarizing puts nothing away: the thread is still held, and its snapshot still carries every message.
    expect(log.holding('t')).toBe(true)
    expect(log.publishedThread(thread).messages.map(item => item.id)).toEqual(['u', 'a'])
  })
  it('names the user’s newest message whether the window holds it, put it away or took it back up empty', () => {
    const log = new ThreadMessageLog()
    const thread: { id: string; messages: AgentMessage[]; lastUserMessageId?: string } = { id: 't', messages: [] }
    expect(log.publishedThread(thread)).not.toHaveProperty('lastUserMessageId')
    log.pin('t')
    log.set('t', [message('u', 'user', 'Ask'), message('a', 'assistant', 'Answer')])
    expect(log.publishedThread(thread).lastUserMessageId).toBe('u')
    // The session closes while no window looks at the thread, so its messages are put away.
    log.observe(['other']); log.release('t')
    expect(log.holding('t')).toBe(false)
    expect(log.publishedThread(thread)).toMatchObject({ messages: [], lastUserMessageId: 'u' })
    expect(log.activityThread(thread, true).lastUserMessageId).toBe('u')
    // The thread is looked at again: the window starts over empty, and the ID still comes from the facts.
    log.observe(['t'])
    expect(log.publishedThread(thread)).toMatchObject({ messages: [], lastUserMessageId: 'u' })
    log.add('t', message('u2', 'user', 'Typed in the provider'))
    expect(log.publishedThread(thread).lastUserMessageId).toBe('u2')
    // Seeded identities carry no words, and still name the user's newest message.
    log.seed('seeded', [{ id: 's0', role: 'user' }, { id: 's1', role: 'assistant' }])
    expect(log.publishedThread({ ...thread, id: 'seeded' }).lastUserMessageId).toBe('s0')
  })
  it('knows a thread has messages from seeded identities alone, and asking does not block a later seed', () => {
    const log = new ThreadMessageLog()
    expect(log.hasMessages('t')).toBe(false)
    log.seed('t', [{ id: 'u0', role: 'user' }])
    expect(log.hasMessages('t')).toBe(true)
    expect(log.lastMessageId('t')).toBeUndefined()
    log.add('other', message('a', 'assistant', 'Reply'))
    expect(log.hasMessages('other')).toBe(true)
  })
  it('treats a shorter or partial list as a partial read, never as a rewind', () => {
    const log = new ThreadMessageLog()
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.seed('t', [{ id: 'u0', role: 'user' }, { id: 'a0', role: 'assistant' }, { id: 'u1', role: 'user' }])

    // A capped poll that only reached the first turn so far.
    log.set('t', [message('u0', 'user', 'First'), message('a0', 'assistant', 'Reply')])
    // A session read afresh after a reap, arriving with the tail alone.
    log.set('t', [message('u1', 'user', 'Second'), message('a1', 'assistant', 'Second reply')])

    expect(events.map(item => item.event.kind)).not.toContain('messages-reset')
    // What the store already held was recognised; only the unseen message was added.
    expect(events.filter(item => item.event.kind === 'message-added').map(item => item.event.kind === 'message-added' ? item.event.message.id : '')).toEqual(['a1'])
  })

  it('adds what is new and appends what grew when the rail is handed over again', () => {
    const log = new ThreadMessageLog()
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.set('t', [message('u0', 'user', 'Ask'), message('a0', 'assistant', 'Par')])
    log.set('t', [message('u0', 'user', 'Ask'), message('a0', 'assistant', 'Partial reply')])
    expect(events.map(item => item.event.kind)).toEqual(['message-added', 'message-added', 'message-text-appended'])
    expect(log.messages('t').map(item => item.text)).toEqual(['Ask', 'Partial reply'])
  })
})

describe('the mark of a reply that is still growing', () => {
  it('is kept as the chunks arrive, so a re-read of the same words is recognised and a different one is not', () => {
    const log = new ThreadMessageLog()
    log.observe([])
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.add('t', message('prompt', 'user', 'Ask'))
    log.add('t', message('reply', 'assistant', 'Ind'))
    // Both append paths: a suffix the stream names, and a whole message that grew.
    log.appendText('t', 'reply', 'igo')
    log.add('t', message('reply', 'assistant', 'Indigo it'))
    for (const chunk of [' is', ', with', ' white', ' text.']) log.appendText('t', 'reply', chunk)
    // A later message moves the newest one on, so a re-read of the reply is compared by its mark alone.
    log.add('t', message('next', 'user', 'Thanks'))
    events.length = 0
    log.add('t', message('reply', 'assistant', 'Indigo it is, with white text.'))
    expect(events).toEqual([])
    log.add('t', message('reply', 'assistant', 'Indigo it is, with black text.'))
    expect(events.map(item => item.event.kind)).toEqual(['message-replaced'])
  })
  it('starts again from the words after a reply was replaced', () => {
    const log = new ThreadMessageLog()
    log.observe([])
    const events: ThreadHostEvent[] = []
    log.subscribeEvents(event => events.push(event))
    log.add('t', message('reply', 'assistant', 'First'))
    log.appendText('t', 'reply', ' draft')
    log.add('t', { ...message('reply', 'assistant', 'Second'), createdAt: '2026-09-19T10:00:01.000Z' })
    log.appendText('t', 'reply', ' take')
    log.add('t', message('next', 'user', 'Thanks'))
    events.length = 0
    log.add('t', { ...message('reply', 'assistant', 'Second take'), createdAt: '2026-09-19T10:00:01.000Z' })
    expect(events).toEqual([])
  })
})

describe('the count a publisher reads to tell a message’s first words from a chunk', () => {
  it('moves when a message says something for the first time, and not when it grows', () => {
    const log = new ThreadMessageLog()
    expect(log.recorded()).toBe(0)
    log.add('a', message('prompt', 'user', 'Ask'))
    log.add('a', message('reply', 'assistant', ''))
    expect(log.recorded()).toBe(1)
    log.appendText('a', 'reply', 'First words')
    expect(log.recorded()).toBe(2)
    log.appendText('a', 'reply', ' and more')
    log.add('b', message('other', 'user', 'Elsewhere'))
    expect(log.recorded()).toBe(3)
  })
})
