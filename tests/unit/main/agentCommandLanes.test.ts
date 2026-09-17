// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { AgentHostSnapshot, AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []
afterEach(async () => {
  for (const control of controls.splice(0)) { control.dispose(); await control.privacyChanged() }
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-lanes-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** Holds every thread-settings dispatch open so several can be observed in flight at once. */
class LaneHost extends E2EAgentHost {
  readonly started: string[] = []
  private readonly held: (() => void)[] = []
  hold = false
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (this.hold && command.type === 'configure-thread') {
      this.started.push(command.threadId)
      await new Promise<void>(done => this.held.push(done))
    }
    return super.execute(command)
  }
  release(count = this.held.length): void { for (const done of this.held.splice(0, count)) done() }
  get holding(): number { return this.held.length }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-lanes-')); roots.push(root)
  const host = new LaneHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  const published: AgentState[] = []
  control.subscribe(state => published.push(state))
  return { root, host, control, published }
}
const options = (threadId: string, runtimeMode: 'full-access' | 'auto'): Parameters<AgentControl['command']>[0] =>
  ({ type: 'configure-thread', threadId, runtimeMode })
const busyThreads = (state: AgentState): string[] => [...(state.busyThreadIds ?? [])].sort()

describe('thread-scoped command lanes', () => {
  it('runs thread-scoped commands on different threads at the same time and one thread’s in order', async () => {
    const f = await fixture()
    f.host.hold = true
    const docs = f.control.command(options('docs', 'full-access'))
    const workshop = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(2))
    // Neither thread waited for the other: both dispatches are open at the same moment.
    expect([...f.host.started].sort()).toEqual(['docs', 'workshop'])
    f.host.release()
    expect((await docs).error).toBeNull(); expect((await workshop).error).toBeNull()

    f.host.started.length = 0
    const first = f.control.command(options('docs', 'auto'))
    const second = f.control.command(options('docs', 'full-access'))
    await vi.waitFor(() => expect(f.host.started).toEqual(['docs']))
    // The second command on the same thread holds behind the first rather than joining it.
    await new Promise(done => { setImmediate(done) })
    expect(f.host.started).toEqual(['docs']); expect(f.host.holding).toBe(1)
    f.host.release(1)
    await vi.waitFor(() => expect(f.host.started).toEqual(['docs', 'docs']))
    f.host.release()
    expect((await first).error).toBeNull(); expect((await second).error).toBeNull()
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.runtimeMode).toBe('full-access')
  })

  it('does not wait on the global lane, and does not hold it up either', async () => {
    const f = await fixture()
    const connected = await f.host.snapshot()
    const discovery = deferred<AgentHostSnapshot>()
    vi.spyOn(f.host, 'snapshot').mockReturnValueOnce(discovery.promise)
    const refresh = f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.control.get().busy).toBe(true))
    // A thread's own command finishes while the global lane is still blocked on provider discovery.
    expect((await f.control.command(options('docs', 'full-access'))).error).toBeNull()
    expect(f.control.get().busy).toBe(true)
    discovery.resolve(connected)
    await refresh
    expect(f.control.get().busy).toBe(false)

    f.host.hold = true
    const held = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(1))
    // And a global command runs while a thread lane is blocked.
    expect((await f.control.command({ type: 'configure', patch: { orbColor: 'ice' } })).configuration.orbColor).toBe('ice')
    f.host.release()
    expect((await held).error).toBeNull()
  })

  it('publishes which threads are busy while the global flag keeps meaning the global lane', async () => {
    const f = await fixture()
    f.host.hold = true
    const docs = f.control.command(options('docs', 'full-access'))
    const workshop = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(2))
    expect(busyThreads(f.control.get())).toEqual(['docs', 'workshop'])
    expect(busyThreads(f.published.at(-1)!)).toEqual(['docs', 'workshop'])
    // Thread work is not global work: the window's own busy flag stays exactly as it was.
    expect(f.control.get().busy).toBe(false)
    expect(f.published.every(state => state.busy === false)).toBe(true)
    f.host.release()
    await Promise.all([docs, workshop])
    expect(f.control.get().busyThreadIds).toBeUndefined()

    // An interrupt owns no lane at all, and still says the thread it stops is working.
    f.host.event({ type: 'manual', threadId: 'docs', text: 'Long run', status: 'running' })
    f.published.splice(0)
    await f.control.command({ type: 'interrupt', threadId: 'docs' })
    expect(f.published.map(busyThreads)).toContainEqual(['docs'])
    expect(f.control.get().busyThreadIds).toBeUndefined()
  })
})
