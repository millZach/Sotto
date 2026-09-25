// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import type { AgentCommand, AgentHostSnapshot, AgentState } from '../../../src/shared/agents'
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
/**
 * Holds every thread action open — prompts, thread settings, workspace organization and working-copy
 * work — so several can be observed in flight at once. Each held action is labelled `what:threadId`.
 */
class LaneHost extends E2EAgentHost {
  readonly started: string[] = []
  readonly openedFolders: string[] = []
  private readonly held: (() => void)[] = []
  private readonly settledThreads = new Map<string, string | null>()
  hold = false
  private async pause(label: string): Promise<void> {
    this.started.push(label)
    if (this.hold) await new Promise<void>(done => this.held.push(done))
  }
  private organized(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return { ...snapshot, threads: snapshot.threads.map(thread => this.settledThreads.has(thread.id)
      ? { ...thread, workspaceSettledAt: this.settledThreads.get(thread.id)! } : thread) }
  }
  override async snapshot(): Promise<AgentHostSnapshot> { return this.organized(await super.snapshot()) }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type === 'configure-thread' || command.type === 'send') await this.pause(`${command.type}:${command.threadId}`)
    return super.execute(command)
  }
  async setWorkspaceSettled(kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot> {
    await this.pause(`${settled ? 'settle' : 'restore'}:${id}`)
    if (kind === 'thread') this.settledThreads.set(id, settled ? new Date().toISOString() : null)
    return this.snapshot()
  }
  async updateThreadWorktree(threadId: string): Promise<AgentHostSnapshot> {
    await this.pause(`worktree:${threadId}`)
    return this.snapshot()
  }
  async threadWorkingDirectory(threadId: string): Promise<string> {
    await this.pause(`folder:${threadId}`)
    return join(tmpdir(), threadId)
  }
  release(count = this.held.length): void { for (const done of this.held.splice(0, count)) done() }
  get holding(): number { return this.held.length }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-lanes-')); roots.push(root)
  const host = new LaneHost()
  const openedFolders: string[] = []
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    openThreadFolder: async path => { openedFolders.push(path) },
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  controls.push(control)
  await control.start(); await control.command({ type: 'connect' })
  const published: AgentState[] = []
  control.subscribe(state => published.push(state))
  return { root, host, control, published, openedFolders }
}
const options = (threadId: string, runtimeMode: 'full-access' | 'auto'): AgentCommand => ({ type: 'configure-thread', threadId, runtimeMode })
const busyThreads = (state: AgentState): string[] => [...(state.busyThreadIds ?? [])].sort()
const settled = async (): Promise<void> => { await new Promise(done => { setImmediate(done) }) }

describe('thread-scoped command lanes', () => {
  it('runs thread-scoped commands on different threads at the same time and one thread’s in order', async () => {
    const f = await fixture()
    f.host.hold = true
    const docs = f.control.command(options('docs', 'full-access'))
    const workshop = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(2))
    // Neither thread waited for the other: both dispatches are open at the same moment.
    expect([...f.host.started].sort()).toEqual(['configure-thread:docs', 'configure-thread:workshop'])
    f.host.release()
    expect((await docs).error).toBeNull(); expect((await workshop).error).toBeNull()

    f.host.started.length = 0
    const first = f.control.command(options('docs', 'auto'))
    const second = f.control.command(options('docs', 'full-access'))
    await vi.waitFor(() => expect(f.host.started).toEqual(['configure-thread:docs']))
    // The second command on the same thread holds behind the first rather than joining it.
    await settled()
    expect(f.host.started).toEqual(['configure-thread:docs']); expect(f.host.holding).toBe(1)
    f.host.release(1)
    await vi.waitFor(() => expect(f.host.started).toHaveLength(2))
    f.host.release()
    expect((await first).error).toBeNull(); expect((await second).error).toBeNull()
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.runtimeMode).toBe('full-access')
  })

  it('gives workspace organization and working-copy actions the same thread lanes', async () => {
    const f = await fixture()
    f.host.hold = true
    // Settling one thread, reading another's working copy and opening a third's folder: three lanes, no waiting.
    const settle = f.control.command({ type: 'settle-thread', threadId: 'docs' })
    const worktree = f.control.command({ type: 'refresh-thread-worktree', threadId: 'workshop' })
    const folder = f.control.command({ type: 'open-thread-folder', threadId: 'workshop' })
    await vi.waitFor(() => expect(f.host.holding).toBe(2))
    expect([...f.host.started].sort()).toEqual(['settle:docs', 'worktree:workshop'])
    expect(busyThreads(f.control.get())).toEqual(['docs', 'workshop'])
    // The folder request is behind its own thread's working-copy refresh, not behind the settle.
    await settled()
    expect(f.host.started).not.toContain('folder:workshop')
    f.host.release()
    await vi.waitFor(() => expect(f.host.started).toContain('folder:workshop'))
    f.host.release()
    for (const result of await Promise.all([settle, worktree, folder])) expect(result.error).toBeNull()
    expect(f.openedFolders).toEqual([join(tmpdir(), 'workshop')])
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.workspaceSettledAt).toEqual(expect.any(String))

    f.host.started.length = 0
    f.host.hold = true
    const restore = f.control.command({ type: 'restore-thread', threadId: 'docs' })
    const again = f.control.command({ type: 'settle-thread', threadId: 'docs' })
    await vi.waitFor(() => expect(f.host.started).toEqual(['restore:docs']))
    await settled()
    // Settling a thread again waits for the restore that came before it on that same thread.
    expect(f.host.started).toEqual(['restore:docs'])
    f.host.release(1)
    await vi.waitFor(() => expect(f.host.started).toEqual(['restore:docs', 'settle:docs']))
    f.host.release()
    expect((await restore).error).toBeNull(); expect((await again).error).toBeNull()
  })

  it('does not wait on the global lane, and does not hold it up either', async () => {
    const f = await fixture()
    const connected = await f.host.snapshot()
    const discovery = deferred<AgentHostSnapshot>()
    vi.spyOn(f.host, 'snapshot').mockReturnValueOnce(discovery.promise)
    const refresh = f.control.command({ type: 'refresh' })
    await vi.waitFor(() => expect(f.control.get().globalLaneBusy).toBe(true))
    // A thread's own command finishes while the global lane is still blocked on provider discovery.
    expect((await f.control.command(options('docs', 'full-access'))).error).toBeNull()
    expect(f.control.get().globalLaneBusy).toBe(true)
    discovery.resolve(connected)
    await refresh
    expect(f.control.get().globalLaneBusy).toBe(false)

    f.host.hold = true
    const held = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(1))
    // And a global command runs while a thread lane is blocked.
    expect((await f.control.command({ type: 'configure', patch: { orbColor: 'ice' } })).configuration.orbColor).toBe('ice')
    f.host.release()
    expect((await held).error).toBeNull()
  })

  it('publishes which threads are busy, and marks the global lane for global work alone', async () => {
    const f = await fixture()
    f.host.hold = true
    const docs = f.control.command(options('docs', 'full-access'))
    const workshop = f.control.command(options('workshop', 'full-access'))
    await vi.waitFor(() => expect(f.host.holding).toBe(2))
    expect(busyThreads(f.control.get())).toEqual(['docs', 'workshop'])
    expect(busyThreads(f.published.at(-1)!)).toEqual(['docs', 'workshop'])
    // Thread work is not global work: the global lane's mark stays exactly as it was.
    expect(f.control.get().globalLaneBusy).toBe(false)
    expect(f.published.every(state => state.globalLaneBusy === false)).toBe(true)
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

describe('prompt admission beside a thread lane', () => {
  it('still sends a manual prompt during other work on its thread, and still queues one behind a prompt', async () => {
    const f = await fixture()
    f.host.hold = true
    const folder = f.control.command({ type: 'open-thread-folder', threadId: 'docs' })
    await vi.waitFor(() => expect(f.host.started).toEqual(['folder:docs']))
    // A thread action that is not a prompt never diverts a send into the follow-up queue.
    const send = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Straight through' })
    await settled()
    expect(f.control.get().followups ?? []).toEqual([])
    f.host.hold = false; f.host.release()
    expect((await folder).error).toBeNull(); expect((await send).error).toBeNull()
    expect(f.host.started).toContain('send:docs')
    expect(f.control.get().followups ?? []).toEqual([])
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.messages.at(-1))
      .toMatchObject({ role: 'user', text: 'Straight through' })

    f.host.hold = true
    f.host.started.length = 0
    f.host.event({ type: 'manual', threadId: 'docs', text: 'Agent replied', status: 'idle' })
    const first = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'First prompt' })
    await vi.waitFor(() => expect(f.host.started).toEqual(['send:docs']))
    const second = await f.control.command({ type: 'manual-send', threadId: 'docs', text: 'Second prompt' })
    // A prompt of its own is still in flight, so this one joins the follow-up queue as before.
    expect(second.followups?.map(item => item.text)).toEqual(['Second prompt'])
    expect(f.host.started).toEqual(['send:docs'])
    f.host.hold = false; f.host.release()
    expect((await first).error).toBeNull()
  })

  it('runs a send made straight after a thread’s settings behind them, in the order they arrived', async () => {
    const f = await fixture()
    f.host.hold = true
    const configure = f.control.command(options('docs', 'full-access'))
    const send = f.control.command({ type: 'manual-send', threadId: 'docs', text: 'After the settings' })
    await vi.waitFor(() => expect(f.host.started).toEqual(['configure-thread:docs']))
    await settled()
    // The send is admitted, not diverted into the queue, and waits in the lane for the settings.
    expect(f.host.started).toEqual(['configure-thread:docs'])
    expect(f.control.get().followups ?? []).toEqual([])
    f.host.hold = false; f.host.release()
    expect((await configure).error).toBeNull(); expect((await send).error).toBeNull()
    expect(f.host.started).toEqual(['configure-thread:docs', 'send:docs'])
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.runtimeMode).toBe('full-access')
  })

  it('dispatches a queued follow-up while other work on that thread is still in flight', async () => {
    const f = await fixture()
    f.host.hold = true
    const folder = f.control.command({ type: 'open-thread-folder', threadId: 'docs' })
    await vi.waitFor(() => expect(f.host.started).toEqual(['folder:docs']))
    await f.control.command({ type: 'queue-followup', threadId: 'docs', draftId: randomUUID(), text: 'Queued while busy' })
    // The queue waits on a prompt of this thread, not on the rest of its work.
    await vi.waitFor(() => expect(f.host.started).toContain('send:docs'))
    expect(f.host.holding).toBe(2)
    f.host.release()
    expect((await folder).error).toBeNull()
    await vi.waitFor(() => expect(f.control.get().followups ?? []).toEqual([]))
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.messages.at(-1))
      .toMatchObject({ role: 'user', text: 'Queued while busy' })
  })
})
