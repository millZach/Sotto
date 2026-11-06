// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AgentThread } from '../../../../src/shared/agents'
import { parseProductEvent, type ProductEventName } from '../../../../src/main/productEvents/schema'
import { ThreadProductEvents } from '../../../../src/main/productEvents/threadEvents'

const SECRET = { title: 'Fix the secret repo', workingDirectory: '/home/someone/secret-repo', worktree: { mode: 'independent' as const, status: 'ready' as const, path: '/home/someone/secret-repo', branch: 'secret-branch' } }
const thread = (over: Partial<AgentThread> = {}): AgentThread => ({
  id: 'thread-secret-id', projectId: 'project', providerId: 'codex', modelId: 'gpt-5.5', title: 'Title', status: 'idle', messages: [], requests: [], ...over,
} as unknown as AgentThread)
const running = (over: Partial<AgentThread> = {}): AgentThread => thread({ status: 'running', lastTurn: { id: 'turn-secret-id', status: 'running' }, ...over })
const ended = (status: 'completed' | 'failed' | 'interrupted', over: Partial<AgentThread> = {}): AgentThread => thread({ status: 'idle', lastTurn: { id: 'turn-secret-id', status }, ...over })

function harness(startedBy: () => 'user' | 'watcher' = () => 'user') {
  const sent: { event: ProductEventName; properties: Record<string, unknown> }[] = []
  let clock = 1_000
  const asked = vi.fn(startedBy)
  const events = new ThreadProductEvents({ recorder: { record: (event, properties) => { sent.push({ event, properties: properties as Record<string, unknown> }) }, featureUsed: () => undefined }, startedBy: asked, now: () => clock, later: run => run() })
  events.trackAll([])
  return { events, sent, asked, advance: (ms: number) => { clock += ms } }
}

describe('thread.started', () => {
  it('goes once, when a thread Sotto made begins, with fields that pass its schema', () => {
    const { events, sent } = harness()
    const draft = thread({ nativeSessionStarted: false, reasoningEffort: 'high', runtimeMode: 'full-access', ...SECRET })
    events.track([draft], [])
    events.track([draft], [])
    expect(sent).toEqual([])
    const begun = { ...draft, nativeSessionStarted: true }
    events.track([begun], [])
    expect(sent).toEqual([])
    const turning = { ...begun, status: 'running', lastTurn: { id: 'turn', status: 'running' } } as AgentThread
    events.track([turning], [])
    events.track([turning], [])
    expect(sent).toEqual([{ event: 'thread.started', properties: { provider: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'full-access', startedBy: 'user', inWorktree: true } }])
    expect(parseProductEvent('thread.started', sent[0]!.properties)).not.toBeNull()
  })

  it('does not count a session it only found, a draft nobody sent, or a draft deleted before it began', () => {
    const { events, sent } = harness()
    events.track([running({ nativeSessionStarted: true }), running({ id: 'found' })], [])
    events.track([thread({ id: 'draft', nativeSessionStarted: false })], [])
    events.track([], ['draft'])
    events.track([running({ id: 'draft' })], [])
    expect(sent).toEqual([])
  })

  it('does not count a thread whose first turn never begins', () => {
    const { events, sent } = harness()
    events.track([thread({ nativeSessionStarted: false })], [])
    events.track([thread({ nativeSessionStarted: true })], [])
    events.track([thread({ nativeSessionStarted: true, status: 'error' })], [])
    expect(sent).toEqual([])
  })

  it('counts a draft saved before a restart when it begins afterwards', () => {
    const { sent, events } = harness()
    events.trackAll([thread({ id: 'saved', nativeSessionStarted: false })])
    events.track([running({ id: 'saved', nativeSessionStarted: true })], [])
    expect(sent.map(item => item.event)).toEqual(['thread.started'])
  })
})

describe('turn.completed', () => {
  it.each([['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'stopped']] as const)('a turn that ends %s says %s, with its length', (status, result) => {
    const { events, sent, advance } = harness()
    events.track([running()], [])
    advance(1_234)
    events.track([ended(status)], [])
    expect(sent).toEqual([{ event: 'turn.completed', properties: { provider: 'codex', model: 'gpt-5.5', startedBy: 'user', speed: 'standard', result, durationMs: 1_234 } }])
    expect(parseProductEvent('turn.completed', sent[0]!.properties)).not.toBeNull()
  })

  it('goes once per turn, and only when it stops running', () => {
    const { events, sent, advance } = harness()
    events.track([running()], [])
    for (let index = 0; index < 50; index += 1) { advance(10); events.track([running()], []) }
    expect(sent).toEqual([])
    const end = ended('completed')
    events.track([end], []); events.track([end], [])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.properties.durationMs).toBe(500)
  })

  it('treats a turn replaced while running, as a steer does, as the same turn', () => {
    const { events, sent, advance } = harness()
    events.track([running()], [])
    advance(100)
    events.track([running({ lastTurn: { id: 'steered', status: 'running' } })], [])
    advance(100)
    events.track([ended('completed', { lastTurn: { id: 'steered', status: 'completed' } })], [])
    expect(sent.map(item => item.properties.durationMs)).toEqual([200])
  })

  it('waits while the provider says idle but the turn has not ended', () => {
    const { events, sent } = harness()
    events.track([running()], [])
    events.track([thread({ status: 'idle', lastTurn: { id: 'turn-secret-id', status: 'running' } })], [])
    expect(sent).toEqual([])
    events.track([ended('completed')], [])
    expect(sent).toHaveLength(1)
  })

  it('counts two turns when a steer carries the thread past the first one\'s end', () => {
    const { events, sent, advance } = harness()
    events.track([running()], [])
    advance(100)
    events.track([running({ lastTurn: { id: 'turn-secret-id', status: 'completed' } })], [])
    expect(sent.map(item => item.properties.durationMs)).toEqual([100])
    events.track([running({ lastTurn: { id: 'steered', status: 'running' } })], [])
    advance(50)
    events.track([ended('failed', { lastTurn: { id: 'steered', status: 'failed' } })], [])
    expect(sent.map(item => [item.properties.durationMs, item.properties.result])).toEqual([[100, 'completed'], [50, 'failed']])
  })

  it('does not call a turn a success when its outcome is lost, as a reconnect can lose it, and counts the next', () => {
    const { events, sent } = harness()
    events.track([running()], [])
    events.track([thread({ status: 'idle' })], [])
    events.track([thread({ status: 'error' })], [])
    expect(sent).toEqual([])
    events.track([running()], [])
    events.track([ended('completed')], [])
    expect(sent).toHaveLength(1)
  })

  it('says failed when the thread is in error, whatever the turn says', () => {
    const { events, sent } = harness()
    events.track([running()], [])
    events.track([thread({ status: 'error', lastTurn: { id: 'turn-secret-id', status: 'completed' } })], [])
    expect(sent[0]!.properties.result).toBe('failed')
  })

  it('does not count history read back, a thread going running with no turn, or a turn it did not see start', () => {
    const { events, sent } = harness()
    events.track([ended('completed')], [])
    events.track([thread({ status: 'running' })], [])
    events.track([ended('completed', { lastTurn: { id: 'other', status: 'completed' } })], [])
    expect(sent).toEqual([])
  })

  it('does not count a turn already running when Sotto started, and counts the next', () => {
    const sent: unknown[] = []
    const events = new ThreadProductEvents({ recorder: { record: (event, properties) => { sent.push([event, properties]) }, featureUsed: () => undefined }, startedBy: () => 'user', now: () => 0, later: run => run() })
    events.trackAll([running()])
    events.track([ended('completed')], [])
    expect(sent).toEqual([])
    events.track([running({ lastTurn: { id: 'next', status: 'running' } })], [])
    events.track([ended('completed', { lastTurn: { id: 'next', status: 'completed' } })], [])
    expect(sent).toHaveLength(1)
  })

  it('forgets a running turn whose thread went, in an update or from a whole snapshot', () => {
    const { events, sent } = harness()
    events.track([running()], [])
    events.track([], ['thread-secret-id'])
    events.track([ended('completed')], [])
    events.track([running()], [])
    events.trackAll([])
    events.track([ended('completed')], [])
    expect(sent).toEqual([])
  })

  it('reports what the turn spent, not the thread\'s totals', () => {
    const { events, sent } = harness()
    const usage = (input: number, cached: number, output: number) => ({ total: { input, cached, output }, rateVersions: [], partial: false, updatedAt: '2026-11-02T00:00:00.000Z' })
    events.track([running({ usage: usage(1_000, 500, 100) })], [])
    events.track([ended('completed', { usage: usage(1_500, 800, 160) })], [])
    expect(sent[0]!.properties).toMatchObject({ inputTokens: 500, cachedInputTokens: 300, outputTokens: 60 })
  })

  it('counts a first turn from nothing, but no later turn whose totals it never read', () => {
    const { events, sent } = harness()
    const usage = { total: { input: 900_000, output: 50_000 }, rateVersions: [], partial: false, updatedAt: '2026-11-02T00:00:00.000Z' }
    events.track([thread({ nativeSessionStarted: false })], [])
    events.track([running({ nativeSessionStarted: true })], [])
    events.track([ended('completed', { usage })], [])
    expect(sent[1]!.properties).toMatchObject({ inputTokens: 900_000, outputTokens: 50_000 })
    events.track([running({ id: 'later' })], [])
    events.track([ended('completed', { id: 'later', usage })], [])
    expect(sent[2]!.properties).not.toHaveProperty('inputTokens')
  })

  it('leaves out totals that went down, since a rewind makes the difference meaningless', () => {
    const { events, sent } = harness()
    const usage = (input: number) => ({ total: { input }, rateVersions: [], partial: false, updatedAt: '2026-11-02T00:00:00.000Z' })
    events.track([running({ usage: usage(1_000) })], [])
    events.track([ended('completed', { usage: usage(10) })], [])
    expect(sent[0]!.properties).not.toHaveProperty('inputTokens')
  })
})

describe('what a thread event may say', () => {
  it('leaves out a model not on the public list, and an effort not on its list, rather than losing the event', () => {
    const { events, sent } = harness()
    const custom = { modelId: 'my-private-finetune', reasoningEffort: 'my-private-effort' }
    events.track([thread({ ...custom, nativeSessionStarted: false })], [])
    events.track([running({ ...custom, nativeSessionStarted: true })], [])
    expect(sent[0]!.properties).not.toHaveProperty('model')
    expect(sent[0]!.properties).not.toHaveProperty('effort')
    expect(parseProductEvent('thread.started', sent[0]!.properties)).not.toBeNull()
  })

  it('never carries anything the thread says, its IDs, its folder or its branch', () => {
    const { events, sent } = harness()
    const words = { ...SECRET, messages: [{ id: 'm', role: 'user', text: 'my secret prompt' }], summary: { lastUser: { id: 'm', text: 'my secret prompt' } }, providerSessionId: 'session-secret' } as unknown as Partial<AgentThread>
    events.track([thread({ ...words, nativeSessionStarted: false })], [])
    events.track([running({ ...words, nativeSessionStarted: true })], [])
    events.track([ended('failed', words)], [])
    expect(sent.map(item => item.event)).toEqual(['thread.started', 'turn.completed'])
    expect(JSON.stringify(sent)).not.toMatch(/secret|\/home|m"/)
  })

  it('never asks who started a thread during an update: on a later tick, and with the record as the update had it', () => {
    const later: (() => void)[] = []
    const sent: unknown[] = [], asked = vi.fn(() => 'user' as const)
    const events = new ThreadProductEvents({ recorder: { record: (_event, properties) => { sent.push(properties) }, featureUsed: () => undefined }, startedBy: asked, now: () => 0, later: run => { later.push(run) } })
    events.trackAll([])
    events.track([running()], [])
    events.track([ended('failed')], [])
    expect(asked).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    for (const run of later) run()
    expect(sent).toMatchObject([{ result: 'failed', startedBy: 'user' }])
  })

  it('keeps a record it cannot read from stopping the update', () => {
    const { events, sent } = harness()
    events.track([thread({ nativeSessionStarted: false })], [])
    const breaking = Object.defineProperty({ ...running(), nativeSessionStarted: true }, 'modelId', { get: () => { throw new Error('no') } }) as AgentThread
    expect(() => events.track([breaking], [])).not.toThrow()
    expect(sent).toEqual([])
  })

  it('goes on the next tick by itself', async () => {
    const sent: unknown[] = []
    const events = new ThreadProductEvents({ recorder: { record: (_event, properties) => { sent.push(properties) }, featureUsed: () => undefined }, startedBy: () => 'user', now: () => 0 })
    events.trackAll([])
    events.track([running()], [])
    events.track([ended('completed')], [])
    expect(sent).toEqual([])
    await new Promise(resolve => setImmediate(resolve))
    expect(sent).toHaveLength(1)
  })

  it('asks who started a thread only as a turn begins and ends, never per update, and survives anything thrown', () => {
    const { events, asked, sent } = harness(() => { throw new Error('no') })
    expect(() => events.track([running()], [])).not.toThrow()
    expect(asked).toHaveBeenCalledOnce()
    for (let index = 0; index < 100; index += 1) events.track([running()], [])
    expect(asked).toHaveBeenCalledOnce()
    expect(() => events.track([ended('completed')], [])).not.toThrow()
    expect(asked).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([])
  })
})

describe('the features a thread uses', () => {
  const recorder = () => {
    const features: string[] = []
    return { features, recorder: { record: () => undefined, featureUsed: (feature: string) => { features.push(feature) } } as never }
  }

  it.each(['watcher', 'delegation', 'council', 'swarm'] as const)('a turn on a thread %s started says that feature is in use', startedBy => {
    const { features, recorder: sink } = recorder()
    const events = new ThreadProductEvents({ recorder: sink, startedBy: () => startedBy, now: () => 0, later: run => run() })
    events.trackAll([])
    events.track([running()], [])
    events.track([running()], [])
    expect(features).toEqual([startedBy])
  })

  it('says nothing for the user\'s own thread, or for a turn already running when Sotto started', () => {
    const { features, recorder: sink } = recorder()
    const mine = new ThreadProductEvents({ recorder: sink, startedBy: () => 'user', now: () => 0, later: run => run() })
    mine.trackAll([]); mine.track([running()], [])
    const earlier = new ThreadProductEvents({ recorder: sink, startedBy: () => 'watcher', now: () => 0, later: run => run() })
    earlier.trackAll([running()])
    expect(features).toEqual([])
  })
})
