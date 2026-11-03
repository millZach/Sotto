// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

// After the update that began saving Codex rollout positions, the first run catches up only the threads the user has not
// settled; a settled one waits until it is opened (#992, Zach's call on October 30). The adapter learns which those are
// from the workspace, through the provider switch and the identity wrapper, before it connects.

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A provider that keeps what it is told of settled threads, and whether it had connected by then. */
class TellingProvider extends FakeProviderHost {
  readonly told: { settled: string[]; connected: boolean }[] = []
  private connected = false
  useSettledThreads(ids: readonly string[]): void { this.told.push({ settled: [...ids], connected: this.connected }) }
  override async connect(): Promise<AgentHostSnapshot> { const snapshot = await super.connect(); this.connected = true; return snapshot }
}

async function run(root: string, registry: ThreadRegistry): Promise<{ adapter: TellingProvider; workspace: WorkspaceHost }> {
  const adapter = new TellingProvider()
  const empty = (): FakeProviderHost => new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST))
  const native = new ConfiguredProviderHost({ directory: join(root, 'switch'), provider: () => 'codex', enabledProviders: () => ['codex'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { codex: new SottoThreadHost('codex', adapter, registry), claude: empty(), grok: empty(), devin: empty(), muse: empty(), opencode: empty(), cursor: empty(), deepseek: empty() } })
  const workspace = new WorkspaceHost(native, join(root, 'workspace'), () => true, 600_000)
  cleanup.push(async () => { workspace.disconnect(); await workspace.privacyChanged().catch(() => undefined); workspace.dispose() })
  await workspace.connect()
  return { adapter, workspace }
}

it('names the threads the user settled to each adapter by its own IDs, before the adapter connects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-settled-hand-off-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  await mkdir(join(root, 'workspace'), { recursive: true })
  const registry = new ThreadRegistry(join(root, 'registry'))
  await registry.load()
  const first = await run(root, registry)
  const settled = registry.bySession('codex', 'session-workshop')!.threadId
  await first.workspace.setWorkspaceSettled('thread', settled, true)
  await registry.flush()
  first.workspace.disconnect(); await first.workspace.privacyChanged(); first.workspace.dispose()
  cleanup.pop()

  const second = await run(root, registry)
  expect(second.adapter.told[0]).toEqual({ settled: ['session-workshop'], connected: false })
})
