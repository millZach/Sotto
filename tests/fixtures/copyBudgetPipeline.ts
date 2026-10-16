import { join } from 'node:path'
import * as activitySnapshots from '../../src/main/agents/activitySnapshots'
import { ActivitySubscribers } from '../../src/main/agents/activitySnapshots'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { LocalHostService } from '../../src/main/agents/hostService'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WatcherService } from '../../src/main/agents/watcher'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { routerBusyThreads } from '../../src/main/hosts/busyHost'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { HostUpdates } from '../../src/main/hosts/hostUpdate'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from './fakeProviderHost'
import { syntheticModelCatalog } from './modelCatalog'
import { testCredentials } from './testCredentials'

/**
 * Main's update path as `src/main/index.ts` wires it, for counting what one update copies: an event-sourced adapter
 * built like Claude's, the provider switch, the workspace, the coordinator, Watcher (Owl), the local host service, the
 * desktop router, the window's state publisher and broadcaster, and the host-update pill's busy check with one saved host
 * on an older Sotto. Every payload is generated.
 */
class StreamingAdapter extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    super.emit()
    this.activityListeners.publish(historyFromEvents => this.activityView(historyFromEvents))
  }, () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  observeThreads(threadIds: readonly string[]): void { super.observeThreads(threadIds); this.log.observe([...threadIds]) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
  emit(): void { this.publish(false) }
  private activityView(historyFromEvents: boolean): AgentHostSnapshot {
    activitySnapshots.certifyActivityView(this.state, this.state.threads)
    return { ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
}

function records(prefix: string, count: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({ id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`,
    sequence: position, kind: 'command', status: 'completed', title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(400, 'o') }))
}

export interface CopyBudgetPipeline {
  readonly adapter: StreamingAdapter
  readonly control: AgentControl
  readonly streamIds: readonly string[]
  /** Updates the coordinator broadcast since the last reset. */
  broadcasts(): number
  resetCounts(): void
  stop(): Promise<void>
}

/** `threads` in all, one of them streaming; `owl` turns on Watcher, Muse and the cheaper publish windows, as an Owl build does. */
export async function copyBudgetPipeline(root: string, threads: number, owl: boolean): Promise<CopyBudgetPipeline> {
  const registry = new ThreadRegistry(root)
  await registry.load()
  const at = '2026-10-15T12:00:00.000Z'
  const state: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), name: 'claude', version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: Array.from({ length: 12 }, (_, index) => ({ id: index === 0 ? 'project' : `project-${index}`, title: `Synthetic project ${index}`, path: join(root, `project-${index}`) })),
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }, ...syntheticModelCatalog(200)], threads: [] }
  const thread = (id: string, activities?: AgentActivity[]): AgentThread => ({ id, projectId: `project-${state.threads.length % 12 || ''}`.replace(/-$/, ''),
    title: `Synthetic thread ${id}`, modelId: 'fake:model', status: 'idle', messages: [], requests: [], ...(activities ? { activities } : {}),
    usage: { latest: { input: 1200, output: 560, cached: 820 }, total: { input: 19340, output: 5250, cached: 12030 }, contextUsed: 2200, contextWindow: 200000,
      elapsedMs: 9800, estimatedUsd: 0.12, elapsedKind: 'api', rateVersions: ['synthetic'], partial: false, updatedAt: at, contextUpdatedAt: at, modelId: 'fake:model' } })
  state.threads.push(thread('stream-0'))
  for (let index = 1; index < threads; index++) state.threads.push(thread(`idle-${index}`, index % 10 === 0 ? records(`idle-${index}`, 40) : undefined))
  for (const item of state.threads) item.projectId = item.projectId || 'project'
  const adapter = new StreamingAdapter(state)
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  const workspace = new WorkspaceHost(native, root, () => true, undefined, owl, owl, owl)
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner, watcherEnabled: owl, museEnabled: owl, streamingPublishCost: owl })
  await control.start()
  await control.command({ type: 'connect' })
  const watcher = owl ? new WatcherService({ directory: root, control, host: workspace, historyEnabled: () => true, streamingPublishCost: true, limit: () => 4 }) : undefined
  const service = new LocalHostService({ control, events: workspace, ...(watcher ? { watcher } : {}) })
  const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()), { watcherEnabled: owl, museEnabled: owl, streamingPublishCost: owl })
  router.add({ hostId: control.hostId()!, name: 'This computer', kind: 'local', service,
    detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request), subscribeDetail: listener => control.subscribeThreadDetail(listener) })
  const broadcaster = new AgentStateBroadcaster()
  const statePublisher = coalesceAgentStatePublishes(next => { broadcaster.send(next, () => true) })
  const detailPublisher = coalesceAgentThreadDetailPublishes(() => undefined, { beforeOpening: () => statePublisher.flush() })
  const offState = router.subscribe(next => statePublisher.publish(next))
  const offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
  // One saved host on an older Sotto, as after every new Owl build until it is updated: the pill asks which threads keep it busy.
  const updates = new HostUpdates({ version: '99.0.0', releasesUrl: 'http://127.0.0.1:9/releases', probe: async () => false,
    download: async () => { throw new Error('No download in this benchmark.') }, threads: routerBusyThreads(router),
    hosts: { candidates: () => [{ id: 'saved-forge', name: 'forge', hostId: 'remote-forge', version: '0.0.1', owned: true, installPath: '/opt/sotto', dataDirectory: '/var/sotto' }],
      run: async () => { throw new Error('No host commands in this benchmark.') }, restart: async () => { throw new Error('No restarts in this benchmark.') }, subscribe: () => () => undefined } })
  let broadcasts = 0
  const offCount = control.subscribe(() => { broadcasts++ })
  const streamIds = [registry.bySession('claude', 'stream-0')!.threadId]
  await control.command({ type: 'observe-threads', threadIds: [...streamIds] })
  control.threadDetail(streamIds[0]!)
  return {
    adapter, control, streamIds,
    broadcasts: () => broadcasts,
    resetCounts: () => { broadcasts = 0 },
    stop: async () => {
      offCount(); updates.dispose(); offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose(); watcher?.close()
      control.dispose(); workspace.disconnect(); await workspace.privacyChanged(); await registry.flush(); workspace.dispose()
    },
  }
}
