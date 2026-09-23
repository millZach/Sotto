// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cloneActivitySnapshot, immutableActivities, isImmutableActivities } from '../../../src/main/agents/activitySnapshots'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

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
