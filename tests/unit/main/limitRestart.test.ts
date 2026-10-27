// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIMIT_RESTART_RETRY_MS, LimitRestart, type LimitRestartControl } from '../../../src/main/agents/limitRestart'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { LIMIT_RESTART_GRACE_MS, LIMIT_RESTART_HORIZON_MS, LIMIT_RESTARTS_IN_A_ROW_MAX, limitRestartNote, type LimitRestartNews } from '../../../src/shared/limitRestart'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'

/**
 * Restarting threads a usage limit stopped (ADR-0144): a turn that ended at a usage limit is recorded with when its limit
 * resets, the thread carries its scheduled restart, one timer waits for the reset, and then each thread still waiting gets
 * one note from Sotto, Watcher's first. The record keeps thread IDs and times only.
 */
const roots: string[] = []; const restarts: LimitRestart[] = []
afterEach(async () => {
  for (const restart of restarts.splice(0)) await restart.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-limit-restart-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})

const START = Date.parse('2026-10-26T20:00:00.000Z')
const thread = (id: string, patch: Partial<AgentThread> = {}): AgentThread => ({ id, title: id, projectId: 'project', modelId: 'claude:test', providerId: 'claude',
  status: 'running', messages: [], requests: [], lastTurn: { id: `${id}-1`, status: 'running' }, ...patch })
const limitStop = (id: string, resetsAt?: string, turn = `${id}-1`): Partial<AgentThread> =>
  ({ status: 'error', lastTurn: { id: turn, status: 'failed', limitStop: resetsAt ? { resetsAt } : {} } })

async function fixture(options: { threads?: AgentThread[]; enabled?: () => boolean; watcher?: string; saved?: unknown; deliver?: (id: string) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-limit-restart-')); roots.push(root)
  if (options.saved) await writeFile(join(root, 'limit-restarts.json'), JSON.stringify(options.saved))
  let now = START
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = []
  const host: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, threads: options.threads ?? [thread('workshop')],
    providers: [{ id: 'claude', connection: 'connected', name: 'Claude Code', version: '', capabilities: EMPTY_AGENT_HOST.capabilities }] }
  const delivered: { threadId: string; news: LimitRestartNews }[] = []
  const told: { provider: string; threadIds: readonly string[] }[] = []
  const control: LimitRestartControl = {
    host: () => host, thread: id => host.threads.find(item => item.id === id),
    deliverWakeUp: async (threadId, news) => { await options.deliver?.(threadId); delivered.push({ threadId, news }) },
  }
  const restart = new LimitRestart({ directory: root, control, enabled: options.enabled ?? (() => true), watcherThreadId: () => options.watcher,
    restarted: (provider, threadIds) => told.push({ provider, threadIds }), now: () => now,
    schedule: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } } })
  restarts.push(restart)
  await restart.start()
  /** Sees the threads as the coordinator would hand them over after a change. */
  const read = (): void => restart.track(host, host.threads)
  const update = (id: string, patch: Partial<AgentThread>): void => {
    host.threads = host.threads.map(item => item.id === id ? { ...item, ...patch } : item); read()
  }
  const live = () => timers.filter(timer => !timer.cancelled)
  /** Moves the clock to the soonest timer and runs it, as its wait ending would. */
  const fire = async (): Promise<void> => {
    const timer = live().at(-1)
    if (!timer) throw new Error('No timer is set.')
    now += timer.delay; timer.cancelled = true; timer.callback(); await restart.settled()
  }
  const saved = async (): Promise<unknown[]> => {
    try { return (JSON.parse(await readFile(join(root, 'limit-restarts.json'), 'utf8')) as { threads: unknown[] }).threads } catch { return [] }
  }
  read()
  return { root, host, restart, read, update, live, fire, saved, delivered, told, advance: (ms: number) => { now += ms } }
}

describe('restarting threads a usage limit stopped', () => {
  it('schedules a stopped turn for its reset plus the grace, and publishes the reset on the thread', async () => {
    const f = await fixture()
    const reset = new Date(START + 3 * 60 * 60_000).toISOString()
    f.update('workshop', limitStop('workshop', reset))
    const scheduled = { provider: 'claude', stoppedAt: new Date(START).toISOString(), at: new Date(Date.parse(reset)).toISOString() }
    expect(f.restart.publish(f.host.threads[0]!).scheduledRestart).toEqual(scheduled)
    expect(f.live()).toEqual([expect.objectContaining({ delay: 3 * 60 * 60_000 + LIMIT_RESTART_GRACE_MS })])
    // The record is thread IDs and times only.
    await expect.poll(f.saved).toEqual([{ threadId: 'workshop', ...scheduled, at: new Date(Date.parse(reset) + LIMIT_RESTART_GRACE_MS).toISOString(), restarts: 0 }])
    // Published as the same object while nothing moved, so a broadcast lists the thread as it did.
    const once = f.restart.publish(f.host.threads[0]!)
    expect(f.restart.publish(once)).toBe(once)
  })

  it('does not take a stop a thread already showed when first seen as news', async () => {
    const f = await fixture({ threads: [thread('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))] })
    expect(f.restart.scheduled('workshop')).toBeUndefined()
    expect(f.live()).toEqual([])
  })

  it('schedules nothing for a provider that did not say, or said a reset past the horizon, and nothing with the setting off', async () => {
    const f = await fixture({ threads: [thread('workshop'), thread('docs')] })
    f.update('workshop', limitStop('workshop'))
    f.update('docs', limitStop('docs', new Date(START + LIMIT_RESTART_HORIZON_MS + 60_000).toISOString()))
    expect(f.restart.scheduled('workshop')).toEqual({ provider: 'claude', stoppedAt: expect.any(String) })
    expect(f.restart.scheduled('docs')).toEqual({ provider: 'claude', stoppedAt: expect.any(String) })
    expect(f.live()).toEqual([])
    const off = await fixture({ enabled: () => false })
    off.update('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))
    expect(off.restart.scheduled('workshop')).toBeUndefined()
  })

  it('restarts Watcher first, then the rest in the order they stopped, and tells Watcher which', async () => {
    const f = await fixture({ threads: [thread('first'), thread('second'), thread('watcher')], watcher: 'watcher' })
    const reset = new Date(START + 60 * 60_000).toISOString()
    f.update('first', limitStop('first', reset)); f.advance(1_000)
    f.update('second', limitStop('second', reset)); f.advance(1_000)
    f.update('watcher', limitStop('watcher', reset))
    await f.fire()
    expect(f.delivered.map(item => item.threadId)).toEqual(['watcher', 'first', 'second'])
    expect(f.delivered[0]!.news).toEqual({ source: 'limit-restart', provider: 'claude', since: expect.any(String), restarts: 1 })
    expect(f.told).toEqual([{ provider: 'claude', threadIds: ['watcher', 'first', 'second'] }])
    // Restarted: nothing is scheduled any more, and the record only counts the restarts.
    expect(f.restart.scheduled('first')).toBeUndefined()
    await expect.poll(f.saved).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: 'first', restarts: 1, sent: true })]))
  })

  it('counts restarts in a row, leaves a thread for the user past the most, and starts again from none after a turn of its own', async () => {
    const f = await fixture()
    let turn = 1
    for (let restart = 1; restart <= LIMIT_RESTARTS_IN_A_ROW_MAX; restart++) {
      f.update('workshop', limitStop('workshop', new Date(START + restart * 60 * 60_000).toISOString(), `workshop-${turn++}`))
      await f.fire()
      expect(f.delivered.at(-1)!.news.restarts).toBe(restart)
      // The restart note's own turn runs, and stops at the limit again.
      f.update('workshop', { status: 'running', lastTurn: { id: `workshop-${turn}`, status: 'running' } })
    }
    f.update('workshop', limitStop('workshop', new Date(START + 9 * 60 * 60_000).toISOString(), `workshop-${turn++}`))
    expect(f.restart.scheduled('workshop')).toBeUndefined()
    expect(f.live()).toEqual([])
    // A turn of its own that finishes resets the count: the next stop is a first restart again.
    f.update('workshop', { status: 'idle', lastTurn: { id: `workshop-${turn++}`, status: 'completed' } })
    f.update('workshop', limitStop('workshop', new Date(START + 10 * 60 * 60_000).toISOString(), `workshop-${turn}`))
    await f.fire()
    expect(f.delivered.at(-1)!.news.restarts).toBe(1)
  })

  it('drops a restart the thread no longer needs: it works again, it is archived, or the user says Don’t restart', async () => {
    const f = await fixture({ threads: [thread('a'), thread('b'), thread('c')] })
    const reset = new Date(START + 60 * 60_000).toISOString()
    for (const id of ['a', 'b', 'c']) f.update(id, limitStop(id, reset))
    f.update('a', { status: 'running', lastTurn: { id: 'a-2', status: 'running' } })
    f.update('b', { archivedAt: new Date(START).toISOString() })
    expect(f.restart.cancel('c')).toBe(true)
    expect(f.restart.cancel('c')).toBe(false)
    expect(['a', 'b', 'c'].map(id => f.restart.scheduled(id))).toEqual([undefined, undefined, undefined])
    expect(f.live()).toEqual([])
    await expect.poll(f.saved).toEqual([])
  })

  it('records the provider’s threads working in the background at its first stop, and only that provider’s', async () => {
    const work = [{ id: 'job', kind: 'command', status: 'running' }] as unknown as AgentThread['backgroundWork']
    const f = await fixture({ threads: [thread('workshop'), thread('waiting', { status: 'idle', lastTurn: { id: 'w', status: 'completed' }, backgroundWork: work }),
      thread('codex', { providerId: 'codex', status: 'idle', backgroundWork: work })] })
    f.update('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))
    expect(f.restart.scheduled('waiting')).toEqual(f.restart.scheduled('workshop'))
    expect(f.restart.scheduled('codex')).toBeUndefined()
  })

  it('waits for the provider to connect before it restarts, and looks again', async () => {
    const f = await fixture()
    f.update('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))
    f.host.providers = f.host.providers!.map(provider => ({ ...provider, connection: 'disconnected' }))
    await f.fire()
    expect(f.delivered).toEqual([])
    expect(f.live()).toEqual([expect.objectContaining({ delay: LIMIT_RESTART_RETRY_MS })])
    f.host.providers = f.host.providers.map(provider => ({ ...provider, connection: 'connected' }))
    await f.fire()
    expect(f.delivered.map(item => item.threadId)).toEqual(['workshop'])
  })

  it('drops a restart whose note the coordinator would not take, and sends nothing once the setting is off', async () => {
    const f = await fixture({ deliver: async () => { throw new Error('This thread is working again.') } })
    f.update('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))
    await f.fire()
    expect(f.delivered).toEqual([])
    await expect.poll(f.saved).toEqual([])
    let enabled = true
    const off = await fixture({ enabled: () => enabled })
    off.update('workshop', limitStop('workshop', new Date(START + 60_000).toISOString()))
    enabled = false
    await off.fire()
    expect(off.delivered).toEqual([])
    expect(off.restart.scheduled('workshop')).toBeUndefined()
  })

  it('keeps what was scheduled across a restart of Sotto, and a record it cannot read schedules nothing', async () => {
    const at = new Date(START + 30 * 60_000).toISOString(), stoppedAt = new Date(START - 60_000).toISOString()
    const f = await fixture({ saved: { version: 1, threads: [{ threadId: 'workshop', provider: 'claude', stoppedAt, at, restarts: 0 }] }, threads: [thread('workshop', limitStop('workshop'))] })
    expect(f.restart.scheduled('workshop')).toEqual({ provider: 'claude', stoppedAt, at: new Date(Date.parse(at) - LIMIT_RESTART_GRACE_MS).toISOString() })
    expect(f.live()).toEqual([expect.objectContaining({ delay: 30 * 60_000 })])
    const unreadable = await fixture({ saved: { version: 1, threads: [{ threadId: 'workshop', provider: 'claude', stoppedAt, at, restarts: 0, title: 'Fix the build' }] } })
    expect(unreadable.restart.scheduled('workshop')).toBeUndefined()
  })
})

/** The coordinator's side (ADR-0144): it hands each change's threads over, publishes the restart, and sends the note. */
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; for (const item of this.state.threads) item.providerId = 'claude'; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); this.emit() }
  emit() { for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if (c.type === 'send') {
      const item = this.state.threads.find(t => t.id === c.threadId)!
      item.messages.push({ id: c.messageId, commandId: c.commandId, role: 'user', text: c.text, createdAt: new Date().toISOString() })
      item.status = 'running'; item.lastTurn = { id: c.commandId, status: 'running' }; this.emit()
    }
    return { accepted: true }
  }
}
const controls: AgentControl[] = []
afterEach(async () => { for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() } })

describe('the coordinator restarting a thread a usage limit stopped', () => {
  it('publishes the scheduled restart, takes it back on Don’t restart, and sends the note as Sotto’s wake-up at the reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-limit-restart-')); roots.push(root)
    const host = new Host()
    await host.connect()
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, restartStoppedThreads: true }); controls.push(control)
    const timers: { callback: () => void; cancelled: boolean }[] = []
    let clock = Date.now()
    const restart = new LimitRestart({ directory: root, enabled: () => true, now: () => clock,
      control: { host: () => control.watcherSnapshot(), thread: id => control.liveThread(id), deliverWakeUp: (id, news, given) => control.deliverWakeUp(id, news, given) },
      schedule: callback => { const timer = { callback, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } } })
    restarts.push(restart)
    control.useLimitRestart(restart)
    await restart.start()
    await control.start(); await control.command({ type: 'connect' })
    const shown = (id: string) => control.shell().host.threads.find(item => item.id === id)?.scheduledRestart
    host.update('workshop', { status: 'running', lastTurn: { id: 'w1', status: 'running' } })
    host.update('docs', { status: 'running', lastTurn: { id: 'd1', status: 'running' } })
    const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString()
    host.update('workshop', { status: 'error', lastTurn: { id: 'w1', status: 'failed', limitStop: { resetsAt } } })
    host.update('docs', { status: 'error', lastTurn: { id: 'd1', status: 'failed', limitStop: { resetsAt } } })
    await expect.poll(() => shown('workshop')).toEqual({ provider: 'claude', stoppedAt: expect.any(String), at: expect.any(String) })
    // Don't restart: the thread waits for the user.
    expect((await control.command({ type: 'cancel-restart', threadId: 'docs' })).error).toBeNull()
    await expect.poll(() => shown('docs')).toBeUndefined()
    clock += 2 * 60 * 60_000
    timers.filter(timer => !timer.cancelled).at(-1)!.callback()
    await restart.settled()
    await expect.poll(() => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'send' }> => c.type === 'send').map(c => c.text)[0])
      .toBe(limitRestartNote('Claude Code'))
    expect(host.attempts.find(c => c.type === 'send')).toMatchObject({ threadId: 'workshop', wakeUp: true })
    expect(host.attempts.some(c => c.type === 'send' && c.threadId === 'docs')).toBe(false)
    expect(shown('workshop')).toBeUndefined()
  })

  it('answers Don’t restart plainly where the feature is off, and changes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-limit-restart-')); roots.push(root)
    const host = new Host()
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
    await control.start(); await control.command({ type: 'connect' })
    const answer = await control.command({ type: 'cancel-restart', threadId: 'workshop' })
    expect(answer.error).toBe('This host does not restart stopped threads. Nothing was changed.')
  })
})
