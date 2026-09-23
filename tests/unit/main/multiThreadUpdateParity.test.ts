// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { cloneActivitySnapshot, immutableActivities, isImmutableActivities } from '../../../src/main/agents/activitySnapshots'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentHostSnapshot, AgentMessage, AgentThread, ProviderId } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const at = (second: number) => `2026-09-23T00:00:${String(second).padStart(2, '0')}.000Z`
const message = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at(1) })
const activity = (id: string, output: string, status: AgentActivity['status'] = 'running'): AgentActivity => ({
  id, turnId: 'turn-1', sequence: 0, kind: 'tool', status, title: 'Build', output,
  afterMessageId: 'opening', changes: [{ path: 'src/app.ts', kind: 'modify', diff: output }],
})
const close: Array<() => Promise<void>> = []
/** Mirrors an adapter's owned activity publication while keeping its public snapshots writable. */
class ActivityProviderHost extends FakeProviderHost {
  private readonly activityListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  activitySubscriptions = 0

  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.activitySubscriptions += 1
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  override emit(): void {
    for (const thread of this.state.threads) if (thread.activities) thread.activities = immutableActivities(thread.activities)
    super.emit()
    for (const listener of this.activityListeners) listener(cloneActivitySnapshot(this.state))
  }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of close.splice(0).reverse()) await cleanup()
})

async function fixture(optimized = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-multi-thread-replay-'))
  const makeAdapter = () => optimized ? new ActivityProviderHost() : new FakeProviderHost()
  const adapters = { codex: makeAdapter(), claude: makeAdapter(), grok: makeAdapter(), devin: makeAdapter() }
  const registry = new ThreadRegistry(directory)
  const providers = new ConfiguredProviderHost({
    directory, provider: () => 'codex', enabledProviders: () => ['codex', 'claude', 'grok'],
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: {
      codex: new SottoThreadHost('codex', adapters.codex, registry),
      claude: new SottoThreadHost('claude', adapters.claude, registry),
      grok: new SottoThreadHost('grok', adapters.grok, registry),
      devin: new SottoThreadHost('devin', adapters.devin, registry),
    },
  })
  const workspace = new WorkspaceHost(providers, directory)
  close.push(async () => { workspace.disconnect(); workspace.dispose(); await registry.flush(); await rm(directory, { recursive: true, force: true }) })
  await workspace.initialize()
  const initial = await workspace.connect()
  const id = (provider: ProviderId, title = 'Workshop') => {
    const thread = initial.threads.find(item => item.providerId === provider && item.title === title)
    if (!thread) throw new Error(`Missing ${provider} ${title} thread`)
    return thread.id
  }
  const thread = (snapshot: AgentHostSnapshot, threadId: string): AgentThread => {
    const found = snapshot.threads.find(item => item.id === threadId)
    if (!found) throw new Error(`Missing thread ${threadId}`)
    return found
  }
  return { adapters, providers, workspace, initial, id, thread }
}

describe('multi-provider workspace update replay', () => {
  it.each([{ mode: 'legacy', optimized: false }, { mode: 'owned activity', optimized: true }])('keeps peer histories and pending requests through $mode subscription checkpoints', async ({ optimized }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture(optimized)
    await vi.advanceTimersByTimeAsync(100)
    const published: AgentHostSnapshot[] = []
    const ownedPublished: AgentHostSnapshot[] = []
    f.workspace.subscribe(snapshot => { published.push(snapshot) })
    f.workspace.subscribeActivitySnapshots(snapshot => { ownedPublished.push(snapshot) })
    const codex = f.id('codex')
    const claude = f.id('claude')
    const grok = f.id('grok')
    expect(new Set([codex, claude, grok]).size).toBe(3)

    const claudeNative = f.adapters.claude.state.threads[0]!
    const grokNative = f.adapters.grok.state.threads[0]!
    claudeNative.messages = [message('claude-opening', 'Claude history')]
    claudeNative.activities = [activity('claude-tool', 'Claude output', 'completed')]
    grokNative.messages = [message('grok-opening', 'Grok history')]
    grokNative.activities = [activity('grok-tool', 'Grok output', 'completed')]
    f.adapters.claude.emit(); f.adapters.grok.emit()
    await vi.advanceTimersByTimeAsync(100)
    const seeded = published.at(-1)!
    const ownedSeeded = ownedPublished.at(-1)!
    const peerHistory = [claude, grok].map(id => ({ messages: f.workspace.threadMessages(id), activities: f.thread(seeded, id).activities }))

    const changing = f.adapters.codex.state.threads[0]!
    changing.historyEpoch = 'first'
    changing.messages = [message('opening', 'Starting')]
    changing.activities = [activity('build', 'Step one')]
    changing.status = 'running'
    f.adapters.codex.emit()
    const started = published.at(-1)!
    const ownedStarted = ownedPublished.at(-1)!
    expect(f.thread(started, codex)).toMatchObject({ status: 'running', historyEpoch: 'first', activities: [{ id: 'build', output: 'Step one' }] })
    expect(f.workspace.threadMessages(codex)).toEqual(changing.messages)

    changing.messages = [...changing.messages, message('progress', 'Continuing')]
    changing.activities = [activity('build', 'Step two')]
    changing.requests = [{ id: 'allow-build', kind: 'permission', text: 'Run build?', options: [] }]
    claudeNative.requests = [{ id: 'choose-path', kind: 'question', text: 'Which path?', options: [{ id: 'a', label: 'Path A' }] }]
    claudeNative.activities = [activity('claude-tool', 'Claude output updated', 'completed')]
    f.adapters.codex.emit()
    f.adapters.claude.emit() // Both providers change in the same display window.
    expect(published.at(-1)).toBe(started)
    await vi.advanceTimersByTimeAsync(16)
    const awaiting = published.at(-1)!
    const ownedAwaiting = ownedPublished.at(-1)!
    expect(f.thread(awaiting, codex).requests).toEqual(changing.requests)
    expect(f.thread(awaiting, codex).activities?.[0]).toMatchObject({ output: 'Step two', afterMessageId: 'opening', sequence: 0 })
    expect(f.thread(awaiting, claude).requests).toEqual(claudeNative.requests)
    expect(f.thread(awaiting, claude).activities?.[0]?.output).toBe('Claude output updated')
    expect(f.workspace.threadMessages(codex).map(item => item.id)).toEqual(['opening', 'progress'])

    changing.usage = { latest: { input: 24, output: 8 }, total: { input: 24, output: 8 }, rateVersions: [], partial: false, updatedAt: at(3), modelId: 'fake:model' }
    changing.status = 'idle'
    f.adapters.codex.emit()
    await vi.advanceTimersByTimeAsync(16)
    const usageOnly = published.at(-1)!
    const ownedUsageOnly = ownedPublished.at(-1)!
    expect(f.thread(usageOnly, codex).usage).toMatchObject({ latest: { input: 24, output: 8 }, total: { input: 24, output: 8 } })
    expect(f.thread(usageOnly, codex).status).toBe('idle')
    expect(f.thread(usageOnly, codex).requests).toEqual(changing.requests)
    expect(f.workspace.threadMessages(codex).map(item => item.id)).toEqual(['opening', 'progress'])

    for (const snapshot of [started, awaiting, usageOnly]) {
      expect(f.thread(snapshot, grok).messages).toEqual(peerHistory[1]!.messages)
      expect(f.thread(snapshot, grok).activities).toEqual(peerHistory[1]!.activities)
      expect(f.thread(snapshot, claude).messages).toEqual(peerHistory[0]!.messages)
    }
    expect(f.thread(started, claude).activities).toEqual(peerHistory[0]!.activities)
    expect(f.workspace.threadMessages(claude)).toEqual(peerHistory[0]!.messages)
    expect(f.workspace.threadMessages(grok)).toEqual(peerHistory[1]!.messages)
    expect(f.thread(awaiting, codex).usage).toBeUndefined()
    expect(f.thread(started, codex).requests).toEqual([])
    expect(f.thread(started, codex).activities?.[0]?.output).toBe('Step one')
    expect(f.thread(ownedStarted, codex).activities?.[0]?.output).toBe('Step one')
    expect(f.thread(ownedStarted, codex).requests).toEqual([])
    expect(f.thread(ownedAwaiting, codex).activities?.[0]?.output).toBe('Step two')
    expect(f.thread(ownedAwaiting, codex).usage).toBeUndefined()
    expect(f.thread(awaiting, codex).requests).toEqual(changing.requests)
    if (optimized) {
      expect((f.adapters.codex as ActivityProviderHost).activitySubscriptions).toBeGreaterThan(0)
      expect(isImmutableActivities(f.thread(ownedSeeded, grok).activities)).toBe(true)
      expect(f.thread(ownedUsageOnly, grok).activities).toBe(f.thread(ownedSeeded, grok).activities)
      expect(f.thread(seeded, grok).activities).not.toBe(f.thread(ownedSeeded, grok).activities)
    }
  })

  it.each([{ mode: 'legacy', optimized: false }, { mode: 'owned activity', optimized: true }])('coalesces $mode provider bursts while retaining each final state and the first immediate frame', async ({ optimized }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture(optimized)
    await vi.advanceTimersByTimeAsync(100) // Drain connection publishes before observing the replay.
    const ids = { codex: f.id('codex'), claude: f.id('claude'), grok: f.id('grok') }
    const published: AgentHostSnapshot[] = []
    f.workspace.subscribe(snapshot => { published.push(snapshot) })
    try {
      f.adapters.codex.state.threads[0]!.messages = [message('codex-first', 'First frame')]
      f.adapters.codex.emit()
      expect(published).toHaveLength(1)
      expect(f.thread(published[0]!, ids.codex).messages.map(item => item.text)).toEqual(['First frame'])

      for (const [provider, text] of [['claude', 'Claude burst'], ['grok', 'Grok burst'], ['codex', 'Codex final']] as const) {
        f.adapters[provider].state.threads[0]!.messages = [message(`${provider}-last`, text)]
        f.adapters[provider].state.threads[0]!.activities = [activity(`${provider}-tool`, text, 'completed')]
        f.adapters[provider].emit()
      }
      expect(published).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(16)
      expect(published).toHaveLength(2)
      const final = published[1]!
      for (const [provider, text] of [['codex', 'Codex final'], ['claude', 'Claude burst'], ['grok', 'Grok burst']] as const) {
        expect(f.thread(final, ids[provider]).messages.at(-1)?.text).toBe(text)
        expect(f.thread(final, ids[provider]).activities?.[0]?.output).toBe(text)
      }
      expect(f.thread(published[0]!, ids.codex).messages.map(item => item.text)).toEqual(['First frame'])
    } finally { vi.useRealTimers() }
  })

  it.each([{ mode: 'legacy', optimized: false }, { mode: 'owned activity', optimized: true }])('retains a $mode provider request and peer history through disconnect, reconnect and reset', async ({ optimized }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture(optimized)
    await vi.advanceTimersByTimeAsync(100)
    const published: AgentHostSnapshot[] = []
    f.workspace.subscribe(snapshot => { published.push(snapshot) })
    const codex = f.id('codex')
    const claude = f.id('claude')
    const codexNative = f.adapters.codex.state.threads[0]!
    const claudeNative = f.adapters.claude.state.threads[0]!
    codexNative.historyEpoch = 'before'
    codexNative.messages = [message('old', 'Old response'), message('removed', 'Removed response')]
    codexNative.activities = [activity('old-tool', 'Old output', 'completed')]
    claudeNative.messages = [message('claude-stays', 'Other history')]
    claudeNative.requests = [{ id: 'claude-question', kind: 'question', text: 'Choose a path', options: [{ id: 'a', label: 'Path A' }] }]
    f.adapters.codex.emit(); f.adapters.claude.emit()
    await vi.advanceTimersByTimeAsync(100)
    const before = published.at(-1)!
    expect(f.thread(before, claude).requests).toEqual(claudeNative.requests)

    f.workspace.disconnect('claude')
    const disconnected = published.at(-1)!
    expect(disconnected.providers?.find(provider => provider.id === 'claude')?.connection).toBe('disconnected')
    expect(f.thread(disconnected, claude).requests).toEqual(claudeNative.requests)
    expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-stays'])

    codexNative.historyEpoch = 'after'
    codexNative.messages = [message('replayed', 'New response')]
    codexNative.activities = [activity('new-tool', 'New output', 'completed')]
    f.adapters.codex.emit()
    await vi.advanceTimersByTimeAsync(100)
    const replayed = published.at(-1)!
    expect(f.thread(replayed, codex).messages.map(item => item.id)).toEqual(['replayed'])
    expect(f.thread(replayed, codex).activities?.map(item => item.id)).toEqual(['new-tool'])
    expect(f.workspace.threadMessages(codex).map(item => item.id)).toEqual(['replayed'])
    expect(f.thread(replayed, claude).requests).toEqual(claudeNative.requests)
    expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-stays'])

    await f.workspace.connect('claude')
    await vi.advanceTimersByTimeAsync(100)
    const reconnected = published.at(-1)!
    expect(reconnected.providers?.find(provider => provider.id === 'claude')?.connection).toBe('connected')
    expect(f.thread(reconnected, claude).requests).toEqual(claudeNative.requests)
    expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-stays'])
    expect(f.thread(before, codex).messages.map(item => item.id)).toEqual(['old', 'removed'])
  })

  it('reconciles a legacy provider that mutates the same activity record in place', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(100)
    const published: AgentHostSnapshot[] = []
    const firstInternal: AgentHostSnapshot[] = []
    const secondInternal: AgentHostSnapshot[] = []
    f.workspace.subscribe(snapshot => { published.push(snapshot) })
    f.workspace.subscribeActivitySnapshots(snapshot => { firstInternal.push(snapshot) })
    f.workspace.subscribeActivitySnapshots(snapshot => { secondInternal.push(snapshot) })
    const codex = f.id('codex')
    const native = f.adapters.codex.state.threads[0]!
    native.activities = [activity('mutable', 'Before')]
    f.adapters.codex.emit()
    const before = published.at(-1)!
    const firstBefore = firstInternal.at(-1)!
    const secondBefore = secondInternal.at(-1)!
    expect(isImmutableActivities(f.thread(firstBefore, codex).activities)).toBe(false)
    expect(f.thread(firstBefore, codex).activities).not.toBe(f.thread(secondBefore, codex).activities)
    f.thread(firstBefore, codex).activities![0]!.changes![0]!.diff = 'Local change'
    expect(f.thread(secondBefore, codex).activities![0]!.changes![0]!.diff).toBe('Before')
    expect(f.thread(f.workspace.workspaceSnapshot(), codex).activities![0]!.changes![0]!.diff).toBe('Before')
    native.activities[0]!.output = 'After'
    native.activities[0]!.changes![0]!.diff = 'After'
    f.adapters.codex.emit()
    await vi.advanceTimersByTimeAsync(16)
    const after = published.at(-1)!
    expect(f.thread(after, codex).activities?.[0]).toMatchObject({ output: 'After', changes: [{ diff: 'After' }] })
    expect(f.thread(before, codex).activities?.[0]).toMatchObject({ output: 'Before', changes: [{ diff: 'Before' }] })
    expect(f.thread(firstBefore, codex).activities![0]!.changes![0]!.diff).toBe('Local change')
    expect(f.thread(secondBefore, codex).activities![0]!.changes![0]!.diff).toBe('Before')
    expect(f.thread(firstInternal.at(-1)!, codex).activities![0]!.changes![0]!.diff).toBe('After')
    expect(f.thread(secondInternal.at(-1)!, codex).activities![0]!.changes![0]!.diff).toBe('After')
  })

  it('releases owned activity inputs across archive and connection cycles while retaining history', async () => {
    const f = await fixture(true)
    const codex = f.id('codex')
    const claude = f.id('claude')
    // Cache size is an internal work-count contract, so the test inspects it without adding a public API.
    const inputs = (f.workspace as unknown as { activityInputs: Map<string, unknown> }).activityInputs
    const codexNative = f.adapters.codex.state.threads[0]!
    const claudeNative = f.adapters.claude.state.threads[0]!
    codexNative.messages = [message('codex-retained', 'Codex history')]
    codexNative.activities = [activity('codex-tool', 'Codex output', 'completed')]
    claudeNative.messages = [message('claude-retained', 'Claude history')]
    claudeNative.activities = [activity('claude-tool', 'Claude output 0', 'completed')]
    f.adapters.codex.emit(); f.adapters.claude.emit()
    expect([...inputs.keys()].sort()).toEqual([codex, claude].sort())

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      claudeNative.archivedAt = at(cycle)
      f.adapters.claude.emit()
      expect([...inputs.keys()]).toEqual([codex])
      expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-retained'])
      expect(f.thread(f.workspace.workspaceSnapshot(), claude).activities?.[0]?.output).toBe(`Claude output ${cycle - 1}`)

      delete claudeNative.archivedAt
      claudeNative.activities = [activity('claude-tool', `Claude output ${cycle}`, 'completed')]
      f.adapters.claude.emit()
      expect([...inputs.keys()].sort()).toEqual([codex, claude].sort())
      expect(f.thread(f.workspace.workspaceSnapshot(), claude).activities?.[0]?.output).toBe(`Claude output ${cycle}`)

      f.workspace.disconnect('claude')
      expect([...inputs.keys()]).toEqual([codex])
      expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-retained'])
      await f.workspace.connect('claude')
      f.adapters.claude.emit()
      expect([...inputs.keys()].sort()).toEqual([codex, claude].sort())
      expect(f.thread(f.workspace.workspaceSnapshot(), claude).activities?.[0]?.output).toBe(`Claude output ${cycle}`)
    }

    f.workspace.disconnect()
    expect(inputs.size).toBe(0)
    expect(f.workspace.threadMessages(codex).map(item => item.id)).toEqual(['codex-retained'])
    expect(f.workspace.threadMessages(claude).map(item => item.id)).toEqual(['claude-retained'])
    f.workspace.dispose()
    expect(inputs.size).toBe(0)
  })
})
