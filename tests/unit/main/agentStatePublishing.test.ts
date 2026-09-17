// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATE_BROADCAST_INTERVAL_MS, AGENT_STATE_PUBLISH_INTERVAL_MS, AgentControl, coalesceAgentStatePublishes, type PublishScheduler } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentState } from '../../../src/shared/agents'

/** A streamed frame only changes the notice here; identity is all these tests compare. */
const state = (notice: string): AgentState => ({
  configuration: defaultAgentConfiguration(), connection: 'connected', host: structuredClone(EMPTY_AGENT_HOST),
  assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
  draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
  busy: false, notice, error: null, speech: { id: 0, text: '' },
  voice: { status: 'off', error: null, action: 'none', revision: 0 },
  credentials: { reasoning: false, grokSpeech: false, secure: false },
  reasoningAccounts: [],
  membership: { status: 'active', label: 'Sotto', expiresAt: null },
})
class TestClock {
  private armed: { run: () => void } | null = null
  cancels = 0
  intervals: number[] = []
  readonly schedule: PublishScheduler = (run, ms) => {
    this.intervals.push(ms)
    const entry = { run }
    this.armed = entry
    return () => { this.cancels += 1; if (this.armed === entry) this.armed = null }
  }
  get pending(): boolean { return this.armed !== null }
  tick(): void {
    const entry = this.armed
    this.armed = null
    entry?.run()
  }
}
afterEach(() => { vi.useRealTimers() })

describe('coalesced agent state publishing', () => {
  it('sends the first state at once and collapses the rest of a burst into one trailing send', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentStatePublishes(item => sent.push(item.notice), { schedule: clock.schedule })
    for (let frame = 0; frame < 40; frame += 1) publisher.publish(state(`frame-${frame}`))
    expect(sent).toEqual(['frame-0'])
    clock.tick()
    expect(sent).toEqual(['frame-0', 'frame-39'])
    // A quiet window closes without inventing a send, and the newest state is never repeated.
    clock.tick()
    expect(sent).toEqual(['frame-0', 'frame-39'])
    expect(clock.intervals.every(ms => ms === AGENT_STATE_PUBLISH_INTERVAL_MS)).toBe(true)
  })
  it('delivers the last state of every burst in order, never a stale one after a newer one', () => {
    const sent: number[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentStatePublishes(item => sent.push(Number(item.notice)), { schedule: clock.schedule })
    let revision = 0
    for (let burst = 0; burst < 5; burst += 1) {
      for (let frame = 0; frame < 10; frame += 1) publisher.publish(state(String(revision += 1)))
      clock.tick()
      expect(sent.at(-1)).toBe(revision)
    }
    expect(sent).toEqual([...sent].sort((a, b) => a - b))
    expect(sent.length).toBeLessThan(revision / 4)
  })
  it('flushes a held state synchronously for a caller that cannot wait out the interval', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentStatePublishes(item => sent.push(item.notice), { schedule: clock.schedule })
    publisher.publish(state('sent'))
    publisher.publish(state('feedback'))
    expect(sent).toEqual(['sent'])
    publisher.flush()
    expect(sent).toEqual(['sent', 'feedback'])
    // The flushed state is not delivered a second time when the window closes.
    clock.tick()
    expect(sent).toEqual(['sent', 'feedback'])
  })
  it('clears its timer on dispose and publishes nothing afterwards', () => {
    const sent: string[] = []
    const clock = new TestClock()
    const publisher = coalesceAgentStatePublishes(item => sent.push(item.notice), { schedule: clock.schedule })
    publisher.publish(state('first'))
    publisher.publish(state('held'))
    publisher.dispose()
    expect(clock.cancels).toBe(1)
    expect(clock.pending).toBe(false)
    publisher.publish(state('after-dispose'))
    publisher.flush()
    clock.tick()
    expect(sent).toEqual(['first'])
  })
  it('uses the real timer by default and leaves no timer armed after dispose', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const publisher = coalesceAgentStatePublishes(item => sent.push(item.notice))
    publisher.publish(state('first'))
    publisher.publish(state('last'))
    vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS - 1)
    expect(sent).toEqual(['first'])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual(['first', 'last'])
    publisher.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('coalesced coordinator broadcasts', () => {
  const roots: string[] = []
  const controls: AgentControl[] = []
  afterEach(async () => {
    for (const control of controls.splice(0)) control.dispose()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })
  async function control(clock: TestClock): Promise<AgentControl> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-broadcast-'))
    roots.push(root)
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: value => value.toString() })
    await credentials.load()
    const created = new AgentControl({ schedule: clock.schedule, directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    controls.push(created)
    await created.start()
    // Settle whatever start published so the burst under test owns a fresh window.
    while (clock.pending) clock.tick()
    return created
  }
  it('broadcasts the first state of a burst at once and collapses the rest onto one trailing run', async () => {
    const clock = new TestClock()
    const coordinator = await control(clock)
    const broadcasts: string[] = []
    coordinator.subscribe(state => broadcasts.push(state.configuration.orbColor))
    for (const orbColor of ['teal', 'ice', 'amber', 'violet'] as const) {
      // Every command response is the state its own command produced, coalescing or not.
      const response = await coordinator.command({ type: 'configure', patch: { orbColor } })
      expect(response.configuration.orbColor).toBe(orbColor)
    }
    expect(broadcasts).toEqual(['teal'])
    clock.tick()
    expect(broadcasts).toEqual(['teal', 'violet'])
    expect(clock.intervals.every(ms => ms === AGENT_STATE_BROADCAST_INTERVAL_MS)).toBe(true)
    // A quiet window closes without inventing a broadcast.
    clock.tick()
    expect(broadcasts).toEqual(['teal', 'violet'])
  })
  it('drops a held broadcast on dispose', async () => {
    const clock = new TestClock()
    const coordinator = await control(clock)
    const broadcasts: string[] = []
    coordinator.subscribe(state => broadcasts.push(state.configuration.orbColor))
    await coordinator.command({ type: 'configure', patch: { orbColor: 'teal' } })
    await coordinator.command({ type: 'configure', patch: { orbColor: 'ice' } })
    expect(broadcasts).toEqual(['teal'])
    coordinator.dispose()
    expect(clock.pending).toBe(false)
    clock.tick()
    expect(broadcasts).toEqual(['teal'])
  })
})
