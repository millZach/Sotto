import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { desktopWindowClient, LocalHostService } from '../../src/main/agents/hostService'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import * as requestDraftOwners from '../../src/main/agents/requestDraftOwners'
import { RequestDraftService } from '../../src/main/agents/requestDrafts'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WatcherService } from '../../src/main/agents/watcher'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { routerBusyThreads } from '../../src/main/hosts/busyHost'
import { DesktopHostRouter, type DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { HostUpdates } from '../../src/main/hosts/hostUpdate'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentRequest, type AgentState, type AgentThread } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { requestDraftProvider, type RequestDraft, type RequestDraftOwner, type RequestDraftTarget } from '../../src/shared/requestDrafts'
import type { WatcherThreadTarget } from '../../src/shared/watcher'
import { FakeProviderHost } from './fakeProviderHost'
import { addWatcherHistory, ownerRequestDrafts, ownerScaleCounts, type OwnerScaleCounts } from './ownerScale'
import { syntheticModelCatalog } from './modelCatalog'
import { StreamingAdapter } from './streamingAdapter'
import { testCredentials } from './testCredentials'

/** The remote host's ID, fixed so a failure names the same host every run. */
export const REMOTE_HOST_ID = '6f1c0b52-6d4e-4b7f-9b8e-2a6a5c0e7d31'
const AT = '2026-10-20T12:00:00.000Z'
const QUESTIONS: NonNullable<AgentRequest['questions']> = [{ id: 'choice', question: 'Synthetic question', multiSelect: false, allowFreeText: true,
  options: [{ id: 'first', label: 'Synthetic first' }, { id: 'second', label: 'Synthetic second' }] }]

/** The streaming adapter, taking a send into its log as Claude's adapter records the user's message. */
class SendingAdapter extends StreamingAdapter {
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'send') return super.execute(command)
    const thread = this.state.threads.find(item => item.id === command.threadId)
    if (!thread) throw new Error('Unknown provider session')
    this.log.add(thread.id, { id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: new Date().toISOString() })
    thread.status = 'running'
    this.publish(false)
    return { accepted: true }
  }
}

function records(prefix: string, count: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({ id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`,
    sequence: position, kind: 'command', status: 'completed', title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(400, 'o') }))
}

export interface OwnerScalePipeline {
  readonly counts: OwnerScaleCounts
  readonly adapter: StreamingAdapter
  readonly control: AgentControl
  readonly router: DesktopHostRouter
  readonly requestDrafts: RequestDraftService
  readonly watcher: WatcherService
  /** Provider session IDs of the threads that stream, in order. */
  readonly streamSessions: readonly string[]
  /** The thread open in the window, as the window names it. */
  readonly openThread: string
  /** The answer draft's question, on a thread of this computer. */
  readonly question: RequestDraftTarget
  /** Updates the coordinator broadcast since the last reset. */
  broadcasts(): number
  /** The draft store's look-ups of an answer's thread since the last reset. */
  ownerLookups(): number
  resetCounts(): void
  /** The user's actions, as the window sends them to main. */
  readonly actions: {
    saveAnswerDraft(): Promise<void>
    typeInComposer(): Promise<void>
    openThread(): Promise<void>
    send(): Promise<void>
  }
  stop(): Promise<void>
}

/**
 * Main at the owner's scale, wired as `src/main/index.ts` wires it on Owl: an event-sourced adapter built like Claude's, the
 * provider switch, the workspace, the coordinator, Watcher with a full record and open on this computer, the local host
 * service, the desktop router with this computer and one connected remote host, the window's state publisher with the
 * answer-recovery pass it asks for on every publish, the answer-draft store with its retirements, the Watcher room, and
 * the host-update pill's busy check with one saved host on an older Sotto. `streams` threads are ready to stream. Every
 * payload is generated.
 */
export async function ownerScalePipeline(root: string, scale: number, streams: number): Promise<OwnerScalePipeline> {
  const counts = ownerScaleCounts(scale)
  const registry = new ThreadRegistry(root)
  await registry.load()
  const state: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), name: 'claude', version: '1', connected: true,
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, steer: true },
    projects: Array.from({ length: 12 }, (_, index) => ({ id: index === 0 ? 'project' : `project-${index}`, title: `Synthetic project ${index}`, path: join(root, `project-${index}`) })),
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true, runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }, ...syntheticModelCatalog(200)], threads: [] }
  const thread = (id: string, activities?: AgentActivity[], requests: AgentRequest[] = []): AgentThread => ({ id, projectId: `project-${state.threads.length % 12 || ''}`.replace(/-$/, '') || 'project',
    title: `Synthetic thread ${id}`, modelId: 'fake:model', status: 'idle', messages: [], requests, ...(activities ? { activities } : {}),
    usage: { latest: { input: 1200, output: 560, cached: 820 }, total: { input: 19340, output: 5250, cached: 12030 }, contextUsed: 2200, contextWindow: 200000,
      elapsedMs: 9800, estimatedUsd: 0.12, elapsedKind: 'api', rateVersions: ['synthetic'], partial: false, updatedAt: AT, contextUpdatedAt: AT, modelId: 'fake:model' } })
  const streamSessions = Array.from({ length: streams }, (_, index) => `stream-${index}`)
  for (const id of streamSessions) state.threads.push(thread(id))
  // The thread open in the window, which the user types in and sends from; Watcher neither watches it nor sent it work.
  state.threads.push(thread('open-0'))
  state.threads.push(thread('asking-0', undefined, [{ id: 'question-1', kind: 'question', text: 'Synthetic question', options: [], questions: QUESTIONS }]))
  for (let index = state.threads.length; index < counts.threads; index++) state.threads.push(thread(`idle-${index}`, index % 10 === 0 ? records(`idle-${index}`, 40) : undefined))
  for (const project of state.projects) await mkdir(project.path, { recursive: true })
  const adapter = new SendingAdapter(state)
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapter, registry), codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      muse: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)), opencode: new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) } })
  const workspace = new WorkspaceHost(native, root, () => true, undefined, true, true, true)
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner, watcherEnabled: true, museEnabled: true, streamingPublishCost: true })
  await control.start()
  await control.command({ type: 'connect' })
  const localHostId = control.hostId()!
  const idOf = (session: string): string => registry.bySession('claude', session)!.threadId
  const watcher = new WatcherService({ directory: root, control, host: workspace, historyEnabled: () => true, streamingPublishCost: true, limit: () => 4 })
  const tools = new WatcherToolServer(watcher)
  workspace.useWatcherTools(tools)
  const room = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true, watcher, send: () => true, setLimit: async () => undefined })
  const service = new LocalHostService({ control, events: workspace, watcher })
  const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()), { watcherEnabled: true, museEnabled: true, streamingPublishCost: true,
    bindRequestDraftDecision: (target, decisionId, answers) => requestDrafts.bindDecision(target, decisionId, answers) })
  watcher.useRemoteHosts(router.watcherHosts())
  router.add({ hostId: localHostId, name: 'This computer', kind: 'local', service,
    detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request), subscribeDetail: listener => control.subscribeThreadDetail(listener) })

  // The remote host, as a socket connection holds it: its last pushed state, copied whole for a `shell()` and read in place
  // for a `view()`. Its threads each held a question the user answered.
  const base = control.shell()
  const remoteThreads = Array.from({ length: counts.remoteThreads }, (_, index): AgentThread => ({ id: `remote-${index}`, hostId: REMOTE_HOST_ID,
    projectId: 'remote-project', title: `Synthetic remote thread ${index}`, modelId: 'fake:model', providerId: 'claude', status: 'idle', messages: [], requests: [] }))
  const cached: AgentState = { ...base, hostId: REMOTE_HOST_ID, activeThreadId: null, activeProjectId: null, threadDrafts: [], deliveries: [], followups: [],
    host: { ...base.host, hostId: REMOTE_HOST_ID, connected: true, projects: [{ id: 'remote-project', title: 'Synthetic remote project', path: '/srv/synthetic' }], threads: remoteThreads } }
  const remoteListeners = new Set<(state: AgentState) => void>()
  const remoteService = {
    shell: () => structuredClone(cached), view: () => ({ ...cached }),
    threadKind: (id: string) => cached.host.threads.find(item => item.id === id)?.kind,
    subscribe: (listener: (state: AgentState) => void) => { remoteListeners.add(listener); return () => remoteListeners.delete(listener) },
    command: async () => structuredClone(cached),
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }),
    supportsWatcherReads: false, supportsWatcherControl: false, supportsWatcherWorkSettled: true, supportsWatcherOutcomes: true,
  } as unknown as DesktopHostConnection['service']
  router.add({ hostId: REMOTE_HOST_ID, name: 'forge', kind: 'remote', service: remoteService, detail: () => null, preview: () => ({ ok: false }) as never })

  // The answer-draft store as main starts it, from a file holding the owner's retirements and Watcher owners.
  const localSessions = state.threads.filter(item => item.id.startsWith('idle-')).map(item => item.id)
  const localIds = localSessions.map(idOf)
  const openSession = 'open-0'
  await writeFile(join(root, 'request-drafts.json'), ownerRequestDrafts(localIds, { hostId: REMOTE_HOST_ID, threadIds: remoteThreads.map(item => item.id) }, counts), 'utf8')
  let lookups = 0
  // Main's store takes no dormant check on Owl with no held provider. Where main also names the owners a save must look up
  // again (#1230's fix), so does this; before that fix the store looked up every retirement on every save.
  const named = (requestDraftOwners as unknown as { requestDraftWatcherOwnerIds?: (local: AgentControl, dormant: () => readonly string[] | undefined, router: unknown) => string[] })
    .requestDraftWatcherOwnerIds
  const DraftStore = RequestDraftService as unknown as new (...args: unknown[]) => RequestDraftService
  const requestDrafts = new DraftStore(root, (item: RequestDraftOwner) => { lookups++; return requestDraftOwners.requestDraftOwnerState(item, control, router) }, async () => undefined,
    undefined, undefined, ...named ? [() => named(control, () => workspace.dormantThreadIds(), router)] : [])
  await requestDrafts.start()

  const broadcaster = new AgentStateBroadcaster()
  const statePublisher = coalesceAgentStatePublishes(next => {
    // Every published state asks for answer recovery, as main's does.
    router.scheduleRequestDraftReconcile(requestDrafts)
    broadcaster.send(next, () => true)
  })
  const detailPublisher = coalesceAgentThreadDetailPublishes(() => undefined, { beforeOpening: () => statePublisher.flush() })
  const offState = router.subscribe(next => statePublisher.publish(next))
  const offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
  const updates = new HostUpdates({ version: '99.0.0', releasesUrl: 'http://127.0.0.1:9/releases', probe: async () => false,
    download: async () => { throw new Error('No download in this benchmark.') }, threads: routerBusyThreads(router),
    clients: { updating: hostId => router.clientLineRunning(hostId) },
    hosts: { candidates: () => [{ id: 'saved-forge', name: 'forge', hostId: REMOTE_HOST_ID, version: '0.0.1', owned: true, installPath: '/opt/sotto', dataDirectory: '/var/sotto' }],
      run: async () => { throw new Error('No host commands in this benchmark.') }, restart: async () => { throw new Error('No restarts in this benchmark.') }, subscribe: () => () => undefined } })
  let broadcasts = 0
  const offCount = control.subscribe(() => { broadcasts++ })
  const stop = async (): Promise<void> => {
    offCount(); updates.dispose(); room?.dispose(); offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose(); watcher.close(); await tools.close()
    control.dispose(); workspace.disconnect(); await workspace.privacyChanged(); await registry.flush(); workspace.dispose()
  }

  const streamIds = streamSessions.map(idOf)
  const openThread = hostEntityKey(localHostId, idOf(openSession))
  const view = control.requestDraftView()
  const asking = view.host.threads.find(item => item.id === idOf('asking-0'))!
  const question: RequestDraftTarget = { kind: 'thread', ownerId: asking.id, providerId: requestDraftProvider(view.host, asking, view.provider), requestId: 'question-1', questions: QUESTIONS }
  try {
    // Watcher open on this computer, with the owner's record: standing watches, requests with the threads that took part,
    // and the operations Watcher sent them, every one long answered.
    const model = control.watcherSnapshot().models.find(item => item.providerId === 'claude')!
    const opened = await watcher.open({ provider: 'claude', modelId: model.id })
    if (opened.status !== 'ok') throw new Error(`Watcher did not open: ${JSON.stringify(opened)}`)
    const watched = [...streamIds, ...localIds].slice(0, counts.watches)
    for (const threadId of watched) {
      const result = await watcher.watchThread({ target: { hostId: localHostId, threadId } })
      if (result.status !== 'ok') throw new Error(`Watcher did not watch a thread: ${JSON.stringify(result)}`)
    }
    // The threads that took part: this computer's idle threads and the remote host's, never one that streams.
    const targets: WatcherThreadTarget[] = [...localIds.slice(counts.watches).map(threadId => ({ hostId: localHostId, threadId })),
      ...remoteThreads.map(item => ({ hostId: REMOTE_HOST_ID, threadId: item.id }))]
    await control.updateWatcher(record => { addWatcherHistory(record, targets, counts) })
    // The window shows one thread and watches the streams, as after the owner opened it.
    await control.command({ type: 'observe-threads', threadIds: [...streamIds, idOf(openSession)] })
  } catch (error) { await stop(); throw error }

  const client = desktopWindowClient()
  let revision = 0
  const say = (session: string, id: string, role: 'user' | 'assistant', text: string) => adapter.log.add(session, { id, role, text, createdAt: new Date().toISOString() })
  const actions = {
    // An answer being typed is saved as the window saves it: the whole form, a newer revision each time.
    saveAnswerDraft: async (): Promise<void> => {
      revision++
      const draft: RequestDraft = { target: question, revision, selections: { choice: { optionIds: [], other: true, text: `Synthetic answer ${revision}` } }, held: false }
      await requestDrafts.save(draft)
    },
    // The composer's debounced save of what is typed, the draft path main sees while the user types.
    typeInComposer: async (): Promise<void> => {
      revision++
      await router.command({ type: 'save-thread-draft', composer: 'manual', threadId: openThread, draftId: randomUUID(), text: `Synthetic draft ${revision}`, attachments: [], requestId: null }, client)
    },
    // Opening a thread from the sidebar: the selection, its detail and the window's observation of it.
    openThread: async (): Promise<void> => {
      await router.command({ type: 'select-thread', threadId: openThread }, client)
      await router.threadDetail(openThread)
      await router.command({ type: 'observe-threads', threadIds: [openThread, ...streamIds.map(id => hostEntityKey(localHostId, id))] }, client)
    },
    send: async (): Promise<void> => {
      revision++
      const result = await router.command({ type: 'send', draft: { threadId: openThread, draftId: randomUUID(), text: `Synthetic message ${revision}` } }, client)
      if (result.error) throw new Error(`The send was refused: ${result.error}`)
      // The provider takes it and finishes, as a short turn does.
      const session = adapter.state.threads.find(item => item.id === openSession)!
      say(session.id, `reply-${revision}`, 'assistant', 'Synthetic reply')
      session.status = 'idle'
      adapter.publish(false)
    },
  }
  return {
    counts, adapter, control, router, requestDrafts, watcher, streamSessions, openThread, question, actions,
    broadcasts: () => broadcasts,
    ownerLookups: () => lookups,
    resetCounts: () => { broadcasts = 0; lookups = 0 },
    stop,
  }
}
