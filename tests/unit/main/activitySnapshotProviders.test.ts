// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cloneActivitySnapshot, immutableActivities, isImmutableActivities } from '../../../src/main/agents/activitySnapshots'
import type { ActivitySubscriptionOptions, ThreadHostEvent, ThreadReadPurpose } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { deferred } from '../../fixtures/deferred'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const activity = (output: string): AgentActivity => ({
  id: 'work', turnId: 'turn', sequence: 0, kind: 'command', status: 'completed', title: 'Build', output,
  changes: [{ path: 'file.txt', kind: 'modify', diff: 'Before' }],
})

class SharedProvider extends FakeProviderHost {
  private readonly activityListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.activityListeners.add(listener); return () => this.activityListeners.delete(listener)
  }
  emitActivity(): void {
    for (const thread of this.state.threads) if (thread.activities && !isImmutableActivities(thread.activities)) {
      thread.activities = immutableActivities(thread.activities)
    }
    for (const listener of this.activityListeners) listener(cloneActivitySnapshot(this.state))
  }
}

/** A legacy publisher is allowed to keep and mutate the object it delivered. */
class MutableLegacyProvider extends FakeProviderHost {
  private readonly rawListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  override subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.rawListeners.add(listener); return () => this.rawListeners.delete(listener)
  }
  override emit(): void { for (const listener of this.rawListeners) listener(this.state) }
}

it('keeps certified activity identity through Sotto IDs and provider aggregation while isolating metadata and public snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-activity-provider-'))
  const registry = new ThreadRegistry(root)
  const codex = new SharedProvider()
  codex.state.threads[0]!.activities = [activity('First')]
  const host = new ConfiguredProviderHost({
    hosts: { codex: new SottoThreadHost('codex', codex, registry), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() },
    provider: () => 'codex', enabledProviders: () => ['codex'], threadProvider: id => registry.byThread(id)?.provider,
  })
  cleanup.push(async () => { host.disconnect(); await registry.flush(); await rm(root, { recursive: true, force: true }) })
  await host.connect()
  const shared: AgentHostSnapshot[] = []
  const publicSnapshots: AgentHostSnapshot[] = []
  const offShared = host.subscribeActivitySnapshots(snapshot => shared.push(snapshot))
  const offPublic = host.subscribe(snapshot => publicSnapshots.push(snapshot))
  cleanup.push(async () => { offShared(); offPublic() })

  codex.emitActivity()
  const first = shared.at(-1)!.threads.find(thread => thread.providerId === 'codex')!
  const firstActivities = first.activities!
  expect(first.id).not.toBe('session-workshop')
  expect(Object.isFrozen(firstActivities[0]!.changes![0])).toBe(true)
  first.title = 'Subscriber edit'
  publicSnapshots.at(-1)!.threads.find(thread => thread.providerId === 'codex')!.activities![0]!.output = 'Public edit'

  codex.emitActivity()
  const second = shared.at(-1)!.threads.find(thread => thread.providerId === 'codex')!
  expect(second.activities).toBe(firstActivities)
  expect(second.title).toBe('Workshop')
  expect(second.activities![0]!.output).toBe('First')

  codex.state.threads[0]!.activities = [{ ...codex.state.threads[0]!.activities![0]!, output: 'Second' }]
  codex.emitActivity()
  expect(shared.at(-1)!.threads.find(thread => thread.providerId === 'codex')!.activities).not.toBe(firstActivities)
  expect(firstActivities[0]!.output).toBe('First')
  expect((await host.snapshot()).threads.find(thread => thread.providerId === 'codex')!.activities![0]!.output).toBe('Second')
})

it('copies mutable legacy activity on each arrival, including edits within one array', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-activity-legacy-'))
  const legacy = new MutableLegacyProvider()
  legacy.state.threads[0]!.activities = [activity('First')]
  const host = new ConfiguredProviderHost({
    hosts: { codex: legacy, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() },
    provider: () => 'codex', enabledProviders: () => ['codex'],
  })
  cleanup.push(async () => { host.disconnect(); await rm(root, { recursive: true, force: true }) })
  await host.connect()
  const snapshots: AgentHostSnapshot[] = []
  const off = host.subscribeActivitySnapshots(snapshot => snapshots.push(snapshot))
  cleanup.push(async () => { off() })
  legacy.emit()
  const first = snapshots.at(-1)!.threads[0]!.activities!
  const firstStatus = snapshots.at(-1)!.providers!.find(provider => provider.id === 'codex')!
  expect(firstStatus.capabilities.submit).toBe(true)
  legacy.state.capabilities.submit = false
  const held = await host.snapshot('claude')
  expect(held.providers!.find(provider => provider.id === 'codex')!.capabilities.submit).toBe(true)
  expect(snapshots.at(-1)!.providers!.find(provider => provider.id === 'codex')!.capabilities.submit).toBe(true)
  expect(firstStatus.capabilities.submit).toBe(true)
  legacy.state.threads[0]!.activities![0]!.output = 'Second'
  legacy.emit()
  expect(snapshots.at(-1)!.threads[0]!.activities![0]!.output).toBe('Second')
  expect(first[0]!.output).toBe('First')
  expect(snapshots.at(-1)!.threads[0]!.activities).not.toBe(first)
})

/** Publishes events, and records what each activity subscription asked of it through the Sotto identity wrapper. */
class AskedProvider extends FakeProviderHost {
  readonly asked: Array<ActivitySubscriptionOptions | undefined> = []
  private readonly activityListeners = new Map<(snapshot: AgentHostSnapshot) => void, boolean>()
  readonly subscribeEvents?: (listener: (event: ThreadHostEvent) => void) => () => void
  constructor(events = true) { super(); if (events) this.subscribeEvents = () => () => undefined }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    this.asked.push(options); this.activityListeners.set(listener, options?.historyFromEvents === true)
    return () => this.activityListeners.delete(listener)
  }
  /** Hands each subscriber what it asked for: no messages to one that keeps history from events. */
  emitActivity(): void {
    for (const [listener, historyFromEvents] of this.activityListeners) listener(cloneActivitySnapshot({ ...this.state,
      threads: this.state.threads.map(thread => historyFromEvents ? { ...thread, messages: [] } : thread) }))
  }
}
/** Answers a thread read only once `gate` settles, leaving the messages out when asked to. */
class GatedProvider extends AskedProvider {
  gate: Promise<void> = Promise.resolve()
  async refreshThread(_threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    await this.gate
    return structuredClone({ ...this.state, threads: this.state.threads.map(thread => purpose?.historyFromEvents ? { ...thread, messages: [] } : thread) })
  }
}
async function askedSwitch(claude: AskedProvider) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-activity-asked-'))
  const registry = new ThreadRegistry(root)
  const host = new ConfiguredProviderHost({
    hosts: { codex: new FakeProviderHost(), claude: new SottoThreadHost('claude', claude, registry), grok: new FakeProviderHost(), devin: new FakeProviderHost() },
    provider: () => 'claude', enabledProviders: () => ['claude'],
  })
  cleanup.push(async () => { host.disconnect(); await registry.flush(); await rm(root, { recursive: true, force: true }) })
  return host
}

it.each([
  ['every subscriber keeps history from events', [true, true], false, true, true],
  ['one subscriber reads messages from its snapshots', [true, false], false, true, false],
  ['an ordinary subscriber reads whole snapshots', [true], true, true, false],
  ['nothing has subscribed yet', [], false, true, false],
  ['the provider publishes no events', [true], false, false, false],
] as const)('asks a provider to leave messages out only when %s (#322)', async (_case, subscribers, ordinary, events, expected) => {
  const claude = new AskedProvider(events)
  const host = await askedSwitch(claude)
  for (const historyFromEvents of subscribers) host.subscribeActivitySnapshots(() => undefined, historyFromEvents ? { historyFromEvents } : undefined)
  if (ordinary) host.subscribe(() => undefined)
  await host.connect()
  expect(claude.asked).toEqual([{ historyFromEvents: expected }])
})

it('asks again when a subscriber that reads messages arrives after connect, and hands it the messages (#322)', async () => {
  const claude = new AskedProvider()
  claude.state.threads[0]!.messages = [{ id: 'ask', role: 'user', text: 'Ask', createdAt: '2026-09-26T10:00:00Z' }]
  const host = await askedSwitch(claude)
  const activity: AgentHostSnapshot[] = []
  host.subscribeActivitySnapshots(snapshot => activity.push(snapshot), { historyFromEvents: true })
  await host.connect()
  expect(claude.asked).toEqual([{ historyFromEvents: true }])
  claude.emitActivity()
  expect(activity.at(-1)!.threads.find(thread => thread.title === 'Workshop')!.messages).toEqual([])

  const plain: AgentHostSnapshot[] = []
  const off = host.subscribe(snapshot => plain.push(snapshot))
  expect(claude.asked).toEqual([{ historyFromEvents: true }, { historyFromEvents: false }])
  // What the provider last published carried no messages, so the switch reads it afresh for the newcomer.
  await expect.poll(() => plain.at(-1)?.threads.find(thread => thread.title === 'Workshop')?.messages.map(message => message.id)).toEqual(['ask'])
  claude.emitActivity()
  expect(plain.at(-1)!.threads.find(thread => thread.title === 'Workshop')!.messages.map(message => message.id)).toEqual(['ask'])

  off()
  expect(claude.asked.at(-1)).toEqual({ historyFromEvents: true })
})
it('reads a provider whole when a subscriber that reads messages arrives while a read without them is on the way (#368)', async () => {
  const claude = new GatedProvider()
  claude.state.threads[0]!.messages = [{ id: 'ask', role: 'user', text: 'Ask', createdAt: '2026-09-27T10:00:00Z' }]
  const host = await askedSwitch(claude)
  host.subscribeActivitySnapshots(() => undefined, { historyFromEvents: true })
  await host.connect()
  const threadId = (await host.snapshot()).threads.find(thread => thread.title === 'Workshop')!.id
  const { promise: heldRelease, resolve: release } = deferred<void>()
  claude.gate = heldRelease
  const reading = host.refreshThread(threadId, { historyFromEvents: true })
  const plain: AgentHostSnapshot[] = []
  host.subscribe(snapshot => plain.push(snapshot))
  // The newcomer is handed the messages at once, since the switch reads the provider afresh for it.
  await expect.poll(() => plain.at(-1)?.threads.find(thread => thread.title === 'Workshop')?.messages.map(message => message.id)).toEqual(['ask'])
  release()
  await reading
  // The read that went out without messages does not take them away from it.
  expect(plain.at(-1)!.threads.find(thread => thread.title === 'Workshop')!.messages.map(message => message.id)).toEqual(['ask'])
})
