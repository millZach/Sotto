// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import type { AgentHostCommand, AgentHostResult } from '../../../src/main/agents/host'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

/**
 * The coordinator's light path for thread settings (#318): no read before the change, the adapter's own snapshot
 * in place of a read after it, and one coordinator write where the outbox entry came and went inside its dispatch.
 */
const roots: string[] = []
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-settings-path-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** A provider whose reads, watches and commands are recorded in the order they happen. */
class SettingsHost extends E2EAgentHost {
  timeline: string[] = []
  /** Hand back the snapshot a confirmed settings change produced, as Codex, Grok and Devin do. */
  handsBackSnapshot = true
  /** Answer with an unknown result without applying the change, carrying a snapshot that claims it anyway. */
  unknown = false
  /** What the adapter says was lost with an unknown result, when it knows. */
  lost: string | undefined
  private held: AgentHostCommand | undefined
  /** Acknowledge without applying, so the snapshot handed back does not show the change. */
  cosmetic = false
  async refreshThread(threadId: string): Promise<AgentHostSnapshot> { this.timeline.push(`read:${threadId}`); return this.snapshot() }
  observeThreads(threadIds: readonly string[]): void { this.timeline.push(`watch:${threadIds.join(',')}`) }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.timeline.push(`execute:${command.type}`)
    if (command.type !== 'configure-thread') return super.execute(command)
    if (this.cosmetic) return { accepted: true, ...(this.handsBackSnapshot ? { snapshot: await this.snapshot() } : {}) }
    if (this.unknown) {
      this.held = command
      const claimed = await this.snapshot()
      for (const item of claimed.threads) if (item.id === command.threadId && command.runtimeMode) item.runtimeMode = command.runtimeMode
      return { accepted: false, uncertain: true, snapshot: claimed, ...(this.lost ? { error: this.lost } : {}) }
    }
    const result = await super.execute(command)
    return this.handsBackSnapshot ? { ...result, snapshot: await this.snapshot() } : result
  }
  /** The provider had taken the held change after all. */
  async applyHeld(): Promise<void> { await super.execute(this.held!) }
  reads(threadId = 'workshop'): number { return this.timeline.filter(entry => entry === `read:${threadId}`).length }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-settings-path-')); roots.push(root)
  const host = new SettingsHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const create = () => new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  let control = create(); disposers.push(async () => { control.dispose(); await control.privacyChanged() })
  await control.start(); await control.command({ type: 'connect' })
  // Coordinator writes, counted by file name alone.
  let writes = 0
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (basename((this as unknown as { filePath: string }).filePath) === 'agents.json') writes += 1
    return write.call(this, value)
  })
  const saved = async () => JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')) as { outbox: { type: string; options?: Record<string, unknown> }[] }
  return { root, host, saved, get control() { return control }, get writes() { return writes },
    async restart() { control.dispose(); control = create(); await control.start(); await control.command({ type: 'connect' }) } }
}
const thread = (state: { host: AgentHostSnapshot }) => state.host.threads.find(item => item.id === 'workshop')

describe('thread settings light path', () => {
  it('reads the thread zero times when the adapter hands back its snapshot, and exactly once when it does not', async () => {
    const f = await fixture()
    f.host.timeline = []
    const light = await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })
    expect(light.error).toBeNull()
    expect(thread(light)).toMatchObject({ runtimeMode: 'full-access' })
    expect(f.host.reads()).toBe(0)

    f.host.handsBackSnapshot = false; f.host.timeline = []
    const read = await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'auto-accept-edits' })
    expect(read.error).toBeNull()
    expect(thread(read)).toMatchObject({ runtimeMode: 'auto-accept-edits' })
    expect(f.host.reads()).toBe(1)
    // The one read is the reconciliation after the change, never a read before it.
    expect(f.host.timeline.indexOf('read:workshop')).toBeGreaterThan(f.host.timeline.indexOf('execute:configure-thread'))
  })

  it('neither reads nor watches the thread before its settings change reaches the adapter', async () => {
    const f = await fixture()
    f.host.handsBackSnapshot = false; f.host.timeline = []
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high', runtimeMode: 'full-access' })).error).toBeNull()
    // A reaped Claude thread starts its CLI when it is read or watched; before the change reaches the adapter it is neither.
    const before = f.host.timeline.slice(0, f.host.timeline.indexOf('execute:configure-thread'))
    expect(before.filter(entry => entry === 'read:workshop' || (entry.startsWith('watch:') && entry.split(/[:,]/u).includes('workshop')))).toEqual([])
    // Model and effort, then the permission mode: two dispatches, each reconciled by one read after it.
    expect(f.host.timeline.filter(entry => entry === 'execute:configure-thread')).toHaveLength(2)
    expect(f.host.reads()).toBe(2)
  })

  it('still refuses a change the thread is not ready for, from the thread Sotto holds', async () => {
    const f = await fixture()
    f.host.event({ type: 'permission', threadId: 'workshop', text: 'Publish?', status: 'idle' })
    f.host.timeline = []
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toMatch(/pending requests/u)
    expect(f.host.timeline.filter(entry => entry.startsWith('execute:') || entry.startsWith('read:'))).toEqual([])
  })

  it('keeps the outbox entry and says the provider did not confirm when the result is uncertain, whatever it carries', async () => {
    const f = await fixture()
    f.host.unknown = true
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toMatch(/did not confirm/u)
    expect((await f.saved()).outbox).toEqual([expect.objectContaining({ type: 'configure-thread', options: { runtimeMode: 'full-access' } })])
    expect(f.host.reads()).toBe(0)
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toMatch(/unknown result/u)
  })

  it('shows what the adapter says was lost with an uncertain result in place of its own error, and keeps the entry', async () => {
    const f = await fixture()
    f.host.unknown = true
    f.host.lost = 'Claude Code did not confirm the settings change, so Sotto stopped this thread\'s session, and "Review the diff" stopped with it.'
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toBe(f.host.lost)
    expect((await f.saved()).outbox).toEqual([expect.objectContaining({ type: 'configure-thread', options: { runtimeMode: 'full-access' } })])
  })

  it('keeps the outbox entry and the not confirmed error when the snapshot handed back does not show the change', async () => {
    const f = await fixture()
    f.host.cosmetic = true
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toMatch(/has not confirmed these thread settings/u)
    expect((await f.saved()).outbox).toHaveLength(1)
    expect(f.host.reads()).toBe(0)
  })

  it('writes its own state once per confirmed change, and a restart reconciles the entry that write left', async () => {
    const f = await fixture()
    const before = f.writes
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toBeNull()
    await vi.waitFor(() => expect(f.control.get().busyThreadIds ?? []).toEqual([]))
    expect(f.writes - before).toBe(1)
    // The write that mattered holds the intent; dropping it after the provider confirmed waits for the next write.
    expect((await f.saved()).outbox).toEqual([expect.objectContaining({ type: 'configure-thread', options: { runtimeMode: 'full-access' } })])

    // Model and permission are two dispatches: the second's intent carries the first's removal, so two writes, not four.
    const pair = f.writes
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' })).error).toBeNull()
    expect(f.writes - pair).toBe(2)
    expect((await f.saved()).outbox).toEqual([expect.objectContaining({ options: { runtimeMode: 'auto-accept-edits' } })])

    // A crash here leaves a confirmed entry on disk. The restart finds the thread already has those settings,
    // retires it, writes that down, and the thread takes its next change as if nothing had happened.
    await f.restart()
    await vi.waitFor(async () => expect((await f.saved()).outbox).toEqual([]))
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toBeNull()
  })

  it('leaves no confirmed entry on disk when Sotto closes', async () => {
    const f = await fixture()
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toBeNull()
    expect((await f.saved()).outbox).toHaveLength(1)
    await f.control.closed()
    expect((await f.saved()).outbox).toEqual([])
  })

  it('writes the removal at once when the entry was not added in the dispatch that confirmed it', async () => {
    const f = await fixture()
    f.host.unknown = true
    expect((await f.control.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })).error).toMatch(/did not confirm/u)
    f.host.unknown = false
    // The provider had taken it after all. A later refresh confirms it outside that dispatch, and that is written.
    await f.host.applyHeld()
    await f.control.command({ type: 'refresh' })
    await vi.waitFor(async () => expect((await f.saved()).outbox).toEqual([]))
  })
})
