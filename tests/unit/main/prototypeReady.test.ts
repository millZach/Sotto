// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PROTOTYPES_CLEARED_MAX, PrototypeReady } from '../../../src/main/agents/prototypeReady'
import type { PageSearch } from '../../../src/main/agents/questionPages'
import type { AgentHostSnapshot, AgentMessage, AgentRequest, AgentThread, QuestionPage } from '../../../src/shared/agents'

// A prototype waiting for review (ADR-0108): the coordinator marks a thread whose newest reply, from a turn that has
// ended, names a working page, or whose waiting question carries one. The mark stays until the user opens one of its
// pages or replies, and a page opened is remembered by its source.

const page = (token: string, name = 'greeting.html'): QuestionPage => ({ token: token.padEnd(32, 'x'), kind: 'file', name, start: name })
const assistant = (id: string, text = 'The prototype is at docs/greeting.html', createdAt = '2026-10-22T10:00:00.000Z'): AgentMessage => ({ id, role: 'assistant', text, createdAt })
const user = (id: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'user', text: 'Looks good', createdAt: '2026-10-22T10:05:00.000Z', ...extra })
const question = (id: string): AgentRequest => ({ id, kind: 'question', text: 'Which variant?', options: [] })

function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread', title: 'Greeting', projectId: 'project', modelId: 'm', status: 'idle', messages: [assistant('reply')], requests: [], ...overrides }
}
const snapshot = (...threads: AgentThread[]): AgentHostSnapshot => ({ connected: true, projects: [], models: [], threads } as unknown as AgentHostSnapshot)

/** A stand-in for QuestionPages: what each source's search found, and which source each token belongs to. */
function searches(found: Record<string, readonly QuestionPage[]> = {}) {
  const results = new Map(Object.entries(found))
  return {
    results,
    searched: (threadId: string, source: string): PageSearch | undefined => {
      const working = results.get(`${threadId}\n${source}`)
      return working && { finished: true, pages: working, working, aboutPrototype: false }
    },
    source: (token: string) => {
      for (const [key, pages] of results) if (pages.some(item => item.token === token)) { const [threadId, source] = key.split('\n'); return { threadId: threadId!, source: source! } }
      return undefined
    },
  }
}
const markOf = (marks: PrototypeReady, shown: AgentHostSnapshot, id = 'thread') => marks.decorate(shown).threads.find(item => item.id === id)?.prototypeReady

describe('PrototypeReady', () => {
  it('marks a thread whose ended turn’s newest reply names a working page, and only then', () => {
    const pages = [page('a')]
    const fresh = () => new PrototypeReady(searches({ 'thread\nreply:reply': pages }))
    expect(markOf(fresh(), snapshot(thread()))).toEqual({ source: 'reply:reply', pages })
    expect(markOf(fresh(), snapshot(thread({ status: 'running' })))).toBeUndefined()
    expect(markOf(fresh(), snapshot(thread({ requests: [{ id: 'p', kind: 'permission', text: 'Run it?', options: [] }] })))).toBeUndefined()
    expect(markOf(fresh(), snapshot(thread({ kind: 'watcher' })))).toBeUndefined()
    expect(markOf(fresh(), snapshot(thread({ workspaceSettledAt: '2026-10-22T11:00:00.000Z' })))).toBeUndefined()
    expect(markOf(fresh(), snapshot(thread({ messages: [assistant('reply'), user('u'), assistant('later', 'Done.')] })))).toBeUndefined()
  })

  it('keeps the mark while the thread runs, through a newer reply that names no page, and while a question without one waits', () => {
    const pages = [page('a')]
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': pages }))
    expect(markOf(marks, snapshot(thread()))).toEqual({ source: 'reply:reply', pages })
    expect(markOf(marks, snapshot(thread({ status: 'running', messages: [assistant('reply'), user('wake', { wakeUp: true })] })))).toEqual({ source: 'reply:reply', pages })
    const later = [assistant('reply'), user('wake', { wakeUp: true }), assistant('later', 'Done.')]
    expect(markOf(marks, snapshot(thread({ messages: later })))).toEqual({ source: 'reply:reply', pages })
    expect(markOf(marks, snapshot(thread({ messages: later, requests: [question('q')] })))).toEqual({ source: 'reply:reply', pages })
  })

  it('moves the mark to a newer reply that names a working page, and a waiting question with one still comes first', () => {
    const found = searches({ 'thread\nreply:reply': [page('a')] })
    const marks = new PrototypeReady(found)
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    found.results.set('thread\nreply:newer', [page('n')])
    const newer = [assistant('reply'), user('wake', { wakeUp: true }), assistant('newer')]
    expect(markOf(marks, snapshot(thread({ messages: newer })))?.source).toBe('reply:newer')
    found.results.set('thread\nrequest:q', [page('q')])
    expect(markOf(marks, snapshot(thread({ messages: newer, requests: [question('q')] })))?.source).toBe('request:q')
  })

  it('ends a kept mark when the user replies after it, and not for a wake-up Sotto sent', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    const woken = [assistant('reply'), user('wake'), assistant('later', 'Done.')]
    expect(markOf(marks, snapshot(thread({ messages: woken, wakeUpMessageIds: ['wake'] })))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread({ messages: [...woken, user('u')], wakeUpMessageIds: ['wake'], status: 'running' })))).toBeUndefined()
    expect(markOf(marks, snapshot(thread({ messages: [...woken, user('u'), assistant('after', 'Done again.')], wakeUpMessageIds: ['wake'] })))).toBeUndefined()
  })

  it('ends a kept mark by the summary’s last user message when the thread carries no messages', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    const lastAssistant = { id: 'later', text: 'Done.', createdAt: '2026-10-22T10:10:00.000Z' }
    const summarized = (lastUser: { id: string; createdAt: string }, wakeUpMessageIds: string[] = []) => thread({ messages: [], wakeUpMessageIds,
      summary: { messageCount: 4, activityCount: 0, lastAssistant, lastUser: { ...lastUser, text: 'Hi' } } })
    expect(markOf(marks, snapshot(summarized({ id: 'wake', createdAt: '2026-10-22T10:05:00.000Z' }, ['wake'])))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(summarized({ id: 'u', createdAt: '2026-10-22T10:05:00.000Z' })))).toBeUndefined()
  })

  it('names a kept reply for its pages to be kept, beside the newest reply while that could earn the mark', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    markOf(marks, snapshot(thread()))
    const ask = (item: AgentThread) => marks.replies(snapshot(item))(item)
    expect(ask(thread())).toEqual({ id: 'reply', text: 'The prototype is at docs/greeting.html' })
    const running = thread({ status: 'running', messages: [assistant('reply'), user('wake', { wakeUp: true })] })
    markOf(marks, snapshot(running))
    expect(ask(running)).toEqual({ id: 'reply', text: 'The prototype is at docs/greeting.html' })
    const later = thread({ messages: [assistant('reply'), user('wake', { wakeUp: true }), assistant('later', 'Done.')] })
    markOf(marks, snapshot(later))
    expect(ask(later)).toEqual([{ id: 'later', text: 'Done.' }, { id: 'reply', text: 'The prototype is at docs/greeting.html' }])
    // Known only by its ID, a kept reply is read whole from the thread's store.
    const elsewhere = thread({ messages: [], summary: { messageCount: 4, activityCount: 0, lastAssistant: { id: 'later', text: 'Done.', createdAt: '2026-10-22T10:10:00.000Z' } } })
    expect(ask(elsewhere)).toEqual([{ id: 'later', summary: 'Done.' }, { id: 'reply' }])
  })

  it('saves kept marks and takes them back, so a restart keeps a prototype the thread has run on from', () => {
    const found = searches({ 'thread\nreply:reply': [page('a')] })
    const marks = new PrototypeReady(found)
    markOf(marks, snapshot(thread()))
    const later = thread({ status: 'running', messages: [assistant('reply'), user('wake', { wakeUp: true }), assistant('later', 'Done.')] })
    expect(markOf(marks, snapshot(later))?.source).toBe('reply:reply')
    expect(marks.marked()).toEqual([{ threadId: 'thread', messageId: 'reply', createdAt: '2026-10-22T10:00:00.000Z' }])
    const restarted = new PrototypeReady(found)
    restarted.restore([], undefined, marks.marked())
    // A thread that carries no history yet names nothing, so no search is made before there are words to read.
    const loading = thread({ status: 'running', messages: [] })
    expect(restarted.replies(snapshot(loading))(loading)).toBeUndefined()
    // Before the restarted coordinator has read the thread, the kept reply goes by its ID: QuestionPages reads its words.
    expect(restarted.replies(snapshot(later))(later)).toEqual({ id: 'reply' })
    expect(markOf(restarted, snapshot(later))?.source).toBe('reply:reply')
  })

  it('forgets a kept mark when the user answers a question asked after it, or the thread settles', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread({ requests: [question('q')] })))?.source).toBe('reply:reply')
    marks.answered('thread')
    expect(markOf(marks, snapshot(thread({ status: 'running' })))).toBeUndefined()
    expect(marks.marked()).toEqual([])
    const settles = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(settles, snapshot(thread()))?.source).toBe('reply:reply')
    expect(markOf(settles, snapshot(thread({ workspaceSettledAt: '2026-10-22T11:00:00.000Z' })))).toBeUndefined()
    expect(settles.marked()).toEqual([])
  })

  it('names the reply to look in only while it could earn the mark', () => {
    const marks = new PrototypeReady(searches())
    const ask = (item: AgentThread) => marks.replies(snapshot(item))(item)
    expect(ask(thread())).toEqual({ id: 'reply', text: 'The prototype is at docs/greeting.html' })
    expect(ask(thread({ messages: [], summary: { messageCount: 1, activityCount: 0, lastAssistant: { id: 'reply', text: 'See docs/greeting.html', createdAt: '2026-10-22T10:00:00.000Z' } } })))
      .toEqual({ id: 'reply', summary: 'See docs/greeting.html' })
    expect(ask(thread({ status: 'running' }))).toBeUndefined()
    expect(ask(thread({ requests: [question('q')] }))).toBeUndefined()
    expect(ask(thread({ messages: [assistant('reply'), user('u')] }))).toBeUndefined()
    expect(ask(thread({ kind: 'watcher-history' }))).toBeUndefined()
    // A visual is Sotto's, not the agent's words: the reply before it is the newest.
    expect(ask(thread({ messages: [assistant('reply'), { ...assistant('visual:1', ''), visual: { kind: 'diagram' } } as unknown as AgentMessage] }))).toMatchObject({ id: 'reply' })
  })

  it('ends the mark when the user replies after it, but not for a wake-up Sotto sent', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread({ messages: [assistant('reply'), user('u')] })))).toBeUndefined()
    expect(markOf(marks, snapshot(thread({ messages: [assistant('reply'), user('wake')], wakeUpMessageIds: ['wake'] })))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread({ messages: [assistant('reply'), user('wake', { wakeUp: true })] })))?.source).toBe('reply:reply')
  })

  it('reads a reply after it from the summary by time when the thread carries no messages', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    const lastAssistant = { id: 'reply', text: 'See docs/greeting.html', createdAt: '2026-10-22T10:00:00.000Z' }
    const summarized = (lastUser?: { id: string; createdAt: string }, wakeUpMessageIds?: string[]) => thread({ messages: [], ...(wakeUpMessageIds ? { wakeUpMessageIds } : {}),
      summary: { messageCount: 2, activityCount: 0, lastAssistant, ...(lastUser ? { lastUser: { ...lastUser, text: 'Hi' } } : {}) } })
    expect(markOf(marks, snapshot(summarized()))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(summarized({ id: 'before', createdAt: '2026-10-22T09:00:00.000Z' })))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(summarized({ id: 'after', createdAt: '2026-10-22T10:01:00.000Z' })))).toBeUndefined()
    expect(markOf(marks, snapshot(summarized({ id: 'wake', createdAt: '2026-10-22T10:01:00.000Z' }, ['wake'])))?.source).toBe('reply:reply')
  })

  it('prefers a waiting question with a working page, with the question’s own tokens', () => {
    const asked = [page('q')]
    const marks = new PrototypeReady(searches({ 'thread\nrequest:q': asked, 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread({ requests: [question('q')] })))).toEqual({ source: 'request:q', pages: asked })
    // A question whose search found nothing that works marks nothing, and the reply cannot while the question waits.
    expect(markOf(marks, snapshot(thread({ requests: [question('other')] })))).toBeUndefined()
    // A request Sotto put in the thread is not the agent's question.
    const sotto = new PrototypeReady(searches({ 'thread\nrequest:sotto:host-setup': [page('s')] }))
    expect(markOf(sotto, snapshot(thread({ messages: [], requests: [question('sotto:host-setup')] })))).toBeUndefined()
  })

  it('clears the mark when one of its pages is opened, remembers that by its source, and keeps it through a restart', () => {
    const pages = [page('a'), page('b', 'other.html')]
    const found = searches({ 'thread\nreply:reply': pages })
    const marks = new PrototypeReady(found)
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    expect(marks.opened('z'.repeat(32))).toBe(false)
    expect(marks.opened(pages[1]!.token)).toBe(true)
    expect(marks.opened(pages[0]!.token)).toBe(false)
    expect(markOf(marks, snapshot(thread()))).toBeUndefined()
    expect(marks.replies(snapshot(thread()))(thread())).toBeUndefined()
    expect(marks.saved()).toEqual([{ threadId: 'thread', source: 'reply:reply' }])
    const restarted = new PrototypeReady(found, marks.saved())
    expect(markOf(restarted, snapshot(thread()))).toBeUndefined()
    // A newer reply with its own pages earns the mark again.
    found.results.set('thread\nreply:newer', [page('c')])
    expect(markOf(restarted, snapshot(thread({ messages: [assistant('reply'), user('u'), assistant('newer')] })))?.source).toBe('reply:newer')
  })

  it('takes answering a question as replying to the reply before it', () => {
    const marks = new PrototypeReady(searches({ 'thread\nrequest:q': [page('q')], 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread({ requests: [question('q')] })))?.source).toBe('request:q')
    // The user answers it: the turn goes on, and if it ends with no newer reply, the reply before the question is answered.
    marks.answered('thread')
    expect(markOf(marks, snapshot(thread({ status: 'running' })))).toBeUndefined()
    expect(markOf(marks, snapshot(thread()))).toBeUndefined()
    expect(marks.saved()).toEqual([{ threadId: 'thread', source: 'reply:reply' }])
  })

  it('keeps the mark when a question leaves without the user answering it: sent back by Sotto, or withdrawn by the provider', () => {
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': [page('a')] }))
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread({ requests: [question('q')] })))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread({ status: 'running' })))?.source).toBe('reply:reply')
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
    expect(marks.saved()).toEqual([])
    // Answering a permission is not replying either.
    marks.answered('elsewhere')
    expect(markOf(marks, snapshot(thread()))?.source).toBe('reply:reply')
  })

  it('keeps the snapshot and its threads when nothing changes, and takes a mark off a thread that loses it', () => {
    const pages = [page('a')]
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': pages }))
    const quiet = snapshot(thread({ id: 'quiet', messages: [assistant('nothing', 'Done.')] }))
    expect(marks.decorate(quiet)).toBe(quiet)
    const shown = marks.decorate(snapshot(thread(), thread({ id: 'quiet' })))
    expect(marks.decorate(shown)).toBe(shown)
    const replied = { ...shown, threads: [{ ...shown.threads[0]!, messages: [assistant('reply'), user('u')] }, shown.threads[1]!] }
    const after = marks.decorate(replied)
    expect(after.threads[0]).not.toHaveProperty('prototypeReady')
    expect(after.threads[1]).toBe(replied.threads[1])
  })

  it('reads each thread a bounded number of times however many threads have a waiting question', () => {
    const marks = new PrototypeReady(searches())
    const reads = (count: number): number => {
      const threads = Array.from({ length: count }, (_, index) => thread({ id: `thread-${index}`, requests: [question('q')] }))
      let read = 0
      const counted = new Proxy(threads, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) read++; return Reflect.get(target, key, receiver) } })
      marks.decorate(snapshot(...threads))
      marks.decorate({ ...snapshot(), threads: counted })
      return read
    }
    expect(reads(400) / 400).toBeLessThanOrEqual(reads(40) / 40 + 1)
  })

  it('keeps the newest opened sources once the list is full', () => {
    const saved = Array.from({ length: PROTOTYPES_CLEARED_MAX + 5 }, (_, index) => ({ threadId: 'thread', source: `reply:${index}` }))
    const marks = new PrototypeReady(searches(), saved)
    expect(marks.saved()).toHaveLength(PROTOTYPES_CLEARED_MAX)
    expect(marks.saved()[0]!.source).toBe('reply:5')
  })

  it('marks no reply written before marks began, so the first start does not mark every old thread; a waiting question still counts', () => {
    const pages = [page('a')]
    const began = Date.parse('2026-10-22T12:00:00.000Z')
    const marks = new PrototypeReady(searches({ 'thread\nreply:reply': pages, 'thread\nrequest:q': pages }), [], began)
    expect(markOf(marks, snapshot(thread()))).toBeUndefined()
    expect(marks.replies(snapshot(thread()))(thread())).toBeUndefined()
    const later = thread({ messages: [assistant('reply', 'See docs/greeting.html', '2026-10-22T12:00:01.000Z')] })
    expect(markOf(marks, snapshot(later))).toEqual({ source: 'reply:reply', pages })
    expect(markOf(marks, snapshot(thread({ requests: [question('q')] })))).toEqual({ source: 'request:q', pages })
    // The time marks began is saved and taken back, so a restart keeps it.
    const restarted = new PrototypeReady(searches({ 'thread\nreply:reply': pages }), [], Date.parse('2026-10-23T00:00:00.000Z'))
    restarted.restore([], marks.since())
    expect(restarted.since()).toBe(began)
    expect(markOf(restarted, snapshot(later))).toEqual({ source: 'reply:reply', pages })
  })
})
