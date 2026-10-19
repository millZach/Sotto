// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isImmutableActivities } from '../../../src/main/agents/activitySnapshots'
import { AgentControl } from '../../../src/main/agents/control'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import { CertifyingProviderHost } from '../../fixtures/certifyingProviderHost'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { testCredentials } from '../../fixtures/testCredentials'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const record = (id: string): AgentActivity => ({ id, turnId: 'turn', sequence: Number(id.at(-1)), kind: 'command', status: 'completed', title: 'Build', output: 'Done' })

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-shared-snapshots-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function coordinator(provider: FakeProviderHost) {
  const root = await folder()
  const workspace = new WorkspaceHost(provider, root)
  const control = new AgentControl({ directory: root, host: workspace, credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: e2eAgentReasoner })
  cleanup.push(async () => { control.dispose(); workspace.dispose() })
  await control.start()
  await control.command({ type: 'connect' })
  return { workspace, control }
}

// Codex publishes a thread it has not opened this run with no activity. The workspace's list is then the whole list:
// rebuilt on every accept, it was copied whole into every publish and compared record by record on every save.
it('keeps activity its provider has not read this run certified and shared, publish after publish (#917)', async () => {
  const provider = new CertifyingProviderHost()
  const thread = provider.state.threads[0]!
  thread.activities = [record('a1'), record('a2')]
  const workspace = new WorkspaceHost(provider, await folder())
  cleanup.push(async () => { workspace.dispose() })
  await workspace.initialize()
  const published: AgentHostSnapshot[] = []
  const off = workspace.subscribeActivitySnapshots(snapshot => published.push(snapshot))
  cleanup.push(async () => { off() })
  await workspace.connect()
  provider.emit()
  await expect.poll(() => published.at(-1)?.threads.find(item => item.id === thread.id)?.activities?.length).toBe(2)
  delete thread.activities
  const held: (readonly AgentActivity[] | undefined)[] = []
  for (const title of ['Unread', 'Still unread']) {
    thread.title = title
    provider.emit()
    await expect.poll(() => published.at(-1)?.threads.find(item => item.id === thread.id)?.title).toBe(title)
    held.push(published.at(-1)!.threads.find(item => item.id === thread.id)!.activities)
  }
  expect(held[0]?.map(item => item.id)).toEqual(['a1', 'a2'])
  expect(isImmutableActivities(held[0])).toBe(true)
  expect(held[1]).toBe(held[0])
})

it('shares one certified catalog through the workspace and the shell, and marks it not ready on disconnect without editing it (#917)', async () => {
  const provider = new CertifyingProviderHost()
  const { workspace, control } = await coordinator(provider)
  // A connect's own reply is a copy; the adapter's first publication brings the certified catalog.
  provider.emit()
  await expect.poll(() => Object.isFrozen(control.shell().host.models)).toBe(true)
  expect(control.shell().host.models.find(model => model.id === 'fake:model')?.ready).toBe(true)
  const published = control.shell().host.models
  expect(control.shell().host.models).toBe(published)
  expect(Object.isFrozen(published)).toBe(true)
  workspace.disconnect()
  await expect.poll(() => control.shell().host.models.find(model => model.id === 'fake:model')?.ready).toBe(false)
  expect(published.find(model => model.id === 'fake:model')?.ready).toBe(true)
})

it('copies a catalog no adapter certified into each shell, as before (#917)', async () => {
  const { control } = await coordinator(new FakeProviderHost())
  await expect.poll(() => control.shell().host.models.length).toBeGreaterThan(0)
  const first = control.shell().host.models
  expect(control.shell().host.models).not.toBe(first)
  expect(Object.isFrozen(first)).toBe(false)
})

/** A legacy publisher hands over its own state, and may edit it after. */
class EditingProvider extends FakeProviderHost {
  private readonly rawListeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  override subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.rawListeners.add(listener); return () => this.rawListeners.delete(listener)
  }
  override emit(): void { for (const listener of this.rawListeners) listener(this.state) }
}

// Reusing a catalog by its identity is right only for a certified one: an uncertified array may have been edited in place.
it('merges a catalog a legacy host edited in place afresh each time (#917)', async () => {
  const provider = new EditingProvider()
  const { control } = await coordinator(provider)
  provider.emit()
  await expect.poll(() => control.shell().host.models.find(model => model.id === 'fake:model')?.ready).toBe(true)
  provider.state.models.push({ id: 'fake:second', provider: 'Fake', name: 'Second model', ready: true })
  provider.emit()
  await expect.poll(() => control.shell().host.models.map(model => model.id)).toContain('fake:second')
  provider.state.models.splice(0, 1)
  provider.emit()
  await expect.poll(() => control.shell().host.models.find(model => model.id === 'fake:model')?.ready).toBe(false)
})

// The shell a broadcast carries shares the coordinator's thread data rather than copying it (ADR-0016, October 19).
// Its content is the shell's: only where the data lives differs.
it('broadcasts a shell equal to a copied one, whose thread data is the host snapshot itself', async () => {
  const provider = new CertifyingProviderHost()
  provider.state.threads[0]!.requests = [{ id: 'request', kind: 'permission', text: 'Allow?', options: [] }]
  const { control } = await coordinator(provider)
  provider.emit()
  await expect.poll(() => control.shell().host.threads[0]?.requests.length).toBe(1)
  const copied = control.shell(), broadcast = control.broadcastShell()
  expect(broadcast).toEqual(copied)
  const host = control.watcherSnapshot().threads.find(thread => thread.id === broadcast.host.threads[0]!.id)!
  expect(broadcast.host.threads[0]!.requests).toBe(host.requests)
  expect(copied.host.threads[0]!.requests).not.toBe(host.requests)
  expect(broadcast.host.threads[0]).not.toBe(host)
})
