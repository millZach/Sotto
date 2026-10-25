// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { IDLE_COMPACTION_AFTER_MS, IdleCompaction } from '../../../src/main/agents/idleCompaction'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'

/** Idle compaction's command through the coordinator (ADR-0127): Sotto's own, guarded to the provider write, and quiet. */
const roots: string[] = []; const controls: AgentControl[] = []
afterEach(async () => {
  for (const c of controls.splice(0)) { c.dispose(); await c.privacyChanged() }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-idle-compaction-')) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
class Host implements AgentHost {
  state!: AgentHostSnapshot
  listeners = new Set<(s: AgentHostSnapshot) => void>()
  attempts: AgentHostCommand[] = []
  /** The guard each command reached the provider with, as the Claude adapter asks it once its CLI is up. */
  guards = new Map<AgentHostCommand, () => void>()
  async connect() { this.state ??= await new E2EAgentHost().connect(); this.state.connected = true; this.state.capabilities.compact = true; return this.snapshot() }
  async snapshot() { return structuredClone(this.state) }
  subscribe(fn: (s: AgentHostSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  disconnect() { this.state.connected = false }
  update(id: string, patch: Partial<AgentThread>) { Object.assign(this.state.threads.find(t => t.id === id)!, patch); for (const fn of this.listeners) fn(structuredClone(this.state)) }
  async execute(c: AgentHostCommand): Promise<AgentHostResult> {
    this.attempts.push(c)
    if (c.type === 'compact-thread') this.update(c.threadId, { compaction: { commandId: c.commandId, status: 'completed' } })
    return { accepted: true }
  }
  async executeFromWatcher(c: AgentHostCommand, guard: () => void): Promise<AgentHostResult> {
    this.guards.set(c, guard)
    return this.execute(c)
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-idle-compaction-')); roots.push(root)
  const host = new Host()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner }); controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  host.update('workshop', { status: 'idle', requests: [] })
  return { host, control }
}
const compactions = (host: Host) => host.attempts.filter((c): c is Extract<AgentHostCommand, { type: 'compact-thread' }> => c.type === 'compact-thread')

describe('idle compaction through the coordinator', () => {
  it('dispatches native compaction marked as idle, leaving the window’s error as it was', async () => {
    const f = await fixture()
    await f.control.command({ type: 'compact-thread', threadId: 'no-such-thread' })
    const error = f.control.shell().error
    expect(error).toBeTruthy()
    await f.control.compactIdleThread('workshop', () => {})
    expect(compactions(f.host)).toEqual([expect.objectContaining({ threadId: 'workshop', idle: true })])
    expect(f.control.shell().error).toBe(error)
  })

  it('marks the user’s own compaction as theirs, not idle', async () => {
    const f = await fixture()
    await f.control.command({ type: 'compact-thread', threadId: 'workshop' })
    expect(compactions(f.host)).toHaveLength(1)
    expect(compactions(f.host)[0]).not.toHaveProperty('idle')
  })

  it('writes nothing when its guard refuses, and rejects without raising an error', async () => {
    const f = await fixture()
    let calls = 0
    // The first ask, at admission, passes; the thread then moves on before the lane reaches the provider.
    await expect(f.control.compactIdleThread('workshop', () => { if (++calls > 1) throw new Error('This thread is no longer idle.') })).rejects.toThrow('no longer idle')
    expect(compactions(f.host)).toEqual([])
    expect(f.control.shell().error).toBeNull()
  })

  it('hands its guard to the provider, which asks it again once its CLI is up, and the user’s own compaction none', async () => {
    const f = await fixture()
    let moved = false
    await f.control.compactIdleThread('workshop', () => { if (moved) throw new Error('This thread is no longer idle.') })
    const idle = compactions(f.host)[0]!
    expect(f.host.guards.get(idle)).toBeTypeOf('function')
    moved = true
    expect(() => f.host.guards.get(idle)!()).toThrow('no longer idle')
    await f.control.command({ type: 'compact-thread', threadId: 'workshop' })
    expect(f.host.guards.has(compactions(f.host)[1]!)).toBe(false)
  })

  it('reads the host without copying it', async () => {
    const f = await fixture()
    expect(f.control.hostView()).toBe(f.control.hostView())
    expect(f.control.hostView().threads.some(thread => thread.id === 'workshop')).toBe(true)
  })

  it('compacts a quiet Claude thread from the sweep, all the way to the provider, and only once', async () => {
    const f = await fixture()
    const now = Date.now()
    f.host.update('workshop', { providerId: 'claude', manualCompactionSupported: true, nativeSessionStarted: true,
      usage: { contextUsed: 250_000, contextUpdatedAt: new Date(now - IDLE_COMPACTION_AFTER_MS - 30_000).toISOString(), rateVersions: [], partial: false, updatedAt: new Date(now).toISOString() } })
    await expect.poll(() => f.control.hostView().threads.find(thread => thread.id === 'workshop')?.usage?.contextUsed).toBe(250_000)
    const sweeper = new IdleCompaction({ control: f.control, enabled: () => true, now: () => now })
    expect(sweeper.sweep()).toEqual(['workshop'])
    await expect.poll(() => compactions(f.host)).toEqual([expect.objectContaining({ threadId: 'workshop', idle: true })])
    expect(sweeper.sweep()).toEqual([])
    sweeper.stop()
  })
})
