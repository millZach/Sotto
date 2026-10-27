import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asActivityPublication } from '../../src/main/agents/activitySnapshots'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { NextPrompts } from '../../src/main/agents/nextPrompts'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { HeldProviderHost } from '../../src/main/agents/heldProviderGate'
import { desktopWindowClient, LocalHostService } from '../../src/main/agents/hostService'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { requestDraftOwnerState, requestDraftWatcherOwnerIds } from '../../src/main/agents/requestDraftOwners'
import { RequestDraftService } from '../../src/main/agents/requestDrafts'
import { ThreadChangesPublisher, ThreadMap, verifyingThreadChanges, type ActivityChangesListener, type ActivityChangesSubscription, type AgentHostChanges } from '../../src/main/agents/threadChanges'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { UsageService } from '../../src/main/agents/usageService'
import { WatcherService } from '../../src/main/agents/watcher'
import { CheckQueue } from '../../src/main/agents/checkQueue'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { ThreadStore } from '../../src/main/agents/threadStore'
import type { ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { ActivitySubscriptionOptions, AgentHostCommand, AgentHostResult } from '../../src/main/agents/host'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { routerBusyThreads } from '../../src/main/hosts/busyHost'
import { DesktopHostRouter, type DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { HostUpdates } from '../../src/main/hosts/hostUpdate'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, publicProviderEntityId, type AgentHostSnapshot, type AgentModel, type AgentRequest, type AgentState, type AgentThread } from '../../src/shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../src/shared/clientIdentity'
import type { HeldProviders } from '../../src/shared/heldProviders'
import { requestDraftProvider, type RequestDraft, type RequestDraftOwner, type RequestDraftTarget } from '../../src/shared/requestDrafts'
import type { WatcherThreadTarget } from '../../src/shared/watcher'
import type { WatcherRoomListChange, WatcherRoomState, WatcherRoomUpdate } from '../../src/shared/watcherRoom'
import { FakeProviderHost } from './fakeProviderHost'
import { addWatcherHistory, ownerRequestDrafts, ownerScaleCounts, type OwnerScale, type OwnerScaleCounts } from './ownerScale'
import { syntheticModelCatalog } from './modelCatalog'
import { StreamingAdapter } from './streamingAdapter'
import { testCredentials } from './testCredentials'
import { countedThreads, uncounted } from './threadVisits'

/** The remote host's ID, fixed so a failure names the same host every run. */
export const REMOTE_HOST_ID = '6f1c0b52-6d4e-4b7f-9b8e-2a6a5c0e7d31'
const AT = '2026-10-20T12:00:00.000Z'
const QUESTIONS: NonNullable<AgentRequest['questions']> = [{ id: 'choice', question: 'Synthetic question', multiSelect: false, allowFreeText: true,
  options: [{ id: 'first', label: 'Synthetic first' }, { id: 'second', label: 'Synthetic second' }] }]

/**
 * The streaming adapter, taking a send into its log as Claude's adapter records the user's message. Every thread list it
 * publishes is counted (`threadVisits.ts`). A publication of its activity subscription stays one, so the provider switch
 * keeps it without a copy, as it keeps the real adapter's; the counted snapshot is marked from the one it wraps.
 */
class SendingAdapter extends StreamingAdapter {
  override subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    return super.subscribe(snapshot => listener({ ...snapshot, threads: countedThreads(snapshot.threads) }))
  }
  override subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return super.subscribeActivitySnapshots(snapshot => listener(asActivityPublication({ ...snapshot, threads: countedThreads(snapshot.threads) }, snapshot)), options)
  }
  override async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'send') return super.execute(command)
    const thread = this.state.threads.find(item => item.id === command.threadId)
    if (!thread) throw new Error('Unknown provider session')
    this.log.add(thread.id, { id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: new Date().toISOString() })
    thread.status = 'running'
    this.mark(thread.id)
    this.publish(false)
    return { accepted: true }
  }
}

function records(prefix: string, count: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({ id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`,
    sequence: position, kind: 'command', status: 'completed', title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(400, 'o') }))
}

/**
 * Which build main runs as. Owl turns on every Owl feature, Watcher and the cheaper publish windows among them, and holds
 * no provider. Stable turns them off and holds Muse and OpenCode (ADR-0072): their adapters are stand-ins, and every
 * publish filters their models, projects and threads out of what the window is given (#1068).
 */
export type OwnerScaleTrack = 'owl' | 'stable'

export interface OwnerScalePipeline {
  readonly track: OwnerScaleTrack
  readonly counts: OwnerScaleCounts
  readonly adapter: StreamingAdapter
  readonly control: AgentControl
  readonly router: DesktopHostRouter
  readonly requestDrafts: RequestDraftService
  /** Watcher, open with the owner's record, on Owl. Stable starts none and keeps the record whole. */
  readonly watcher: WatcherService | undefined
  /** Provider session IDs of the threads that stream, in order. */
  readonly streamSessions: readonly string[]
  /** The thread open in the window, as the window names it. */
  readonly openThread: string
  /** The workspace, for a case that reads a thread's history from it. */
  readonly workspace: WorkspaceHost
  /** The answer draft's question, on a thread of this computer. */
  readonly question: RequestDraftTarget
  /** Updates the coordinator broadcast since the last reset. */
  broadcasts(): number
  /** The thread records and removals the adapter's thread changes carried since the last reset (#925). */
  adapterChangeRecords(): number
  /** The thread records and removals the identity wrapper's thread changes carried since the last reset (#925). */
  wrapperChangeRecords(): number
  /** The thread records and removals the provider switch's thread changes carried since the last reset (#925). */
  switchChangeRecords(): number
  /** The thread records and removals the workspace's thread changes carried since the last reset (#925). */
  workspaceChangeRecords(): number
  /** The draft store's look-ups of an answer's thread since the last reset. */
  ownerLookups(): number
  /** The records of Watcher's history (requests, receipts and earlier Watchers) the window's room was sent since the last reset. */
  watcherRoomRecords(): number
  resetCounts(): void
  /**
   * With thread changes verified: for each layer, how many of its publications the shadow map applied and checked, and
   * every way a map came to differ from that layer's whole snapshot. Empty when not verified.
   */
  threadChanges(): ThreadChangesReport
  /** The user's actions, as the window sends them to main. */
  readonly actions: {
    saveAnswerDraft(): Promise<void>
    typeInComposer(): Promise<void>
    openThread(): Promise<void>
    send(): Promise<void>
  }
  stop(): Promise<void>
}

export interface OwnerScalePipelineOptions {
  /**
   * Shadow every layer between the adapter and the coordinator with a thread map fed its thread changes, checked against
   * the layer's whole snapshot after every change (#925). Defaults to `SOTTO_VERIFY_THREAD_CHANGES=1`.
   */
  verifyThreadChanges?: boolean
  /** Runs the shadows' work, so a test that counts main's work can leave it out. */
  uncounted?: <T>(work: () => T) => T
  /**
   * Told the records each publication of a layer's thread changes that main consumes carried (the adapter's, the identity
   * wrapper's and the provider switch's), the thread records that layer built for an update in place of a whole snapshot
   * (#925).
   */
  touched?: (layer: string, records: number) => void
  /**
   * Told each read of a creation's thread ID. Every thread on this computer was made in Sotto, so each has a started
   * creation the workspace keeps for as long as the thread, newest last, as the owner's do (#925 review).
   */
  creationRead?: () => void
  /** The thread-store writer the workspace runs over; absent, the one it makes itself (#1457). */
  storeWriter?: (store: ThreadStore) => ThreadStoreWriter
}

export interface ThreadChangesReport {
  /** Publications each layer's shadow map applied and checked. */
  readonly checked: Readonly<Record<string, number>>
  /** Every difference found, named by layer. */
  readonly drift: readonly string[]
}

type ActivityPublisher = { subscribeActivitySnapshots?(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void }
type ChangesPublisher = { subscribeActivityChanges?(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription }

/** The layers whose thread changes main consumes, and the workspace's, which nothing in main consumes until #925's step 5. */
type ChangesLayer = 'adapter' | 'identity wrapper' | 'provider switch' | 'workspace'

/**
 * The verifying mode at the owner's scale (#925). Each layer that passes on thread changes is shadowed by a thread map fed
 * the same publications, which, verifying, rebuilds itself from a whole snapshot of that layer after every change and
 * compares: the adapter's whole activity view, the identity wrapper's `mapSnapshot` of it (the snapshot path the wrapper's
 * changes replace), the provider switch's activity snapshot built at the same publish, and the workspace's activity
 * publication from the same publish. While the switch takes in one of the wrapper's publications, its Claude threads are
 * also checked against the wrapper's whole snapshot named the way the switch named every thread before it kept a thread
 * map (`provider switch slot`). The workspace's accepted state and its activity publication are also shadowed by the
 * shim's changes worked out from them. Nothing main runs changes: a shadow only reads what a layer published, its work is
 * left out of every count, and a drift is kept for the test rather than thrown into main's path.
 */
class ShadowThreadMaps {
  private readonly checked: Record<string, number> = {}
  private readonly drift: string[] = []
  /** What each layer's thread changes carried since the last reset: records upserted and threads removed. */
  readonly carried: Record<ChangesLayer, number> = { adapter: 0, 'identity wrapper': 0, 'provider switch': 0, workspace: 0 }
  /** Set while the switch takes in a publication of the wrapper's, to the form it was published in. */
  private fromWrapper: boolean | undefined
  /** The wrapper's whole snapshot of a form, its `mapSnapshot` of the adapter's whole view, once the wrapper is tapped. */
  private claudeWhole: ((form: boolean) => AgentHostSnapshot) | undefined
  constructor(private readonly on: boolean, private readonly uncounted: <T>(work: () => T) => T,
    private readonly touched: ((layer: string, records: number) => void) | undefined) {}

  /**
   * Every subscription made to the adapter's thread changes from now on, which the identity wrapper makes for each form the
   * switch asks of it, counted and shadowed against the adapter's whole activity view of the form.
   */
  tapAdapterChanges(adapter: StreamingAdapter): void {
    this.tapChanges(adapter, 'adapter', 'adapter changes', form => adapter.activityView(form))
  }

  /**
   * Every subscription made to the identity wrapper's thread changes from now on, which the switch makes for each
   * connection, counted and shadowed against the wrapper's `mapSnapshot` of the adapter's whole view of the form.
   */
  tapWrapperChanges(wrapper: SottoThreadHost, adapter: StreamingAdapter): void {
    const whole = (form: boolean): AgentHostSnapshot => (wrapper as unknown as { mapSnapshot(snapshot: AgentHostSnapshot): AgentHostSnapshot }).mapSnapshot(adapter.activityView(form))
    this.claudeWhole = whole
    this.tapChanges(wrapper, 'identity wrapper', 'identity wrapper changes', whole, (form, deliver) => {
      this.fromWrapper = form
      try { deliver() } finally { this.fromWrapper = undefined }
    })
  }

  /**
   * Every subscription made to the provider switch's thread changes from now on, which the workspace makes (#925, step 4),
   * counted and shadowed against the switch's activity snapshot built at the same publish, which nothing in main reads any
   * more. Call it before the workspace is made.
   */
  tapSwitchChanges(native: ConfiguredProviderHost): void {
    const whole = (): AgentHostSnapshot => (native as unknown as { aggregate(): AgentHostSnapshot }).aggregate()
    if (this.on) this.checked['provider switch slot'] = 0
    this.tapChanges(native, 'provider switch', 'provider switch changes', () => whole(), (_form, deliver) => {
      const from = this.fromWrapper, claude = this.claudeWhole
      if (this.on && from !== undefined && claude) this.uncounted(() => this.checkSlot(whole(), claude(from)))
      deliver()
    })
  }

  /**
   * The workspace's thread changes, which the coordinator and usage read (#925, step 5): this subscribes beside them and
   * counts what each publication carries, leaving its own work out. Verifying, its map is checked against the workspace's
   * activity publication from the same publish, which reaches its subscribers first; nothing in main subscribes to that
   * publication any more, so `verifyPublication` subscribes for the shadows. Call it before anything else subscribes to
   * the workspace's activity snapshots.
   */
  tapWorkspaceChanges(workspace: WorkspaceHost): void {
    let latest: AgentHostSnapshot | undefined
    const subscribe = workspace.subscribeActivitySnapshots.bind(workspace)
    workspace.subscribeActivitySnapshots = listener => subscribe(snapshot => { latest = snapshot; listener(snapshot) })
    const follow = this.follower('workspace changes', () => latest!)
    workspace.subscribeActivityChanges(changes => this.uncounted(() => {
      this.carried.workspace += changes.upserts.length + changes.removals.length
      follow(changes)
    }))
  }

  /**
   * Verifying, subscribes to the workspace's activity publication, which nothing in main reads since #925's step 5, so the
   * workspace builds it for the shadows of its thread changes and its publication. Call it after `tap`.
   */
  verifyPublication(workspace: WorkspaceHost): void {
    if (this.on) workspace.subscribeActivitySnapshots(() => undefined)
  }

  /** Shadows what `host`'s activity subscription publishes, through the shim, from every subscription made after this. */
  tap(host: ActivityPublisher, layer: string): void {
    if (!this.on) return
    const subscribe = host.subscribeActivitySnapshots?.bind(host)
    if (!subscribe) throw new Error(`The ${layer} has no activity subscription to shadow.`)
    const see = this.shadow(layer)
    host.subscribeActivitySnapshots = (listener, options) => subscribe(snapshot => { see(snapshot); listener(snapshot) }, options)
  }

  /**
   * Shadows the workspace's state after each accept, with the host stamp: one taking in a whole snapshot, and one taking in
   * only the threads a change named (#925). The state keeps its snapshot across the latter, so the shadow is handed its own.
   */
  tapAccept(workspace: WorkspaceHost): void {
    if (!this.on) return
    const inside = workspace as unknown as { accept(snapshot: AgentHostSnapshot, fromPublication?: boolean): void; acceptThreads(changes: AgentHostChanges): unknown
      state: { snapshot: AgentHostSnapshot } }
    if (typeof inside.accept !== 'function' || typeof inside.acceptThreads !== 'function') throw new Error('WorkspaceHost.accept or acceptThreads is gone; shadow the workspace\'s accepted state another way.')
    const accept = inside.accept.bind(workspace), acceptThreads = inside.acceptThreads.bind(workspace), see = this.shadow('workspace accept')
    inside.accept = (snapshot, fromPublication) => { accept(snapshot, fromPublication); see({ ...inside.state.snapshot }) }
    inside.acceptThreads = changes => { const result = acceptThreads(changes); see({ ...inside.state.snapshot }); return result }
  }

  report(): ThreadChangesReport { return { checked: { ...this.checked }, drift: [...this.drift] } }
  reset(): void { for (const layer of Object.keys(this.carried) as ChangesLayer[]) this.carried[layer] = 0 }

  private tapChanges(host: ChangesPublisher, layer: ChangesLayer, shadowed: string, wholeOf: (form: boolean) => AgentHostSnapshot,
    around?: (form: boolean, deliver: () => void) => void): void {
    const subscribe = host.subscribeActivityChanges?.bind(host)
    if (!subscribe) throw new Error(`The ${layer} publishes no thread changes to shadow.`)
    host.subscribeActivityChanges = (listener, options) => {
      const form = options?.historyFromEvents === true
      const follow = this.follower(shadowed, () => wholeOf(form))
      return subscribe(changes => {
        const records = changes.upserts.length + changes.removals.length
        this.carried[layer] += records
        if (records) this.touched?.(layer, records)
        this.uncounted(() => follow(changes))
        if (around) around(form, () => listener(changes)); else listener(changes)
      }, options)
    }
  }

  /**
   * A thread map fed one subscriber's publications, checked against `wholeOf` after each when verifying. It never asks for
   * a resync: it shares its subscription with main's subscriber, and a publication it could not apply is a drift.
   */
  private follower(layer: string, wholeOf: () => AgentHostSnapshot): (changes: AgentHostChanges) => void {
    if (this.on) this.checked[layer] ??= 0
    const map = new ThreadMap({ wholeOf, verify: this.on })
    return changes => {
      try {
        const applied = map.apply(changes)
        if (applied === 'applied') { if (this.on) this.checked[layer]!++ }
        else this.drift.push(`${layer}: a publication was ${applied === 'resync' ? 'missed' : 'out of order'}`)
      } catch (error) { this.drift.push(`${layer}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  /** The switch's Claude threads against the wrapper's whole snapshot, each named as the switch's `aggregate` named it before #925. */
  private checkSlot(switched: AgentHostSnapshot, wrapped: AgentHostSnapshot): void {
    this.checked['provider switch slot']!++
    const model = (id: string): string => publicProviderEntityId('claude', 'model', id)
    const expected = wrapped.threads.map(thread => ({ ...thread, providerId: 'claude' as const, projectId: thread.projectId, modelId: thread.modelId ? model(thread.modelId) : '',
      ...(thread.usage ? { usage: { ...thread.usage, modelId: thread.usage.modelId ? model(thread.usage.modelId) : undefined } } : {}) }))
    const actual = switched.threads.filter(thread => thread.providerId === 'claude')
    if (actual.length !== expected.length) { this.drift.push(`provider switch slot: ${actual.length} Claude threads where the wrapper published ${expected.length}`); return }
    for (let index = 0; index < expected.length; index++) {
      if (actual[index]!.id !== expected[index]!.id) { this.drift.push(`provider switch slot: thread "${actual[index]!.id}" is where the wrapper has "${expected[index]!.id}"`); return }
      if (!isDeepStrictEqual(actual[index], expected[index])) { this.drift.push(`provider switch slot: thread "${actual[index]!.id}" is unlike the wrapper's`); return }
    }
  }

  private shadow(layer: string): (snapshot: AgentHostSnapshot) => void {
    this.checked[layer] = 0
    let latest: AgentHostSnapshot | undefined
    const publisher = new ThreadChangesPublisher()
    const map = new ThreadMap({ wholeOf: () => latest!, verify: true })
    const subscription = publisher.subscribe(changes => {
      try {
        const applied = map.apply(changes)
        if (applied === 'applied') this.checked[layer]!++
        else this.drift.push(`${layer}: a publication was ${applied === 'resync' ? 'missed' : 'out of order'}`)
        if (applied === 'resync') subscription.resync()
      } catch (error) { this.drift.push(`${layer}: ${error instanceof Error ? error.message : String(error)}`) }
    })
    return snapshot => this.uncounted(() => {
      // Every subscriber of a layer is handed the same publication.
      if (snapshot === latest) return
      latest = snapshot
      publisher.publishSnapshots(() => snapshot)
    })
  }
}

/**
 * Main at the owner's scale, wired as `src/main/index.ts` wires it on `track`: an event-sourced adapter built like
 * Claude's, the provider switch, the workspace, usage on Owl, the coordinator, Watcher with a full record and open on this computer
 * (Owl), the local host service, the desktop router with this computer and one connected remote host, the window's state
 * publisher with the answer-recovery pass it asks for on every publish, the answer-draft store with its retirements, the
 * Watcher room, and the host-update pill's busy check with one saved host on an older Sotto. `scale` sets this computer's
 * threads and the history apart (`ownerScaleCounts`), and `streams` threads are ready to stream. Every payload is
 * generated, and every thread list the adapter and the remote host publish is counted (`threadVisits.ts`).
 */
export async function ownerScalePipeline(root: string, scale: OwnerScale, streams: number, track: OwnerScaleTrack = 'owl',
  options: OwnerScalePipelineOptions = {}): Promise<OwnerScalePipeline> {
  const owl = track === 'owl'
  // As `heldProvidersOf` answers on each track: Owl holds nothing, stable holds every provider of an Owl feature.
  const held: HeldProviders = owl ? new Set() : new Set(['muse', 'opencode'])
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
  const shadows = new ShadowThreadMaps(options.verifyThreadChanges ?? verifyingThreadChanges(), options.uncounted ?? (work => work()), options.touched)
  shadows.tapAdapterChanges(adapter)
  const claude = new SottoThreadHost('claude', adapter, registry)
  shadows.tapWrapperChanges(claude, adapter)
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'claude', enabledProviders: () => ['claude'], threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude, codex: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(),
      // A held provider's adapter is never built: its stand-in starts nothing, as the runtime's does.
      muse: owl ? new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) : new HeldProviderHost('muse'),
      opencode: owl ? new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) : new HeldProviderHost('opencode'), cursor: owl ? new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) : new HeldProviderHost('cursor'), deepseek: owl ? new FakeProviderHost(structuredClone(EMPTY_AGENT_HOST)) : new HeldProviderHost('deepseek') } })
  shadows.tapSwitchChanges(native)
  const workspace = new WorkspaceHost(native, root, () => true, undefined, owl, held, owl, options.storeWriter)
  shadows.tapAccept(workspace)
  shadows.tapWorkspaceChanges(workspace)
  shadows.tap(workspace, 'workspace publication')
  shadows.verifyPublication(workspace)
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  // Usage is an Owl feature: it reads every one of the workspace's thread changes, beside the coordinator (runtime.ts).
  const usage = owl ? new UsageService({ directory: root, host: workspace, acceptedPromptIdentities: identities => workspace.recordedUserMessages(identities) }) : undefined
  usage?.start()
  // Next prompts are an Owl feature (ADR-0132): they hear each thread start and finish from the coordinator's own pass, as
  // runtime.ts wires them. Nothing here ends a turn on an answer, so no side call is asked.
  const nextPrompts = owl ? new NextPrompts({ write: async () => null, thread: id => control.liveThread(id), publish: () => undefined }) : undefined
  const control: AgentControl = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner, watcherEnabled: owl, heldProviders: held, streamingPublishCost: owl,
    ...(usage ? { usage } : {}), ...(nextPrompts ? { nextPrompts } : {}) })
  await control.start()
  await control.command({ type: 'connect' })
  // Every local thread was made here: the workspace keeps each one's started creation, oldest first, so the threads that
  // stream, the newest, come last. Each read of a creation's thread is told to `creationRead`.
  {
    const kept = workspace as unknown as { state: { creations: { threadId: string; projectId: string; commandId: string; phase: string }[]; snapshot: AgentHostSnapshot } }
    const made = [...kept.state.snapshot.threads].reverse()
    kept.state.creations = made.map((item, index) => {
      const creation = { projectId: item.projectId, commandId: `00000000-0000-4000-9000-${index.toString(16).padStart(12, '0')}`, phase: 'started' } as { threadId: string; projectId: string; commandId: string; phase: string }
      const threadId = item.id
      Object.defineProperty(creation, 'threadId', { enumerable: true, get: () => { options.creationRead?.(); return threadId } })
      return creation
    })
  }
  const localHostId = control.hostId()!
  const idOf = (session: string): string => registry.bySession('claude', session)!.threadId
  // Owl's Watcher keeps this computer's check queue (#1312), whose pass runs on every publish.
  const watcher = owl ? new WatcherService({ directory: root, control, host: workspace, historyEnabled: () => true, streamingPublishCost: true, checks: new CheckQueue('This computer') }) : undefined
  const tools = watcher ? new WatcherToolServer(watcher) : undefined
  if (tools) workspace.useWatcherTools(tools)
  // As runtime.ts does once the coordinator has started: this starts Watcher's wake-up pass, which runs on every update.
  await watcher?.recover()
  let roomRecords = 0
  const room = createWatcherRoomDesktop({ watcherEnabled: owl, streamingPublishCost: owl, watcher, send: payload => { roomRecords += historyRecords(payload); return true } })
  const service = new LocalHostService({ control, events: workspace, ...(usage ? { usage } : {}), ...(watcher ? { watcher } : {}) })
  const router: DesktopHostRouter = new DesktopHostRouter(() => emptyDesktopState(control.hostId()), { watcherEnabled: owl, heldProviders: held, streamingPublishCost: owl,
    bindRequestDraftDecision: (target, decisionId, answers): Promise<void> => requestDrafts.bindDecision(target, decisionId, answers) })
  watcher?.useRemoteHosts(router.watcherHosts())
  router.add({ hostId: localHostId, name: 'This computer', kind: 'local', service,
    detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request), subscribeDetail: listener => control.subscribeThreadDetail(listener) })

  // The remote host, as a socket connection holds it: its last pushed state, copied whole for a `shell()` and read in place
  // for a `view()`. Its threads each held a question the user answered. Its catalog lists a few Muse models, which a
  // stable desktop filters out of every build of the window's state.
  const base = control.shell()
  const remoteThreads = Array.from({ length: counts.remoteThreads }, (_, index): AgentThread => ({ id: `remote-${index}`, hostId: REMOTE_HOST_ID,
    projectId: 'remote-project', title: `Synthetic remote thread ${index}`, modelId: 'fake:model', providerId: 'claude', status: 'idle', messages: [], requests: [] }))
  const museModels = Array.from({ length: 4 }, (_, index): AgentModel => ({ id: publicProviderEntityId('muse', 'model', `synthetic-${index}`), provider: 'Muse',
    providerId: 'muse', name: `Synthetic Muse model ${index}`, ready: true }))
  const cached: AgentState = { ...base, hostId: REMOTE_HOST_ID, activeThreadId: null, activeProjectId: null, threadDrafts: [], deliveries: [], followups: [],
    host: { ...base.host, hostId: REMOTE_HOST_ID, connected: true, models: [...base.host.models, ...museModels],
      projects: [{ id: 'remote-project', title: 'Synthetic remote project', path: '/srv/synthetic' }], threads: countedThreads(remoteThreads) } }
  const remoteListeners = new Set<(state: AgentState) => void>()
  const remoteService = {
    shell: () => structuredClone(uncounted(cached)), view: () => ({ ...cached }),
    threadKind: (id: string) => cached.host.threads.find(item => item.id === id)?.kind,
    subscribe: (listener: (state: AgentState) => void) => { remoteListeners.add(listener); return () => remoteListeners.delete(listener) },
    command: async () => structuredClone(uncounted(cached)),
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
  // On Owl, with nothing held, main's store takes no dormant check; on stable it keeps a held provider's owners, asking
  // this computer's workspace or the owner's host.
  const dormant = owl && !held.size ? undefined : (owner: RequestDraftOwner): boolean | undefined => {
    if (owner.kind !== 'thread') return false
    const key = parseHostEntityKey(owner.ownerId)
    if (key && key.hostId !== control.hostId()) return router.preservesDormantThread(owner.ownerId)
    return workspace.dormantThreadIds().includes(key?.id ?? owner.ownerId)
  }
  const requestDrafts: RequestDraftService = new RequestDraftService(root, owner => { lookups++; return requestDraftOwnerState(owner, control, router) }, async () => undefined,
    undefined, dormant, () => requestDraftWatcherOwnerIds(control, () => workspace.dormantThreadIds(), router))
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
    offCount(); updates.dispose(); room?.dispose(); offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose(); watcher?.close(); await tools?.close()
    control.dispose(); usage?.close(); workspace.disconnect(); await workspace.privacyChanged(); await registry.flush(); workspace.dispose()
  }

  const streamIds = streamSessions.map(idOf)
  const openThread = hostEntityKey(localHostId, idOf(openSession))
  const view = control.requestDraftView()
  const asking = view.host.threads.find(item => item.id === idOf('asking-0'))!
  const question: RequestDraftTarget = { kind: 'thread', ownerId: asking.id, providerId: requestDraftProvider(view.host, asking, view.provider), requestId: 'question-1', questions: QUESTIONS }
  try {
    // Threads delegated from the last idle thread, which no one watches, as the owner's delegations leave them (ADR-0081).
    // Watcher reads none of them: only threads under a watched thread are its news (#925 step 5).
    const delegating = state.threads.at(-1)!.id
    for (const item of state.threads.slice(-1 - counts.delegations, -1)) await workspace.setDelegatedBy(idOf(item.id), idOf(delegating))
    // The threads that took part in Watcher's requests: this computer's idle threads and the remote host's. The threads
    // that stream took part too and were let go, as a thread Watcher has long driven was (#1450). The first threads are watched.
    const watched = [...streamIds, ...localIds].slice(0, counts.watches)
    const streamed: WatcherThreadTarget[] = streamIds.map(threadId => ({ hostId: localHostId, threadId }))
    const targets: WatcherThreadTarget[] = [...localIds.slice(counts.watches).map(threadId => ({ hostId: localHostId, threadId })),
      ...remoteThreads.map(item => ({ hostId: REMOTE_HOST_ID, threadId: item.id }))]
    if (watcher) {
      // Watcher open on this computer, with the owner's record: standing watches, requests with the threads that took
      // part, and the operations Watcher sent them, every one long answered.
      const model = control.watcherSnapshot().models.find(item => item.providerId === 'claude')!
      const opened = await watcher.open({ provider: 'claude', modelId: model.id })
      if (opened.status !== 'ok') throw new Error(`Watcher did not open: ${JSON.stringify(opened)}`)
      for (const threadId of watched) {
        const result = await watcher.watchThread({ target: { hostId: localHostId, threadId } })
        if (result.status !== 'ok') throw new Error(`Watcher did not watch a thread: ${JSON.stringify(result)}`)
      }
      await control.updateWatcher(record => { addWatcherHistory(record, targets, counts, undefined, streamed) })
      // One of those starts is a check still holding its place, as a running check does: the pass on every publish reads it
      // by its position, and so must not grow with the history behind it (#1312).
      const started = control.watcherRecord().operations.findLast(item => item.action === 'start' && item.target.hostId === localHostId)
      if (started) {
        const queue = watcher as unknown as { joinChecks(ticket: string): unknown; adoptCheck(check: unknown, operationId: string): void }
        queue.adoptCheck(queue.joinChecks(started.id), started.id)
      }
    } else {
      // Stable starts no Watcher and keeps the record an Owl build left, whole (ADR-0072).
      control.mutateWatcher(record => {
        record.watches = watched.map((threadId, index) => ({ id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
          target: { hostId: localHostId, threadId }, createdAt: AT, generation: 0 }))
        addWatcherHistory(record, targets, counts, { hostId: localHostId, threadId: 'earlier-watcher' }, streamed)
      })
    }
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
      adapter.mark(session.id)
      adapter.publish(false)
    },
  }
  return {
    track, counts, adapter, control, router, requestDrafts, watcher, streamSessions, openThread, workspace, question, actions,
    broadcasts: () => broadcasts,
    adapterChangeRecords: () => shadows.carried.adapter,
    wrapperChangeRecords: () => shadows.carried['identity wrapper'],
    switchChangeRecords: () => shadows.carried['provider switch'],
    workspaceChangeRecords: () => shadows.carried.workspace,
    ownerLookups: () => lookups,
    watcherRoomRecords: () => roomRecords,
    resetCounts: () => { broadcasts = 0; lookups = 0; roomRecords = 0; shadows.reset() },
    // Watcher's observe and wake-up passes, checked against the whole passes in verifying mode, on Owl (#925 step 5), and
    // the window's broadcasts read in part, checked against the whole walk (#925 step 6).
    threadChanges: () => { const report = shadows.report(); return { ...report, checked: { ...report.checked, 'coordinator changes': control.verifiedChanges,
      'window broadcast': broadcaster.threadEncodes.verified,
      ...watcher ? { 'Watcher observe passes': watcher.verifiedObserves, 'Watcher wake-up passes': watcher.wakes.verifiedPasses } : {} } } },
    stop,
  }
}

/**
 * The records of Watcher's history a room or a room update carries to the window (#1450): requests, receipts, earlier
 * Watchers and each watched row's participations, whole or as the entries that changed, whole or in part.
 */
function historyRecords(payload: WatcherRoomState | WatcherRoomUpdate): number {
  const update = 'base' in payload && 'revision' in payload ? payload : undefined
  const room: Partial<WatcherRoomState> = update ? update.room : payload as WatcherRoomState
  const entries = (change: WatcherRoomListChange | undefined) => (change?.at.length ?? 0) + (change?.patch?.length ?? 0)
  const participations = (rows: readonly unknown[]) => rows.reduce<number>((n, row) => n + ((row as { participation?: unknown[] } | undefined)?.participation?.length ?? 0), 0)
  let records = 0
  for (const key of ['requests', 'receipts', 'history'] as const) records += (room[key]?.length ?? 0) + entries(update?.lists?.[key])
  records += participations(room.watchedThreads ?? [])
  const rows = update?.lists?.watchedThreads
  records += participations((rows?.at ?? []).map(([, row]) => row))
  for (const [, patch] of rows?.patch ?? []) records += ((patch.set?.participation as unknown[] | undefined)?.length ?? 0) + entries(patch.lists?.participation)
  return records
}
