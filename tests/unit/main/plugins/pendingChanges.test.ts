// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { combinedSottoRequests, isSottoRequest, type SottoThreadRequests } from '../../../../src/main/agents/sottoRequests'
import { PLUGIN_CHANGE_PREFIX, PLUGIN_CHANGE_WAIT_MS, PluginChangeRequests, type PluginChangeCard } from '../../../../src/main/plugins/pendingChanges'
import type { AgentRequest } from '../../../../src/shared/agents'

afterEach(() => { vi.useRealTimers() })

const card: PluginChangeCard = {
  text: 'Comment on example-owner/example-repo #12 as you?', action: 'Comment on GitHub', target: 'example-owner/example-repo #12',
  details: 'Looks good to me.', plugin: 'GitHub', allow: 'Allow once', deny: 'Deny',
}
const only = (changes: PluginChangeRequests, threadId: string): AgentRequest => {
  const waiting = changes.requests().get(threadId) ?? []
  expect(waiting).toHaveLength(1)
  return waiting[0]!
}

describe('a plugin change waiting on the user (ADR-0205)', () => {
  it('is one of Sotto’s own permission requests in its thread, worded for a card, answered Allow once or Deny', async () => {
    const changes = new PluginChangeRequests({ now: () => new Date('2026-11-12T10:00:00.000Z') })
    const told = vi.fn()
    changes.subscribe(told)
    const answer = changes.ask('thread-one', card)
    const request = only(changes, 'thread-one')
    expect(isSottoRequest(request.id)).toBe(true)
    expect(request.id.startsWith(PLUGIN_CHANGE_PREFIX)).toBe(true)
    expect(request).toMatchObject({
      kind: 'permission', text: 'Comment on example-owner/example-repo #12 as you?', since: '2026-11-12T10:00:00.000Z',
      permissionChoices: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
      context: { toolName: 'GitHub', action: 'Comment on GitHub', target: 'example-owner/example-repo #12', details: 'Looks good to me.' },
    })
    // A permission the user may only allow once: nothing here offers to remember the answer.
    expect(request.permissionChoices!.map(choice => choice.kind)).toEqual(['allow-once', 'deny'])
    expect(told).toHaveBeenCalledTimes(1)
    changes.answer('thread-one', request.id, true)
    await expect(answer).resolves.toBe('allowed')
    expect(changes.requests().size).toBe(0)
    expect(told).toHaveBeenCalledTimes(2)
  })

  it('takes Deny, and takes no answer twice or from another thread', async () => {
    const changes = new PluginChangeRequests()
    const answer = changes.ask('thread-one', card)
    const { id } = only(changes, 'thread-one')
    expect(() => changes.answer('thread-two', id, true)).toThrow('This request is no longer pending. Refresh the thread.')
    changes.answer('thread-one', id, false)
    await expect(answer).resolves.toBe('denied')
    expect(() => changes.answer('thread-one', id, true)).toThrow('This request is no longer pending. Refresh the thread.')
  })

  it('lapses when nobody answers in time, and an answer after that is too late', async () => {
    vi.useFakeTimers()
    const changes = new PluginChangeRequests()
    const answer = changes.ask('thread-one', card)
    const { id } = only(changes, 'thread-one')
    await vi.advanceTimersByTimeAsync(PLUGIN_CHANGE_WAIT_MS - 1)
    expect(changes.requests().size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe('lapsed')
    expect(changes.requests().size).toBe(0)
    expect(() => changes.answer('thread-one', id, true)).toThrow()
  })

  it('stops an ask whose thread is deleted, and every ask when Sotto closes, and takes none after that', async () => {
    const changes = new PluginChangeRequests()
    const gone = changes.ask('thread-gone', card), kept = changes.ask('thread-kept', card)
    changes.forgetThreads(['thread-gone'])
    await expect(gone).resolves.toBe('stopped')
    expect([...changes.requests().keys()]).toEqual(['thread-kept'])
    changes.close()
    await expect(kept).resolves.toBe('stopped')
    await expect(changes.ask('thread-kept', card)).resolves.toBe('stopped')
    expect(changes.requests().size).toBe(0)
  })

  it('hands the coordinator the same map until an ask is added or ends, since it is read on every publication', () => {
    const changes = new PluginChangeRequests()
    const empty = changes.requests()
    expect(changes.requests()).toBe(empty)
    void changes.ask('thread-one', card)
    const one = changes.requests()
    expect(one).not.toBe(empty)
    expect(changes.requests()).toBe(one)
    void changes.ask('thread-one', card)
    expect(changes.requests().get('thread-one')).toHaveLength(2)
    changes.close()
  })
})

describe('Sotto’s own requests from several sources, as the coordinator reads them', () => {
  const source = (requests: ReadonlyMap<string, readonly AgentRequest[]>) => {
    const answered: [string, string, boolean][] = []
    const made: SottoThreadRequests & { answered: typeof answered; map: typeof requests } = {
      map: requests, answered, requests: () => made.map, answer: (threadId, requestId, approved) => { answered.push([threadId, requestId, approved]) }, subscribe: () => () => undefined,
    }
    return made
  }
  const request = (id: string): AgentRequest => ({ id, kind: 'permission', text: 'Ask', options: [] })

  it('is the one empty map while nothing waits, and one source’s own map while only it has something', () => {
    const setup = source(new Map()), changes = source(new Map())
    const both = combinedSottoRequests([setup, changes])
    const empty = both.requests()
    expect(empty.size).toBe(0)
    expect(both.requests()).toBe(empty)
    changes.map = new Map([['thread-one', [request('sotto:plugin-change:1')]]])
    expect(both.requests()).toBe(changes.map)
  })

  it('joins a thread’s requests from each source, and sends an answer to the source that asked', () => {
    const setup = source(new Map([['thread-one', [request('sotto:host-setup:1')]]]))
    const changes = source(new Map([['thread-one', [request('sotto:plugin-change:1')]], ['thread-two', [request('sotto:plugin-change:2')]]]))
    const both = combinedSottoRequests([setup, changes])
    const joined = both.requests()
    expect(joined.get('thread-one')!.map(entry => entry.id)).toEqual(['sotto:host-setup:1', 'sotto:plugin-change:1'])
    expect(joined.get('thread-two')!.map(entry => entry.id)).toEqual(['sotto:plugin-change:2'])
    expect(both.requests()).toBe(joined)
    both.answer('thread-one', 'sotto:plugin-change:1', true)
    both.answer('thread-one', 'sotto:host-setup:1', false)
    expect(changes.answered).toEqual([['thread-one', 'sotto:plugin-change:1', true]])
    expect(setup.answered).toEqual([['thread-one', 'sotto:host-setup:1', false]])
    expect(() => both.answer('thread-two', 'sotto:host-setup:1', true)).toThrow('This request is no longer pending. Refresh the thread.')
  })

  it('tells its listener when any source changes, and stops when unsubscribed', () => {
    const listeners: (() => void)[][] = [[], []]
    const sources = listeners.map((list): SottoThreadRequests => ({ requests: () => new Map(), answer: () => undefined, subscribe: listener => { list.push(listener); return () => { list.splice(list.indexOf(listener), 1) } } }))
    const told = vi.fn()
    const off = combinedSottoRequests(sources).subscribe(told)
    listeners[0]![0]!(); listeners[1]![0]!()
    expect(told).toHaveBeenCalledTimes(2)
    off()
    expect(listeners.map(list => list.length)).toEqual([0, 0])
  })
})
