import type { BrowserAgentTools } from './browserAgentServer'
import type { ScopedThreadTools } from './threadToolServer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { cloneHostSnapshot, clonePlainData } from './cloneHostSnapshot'
import { ActivitySubscribers, cloneSnapshotSharingActivities, immutableModels, immutableRecord, immutableUpdates, isImmutableModels, ownBuiltRecord, subscribeActivitySnapshots } from './activitySnapshots'
import { join, resolve } from 'node:path'
import { EMPTY_AGENT_HOST, PROVIDER_LABELS, parsePublicProviderEntityId, providerIdSchema, publicProviderEntityId, type AgentCapabilities, type AgentHostSnapshot, type AgentModel, type AgentProviderStatus, type AgentThread, type ProviderId } from '../../shared/agents'
import { restOf } from './adapterThreadChanges'
import { ThreadChangesPublisher, ThreadMap, inPlacingOrder, threadChangesBetween, type ActivityChangesListener, type ActivityChangesSubscription, type AgentHostChanges,
  type AgentHostRest, type ThreadChangeSet, type ThreadPlacement } from './threadChanges'
import { resolveModel } from '../../shared/modelCatalog'
import { ProviderUnavailable, providerProblemOf } from './providerProblem'
import { sameSnapshot } from './sameSnapshot'
import { isUsageProviderId, reportsUsageLimits, type UsageQuotaRead, type UsageTokenObservation } from '../../shared/usageDashboard'
import { mappedSink, type UsageHistorySink } from './usageHistory/sink'
import { unavailableProviderQuota } from './providerQuota'
import { confirmedSettingsSnapshot, type ActivitySubscriptionOptions, type AgentHost, type AgentHostCommand, type AgentHostResult, type AgentSkillScope, type RestoredThreadHistory, type ShortTextPrompt, type ThreadHistorySource, type ThreadHostEvent, type ThreadReadPurpose, type ThreadSessionDraft, type ThreadLaunchProfiles, type ThreadForkRequest, type WorkerRoleSource } from './host'

/** Public IDs are opaque to callers and reversible only at the provider boundary. */
export function providerEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  return publicProviderEntityId(provider, kind, value)
}
function nativeEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  const parsed = parsePublicProviderEntityId(value)
  if (parsed?.provider !== provider || parsed.kind !== kind) throw new Error(`Choose a ${kind} belonging to ${PROVIDER_LABELS[provider]}.`)
  return parsed.value
}
/** A skill selected for a provider that has none (Devin). Nothing is sent, and the draft keeps the prompt. */
export function providerTakesNoSkills(provider: ProviderId): Error {
  return new Error(`${PROVIDER_LABELS[provider]} does not take skills. Your prompt has not been sent; remove the skill from it and send it again.`)
}
function folderKey(path: string): string { const key = resolve(path); return process.platform === 'win32' ? key.toLowerCase() : key }
type Slot = {
  /** Every part of what the provider last said but its threads, kept by the rules in `acceptView`. */
  view: AgentHostRest
  /** The provider's threads as the switch shows them, in its order: its records, owned all the way down and only replaced. */
  threads: ThreadMap
  /**
   * What this connection's activity subscription last published, as the provider's thread changes or as the shim worked
   * them out from its snapshots. Undefined with no subscription.
   */
  incoming?: ThreadMap | undefined
  /**
   * `threads` is not what the subscription last published: a read replaced it, or a provider that is not connected
   * published no threads and the switch kept the ones it had. The next publication then replaces it whole, as each used to.
   */
  diverged: boolean
  /** Per thread: the provider's record last named, and the record the switch named it as. */
  named: Map<string, { readonly input: AgentThread; readonly output: AgentThread }>
  /** The view and status the switch's thread changes were last marked for. */
  marked?: { readonly view: AgentHostRest; readonly status: AgentProviderStatus } | undefined
  status: AgentProviderStatus; wanted: boolean; epoch: number; connecting?: Promise<void> | undefined;
  unsubscribeSnapshot?: (() => void) | undefined; unsubscribeEvents?: (() => void) | undefined; unsubscribeUsage?: (() => void) | undefined
  /** What this connection's activity subscription asked the provider: to leave its messages out, or not. */
  historyFromEvents?: boolean | undefined }

/** One form's marks for the switch's thread changes: what changed since that form was last published. */
interface SwitchMarks {
  /** Everything may have changed: the next publication is worked out from the whole view. */
  all: boolean
  /** A part that is not threads changed. */
  rest: boolean
  /** The threads that changed, came or went, by the provider that holds or held each. */
  readonly ids: Map<string, ProviderId>
  /** Threads that came or moved, so the publication places them. */
  readonly placed: Set<string>
}

/** The rest a slot's thread map carries, which nothing reads: the slot keeps its own view. */
const SLOT_MAP_REST = immutableRecord(restOf(EMPTY_AGENT_HOST))

function slotThreads(records: readonly AgentThread[] = []): ThreadMap {
  const map = new ThreadMap({ verify: false })
  map.apply({ sequence: 0, whole: true, upserts: records, removals: [], rest: SLOT_MAP_REST })
  return map
}

/** Independent native connections; durable Sotto thread identity selects the transport, never reasoning settings. */
export class ConfiguredProviderHost implements AgentHost {
  useLaunchProfiles(profiles: ThreadLaunchProfiles): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useLaunchProfiles?.(profiles)
  }
  profileRefusalHandler(threadId: string) {
    // Each SottoThreadHost stops only its bound or early-start runtime. Include early starts
    // whose provider is not yet in the durable registry; one broken cleanup must not block another.
    const handlers = Object.values(this.options.hosts).flatMap(host => {
      const handler = host.profileRefusalHandler?.(threadId)
      return handler ? [handler] : []
    })
    return async (reason: string): Promise<void> => { await Promise.allSettled(handlers.map(async handler => handler(reason))) }
  }
  readonly concurrentProviders = true
  private legacyProjectProvider: ProviderId | undefined
  private identityLoad: Promise<void> | undefined
  private readonly registrations = new Set<string>()
  private readonly registrationStore: AtomicJsonStore<string[]> | undefined
  private registrationLoad: Promise<void> | undefined
  /** Undefined until something says what it is looking at; a connection never invents a watched set. */
  private observed: readonly string[] | undefined
  /** The settled threads the caller last named, handed to each provider as it connects. */
  private settled: readonly string[] | undefined
  private readonly slots = new Map<ProviderId, Slot>()
  /** Each provider's models as last named, and the catalog last published from them. */
  private readonly namedModels = new Map<ProviderId, { source: AgentModel[]; connected: boolean; models: AgentModel[] }>()
  private aggregateModels: { parts: AgentModel[][]; models: AgentModel[] } | undefined
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  /** Each activity subscriber, and whether it keeps history from the providers' events. */
  private readonly activityListeners = new ActivitySubscribers()
  /** The switch's thread changes (#925), and whether each of their subscribers keeps history from the providers' events. */
  private readonly changes = new ThreadChangesPublisher()
  private readonly changeSubscribers = new Set<{ readonly historyFromEvents: boolean }>()
  private readonly marks = new Map<boolean, SwitchMarks>([false, true].map(form => [form, { all: true, rest: false, ids: new Map(), placed: new Set() }]))
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  private readonly usageListeners = new Set<(record: UsageTokenObservation) => void>()
  /** Thread events from whichever provider owns the thread. Absent when no provider publishes any. */
  readonly subscribeEvents?: (listener: (event: ThreadHostEvent) => void) => () => void
  readonly subscribeUsage?: (listener: (record: UsageTokenObservation) => void) => () => void
  readonly visitUsage?: (threadId: string, visitor: (record: UsageTokenObservation) => void) => void
  readonly readProviderQuota?: (providerId: ProviderId, refresh: boolean, background?: boolean) => Promise<UsageQuotaRead>
  readonly scanUsageHistory?: (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>
  constructor(private readonly options: {
    hosts: Record<ProviderId, AgentHost>; provider: () => ProviderId
    directory?: string
    enabledProviders?: () => readonly ProviderId[]
    threadProvider?: (threadId: string) => string | undefined
  }) {
    if (options.directory) this.registrationStore = new AtomicJsonStore(join(options.directory, 'provider-project-registrations.json'), value => z.array(z.string()).parse(value), () => [])
    for (const id of providerIdSchema.options) {
      this.slots.set(id, { view: restOf(structuredClone(EMPTY_AGENT_HOST)), threads: slotThreads(), diverged: false, named: new Map(), wanted: false, epoch: 0,
        status: { id, name: PROVIDER_LABELS[id], version: '', connection: 'disconnected', capabilities: structuredClone(EMPTY_AGENT_HOST.capabilities) } })
    }
    if (providerIdSchema.options.some(id => options.hosts[id].subscribeEvents)) {
      this.subscribeEvents = listener => { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
    }
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].subscribeUsage)) {
      this.subscribeUsage = listener => {
        this.usageListeners.add(listener)
        return () => this.usageListeners.delete(listener)
      }
    }
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].visitUsage)) this.visitUsage = (threadId, visitor) => {
      for (const id of providerIdSchema.options) if (isUsageProviderId(id)) options.hosts[id].visitUsage?.(threadId, record => visitor({ ...record, providerId: id,
        modelId: providerEntityId(id, 'model', record.modelId) }))
    }
    // Each provider reads its own local records in turn, connected or not: reading them starts no session.
    if (providerIdSchema.options.some(id => isUsageProviderId(id) && options.hosts[id].scanUsageHistory)) this.scanUsageHistory = async (sink, signal) => {
      for (const id of providerIdSchema.options) {
        const host = options.hosts[id]
        if (signal.aborted) return
        if (!isUsageProviderId(id) || !host.scanUsageHistory) continue
        const project = <T extends { providerId: string; modelId: string }>(record: T): T => ({ ...record, providerId: id, modelId: providerEntityId(id, 'model', record.modelId) })
        try { await host.scanUsageHistory(mappedSink(sink, { token: project, prompt: project }), signal) }
        catch { /* One provider's unreadable records leave the others' to read. */ }
      }
    }
    if (providerIdSchema.options.some(id => options.hosts[id].readProviderQuota)) this.readProviderQuota = async (providerId, refresh, background) => {
      if (!reportsUsageLimits(providerId)) throw new Error('Usage reads no limits for this provider.')
      const slot = this.slots.get(providerId), epoch = slot?.epoch
      if (slot?.status.connection !== 'connected') return unavailableProviderQuota(providerId, 'not-connected')
      const quota = await options.hosts[providerId].readProviderQuota?.(providerId, refresh, background)
        ?? unavailableProviderQuota(providerId, 'unsupported')
      if (slot.epoch !== epoch || slot.status.connection !== 'connected') return unavailableProviderQuota(providerId, 'not-connected')
      return { ...quota, windows: quota.windows.map(window => ({ ...window,
        ...(window.modelId ? { modelId: providerEntityId(providerId, 'model', window.modelId) } : {}) })) }
    }
  }
  /** Each provider asks the store about the threads it owns; a thread it does not own answers nothing. */
  useBrowserTools(tools: BrowserAgentTools): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useBrowserTools?.(tools)
  }
  useThreadTools(tools: readonly ScopedThreadTools[]): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useThreadTools?.(tools)
  }
  useWorkerRoles(roles: WorkerRoleSource): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useWorkerRoles?.(roles)
  }
  useThreadHistory(source: ThreadHistorySource): void {
    for (const id of providerIdSchema.options) this.options.hosts[id].useThreadHistory?.(source)
  }
  /** Capture the restored legacy project scope before UI configuration can change the default. */
  initialize(): Promise<void> {
    this.identityLoad ??= (async () => {
      if (!this.options.directory) { this.legacyProjectProvider = this.options.provider(); this.renamed(); return }
      const schema = z.object({ legacyProjectProvider: providerIdSchema })
      const store = new AtomicJsonStore(join(this.options.directory, 'provider-project-identity.json'), schema.parse,
        () => ({ legacyProjectProvider: this.options.provider() }))
      const identity = await readFile(join(this.options.directory, 'provider-project-identity.json'), 'utf8')
        .then(contents => schema.parse(JSON.parse(contents)))
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return { legacyProjectProvider: this.options.provider() }; throw error })
      await store.write(identity)
      this.legacyProjectProvider = identity.legacyProjectProvider
      this.renamed()
    })().catch(error => { this.identityLoad = undefined; throw error })
    return this.identityLoad
  }
  /** Which provider keeps unnamed project IDs is now known, so every thread is named again. */
  private renamed(): void {
    for (const slot of this.slots.values()) slot.named.clear()
    this.markAll()
  }
  private projectId(provider: ProviderId, id: string): string {
    return provider === this.legacyProjectProvider ? id : providerEntityId(provider, 'project', id)
  }
  createProjectId(provider: ProviderId): string { return this.projectId(provider, randomUUID()) }
  /**
   * A whole snapshot a read handed back (a connection, a snapshot, a thread read, a settings change) becomes the
   * provider's slot, as a publication of its activity subscription would. It is copied once, sharing every record and
   * part that equals what the slot holds, so the switch never writes into what a provider handed it.
   */
  private accept(id: ProviderId, snapshot: AgentHostSnapshot): void {
    const slot = this.slots.get(id)!
    const { threads, ...parts } = snapshot
    const [rest, ...records] = immutableUpdates<unknown>([parts, ...threads], [slot.view, ...threads.map(thread => slot.threads.get(thread.id))]) as [AgentHostRest, ...AgentThread[]]
    this.acceptView(id, slot, rest)
    if (rest.connected || records.length) {
      this.replaceThreads(id, slot, records)
      // A read of what the subscription last published, as most reads are, leaves the next publication to apply as it is.
      slot.diverged = !this.followsIncoming(slot)
    } else if (slot.threads.size) slot.diverged = true
  }
  /**
   * A publication of the provider's activity subscription, already applied to `slot.incoming`. While the slot shows what
   * the subscription published, the same change applies to the slot, at a cost that follows the change. Otherwise the
   * slot is replaced with what the subscription holds, as each publication used to replace it whole.
   */
  private acceptIncoming(id: ProviderId, slot: Slot, changes: AgentHostChanges): void {
    const incoming = slot.incoming!
    const rest = incoming.rest!
    this.acceptView(id, slot, rest)
    if (rest.connected || incoming.size) {
      if (slot.diverged || changes.whole) this.replaceThreads(id, slot, incoming.threads())
      else this.applyThreads(id, slot, changes)
      slot.diverged = false
    } else if (slot.threads.size) slot.diverged = true
  }
  /** Whether the slot's threads are the records the subscription last published, in its order. */
  private followsIncoming(slot: Slot): boolean {
    const incoming = slot.incoming
    if (!incoming || incoming.sequence === undefined || incoming.size !== slot.threads.size) return false
    const ids = incoming.ids()
    for (const id of slot.threads.ids()) {
      const next = ids.next()
      if (next.done || next.value !== id || incoming.get(id) !== slot.threads.get(id)) return false
    }
    return true
  }
  /**
   * The parts of a provider's snapshot that are not its threads, and the provider's status. A transport disappearing must
   * not discard the identities and recovery material it already supplied: a provider that is not connected keeps its
   * projects and models when it names none, as `accept` and `acceptIncoming` keep its threads.
   */
  private acceptView(id: ProviderId, slot: Slot, snapshot: AgentHostRest): void {
    slot.view = snapshot.connected ? snapshot : { ...slot.view, ...snapshot,
      projects: snapshot.projects.length ? snapshot.projects : slot.view.projects,
      models: snapshot.models.length ? snapshot.models : slot.view.models }
    const status: AgentProviderStatus = { id, name: PROVIDER_LABELS[id], version: snapshot.version || slot.status.version,
      capabilities: snapshot.connected ? snapshot.capabilities : slot.status.capabilities,
      connection: snapshot.connected ? 'connected' : snapshot.error ? 'error' : slot.connecting ? 'connecting' : 'disconnected',
      ...(snapshot.verifiedVersion ? { verifiedVersion: snapshot.verifiedVersion } : {}),
      ...(snapshot.connected && snapshot.sandboxDisabled !== undefined ? { sandboxDisabled: snapshot.sandboxDisabled } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      // What the Hosts page's tile decides on (ADR-0037): why it is not connected, or what it is signed in with.
      ...(!snapshot.connected && snapshot.error && snapshot.problem ? { problem: snapshot.problem } : {}),
      ...(!snapshot.connected && snapshot.error && snapshot.problem === 'too-old' && snapshot.requiredVersion ? { requiredVersion: snapshot.requiredVersion } : {}),
      ...(snapshot.connected && snapshot.account ? { account: snapshot.account } : {}) }
    // A status that says the same is kept as it is, so an update that changed no status marks no change to it.
    if (!sameSnapshot(status, slot.status)) slot.status = status
  }
  /** The slot's threads become `records`, owned, marking what changed for the switch's thread changes. Costs every thread. */
  private replaceThreads(id: ProviderId, slot: Slot, records: readonly AgentThread[]): void {
    const held = slot.threads
    const present = new Set(records.map(record => record.id))
    const kept: string[] = []
    for (const thread of held.ids()) {
      if (present.has(thread)) kept.push(thread)
      else { this.mark(id, thread); slot.named.delete(thread) }
    }
    let at = 0, moved = false
    for (const record of records) {
      if (!held.has(record.id)) { this.mark(id, record.id, true); continue }
      if (kept[at++] !== record.id) moved = true
      // A read and the subscription build their own records for one state, so an equal record is no change.
      const before = held.get(record.id)
      if (before !== record && !isDeepStrictEqual(before, record)) this.mark(id, record.id)
    }
    // Threads the slot kept changed order, which is rarer than anything else here: the next publication is worked out whole.
    if (moved) this.markAll()
    slot.threads = slotThreads(records)
  }
  /** One change the subscription published, applied to a slot that shows what it published before, marking what it changed. */
  private applyThreads(id: ProviderId, slot: Slot, changes: AgentHostChanges): void {
    const held = slot.threads
    const removed = new Set<string>()
    for (const thread of changes.removals) if (held.has(thread)) { removed.add(thread); this.mark(id, thread); slot.named.delete(thread) }
    // A thread that came, or went and came back in the same change, goes last, so it is placed.
    for (const record of changes.upserts) this.mark(id, record.id, !held.has(record.id) || removed.has(record.id))
    for (const placement of changes.placements ?? []) this.mark(id, placement.id, true)
    held.apply({ sequence: held.sequence! + 1, upserts: changes.upserts, removals: changes.removals, ...(changes.placements ? { placements: changes.placements } : {}) })
  }
  /** A slot's view as no longer connected. It may be a provider's publication, which is never written into. */
  private markDisconnected(slot: Slot): void { slot.view = { ...slot.view, connected: false } }
  private failed(id: ProviderId, error: unknown): void {
    const slot = this.slots.get(id)!
    const named = providerProblemOf(error)
    const status = { ...slot.status }; delete status.account; delete status.problem; delete status.requiredVersion
    slot.status = { ...status, connection: 'error', error: error instanceof Error ? error.message : 'Provider connection failed.',
      ...(named ? { problem: named.problem } : {}), ...(named?.version ? { version: named.version } : {}),
      ...(named?.problem === 'too-old' && named.requiredVersion ? { requiredVersion: named.requiredVersion } : {}) }
    this.markDisconnected(slot)
  }
  /**
   * Every provider's snapshot as one, provider by provider. Each thread is the record the switch named for it (`named`),
   * so the snapshot costs a reference per thread rather than a new record. `threads: false` leaves the threads out, for a
   * caller that reads only the catalog, the projects or the connection.
   */
  private aggregate(threads?: true): AgentHostSnapshot
  private aggregate(threads: false): AgentHostRest
  private aggregate(threads = true): AgentHostSnapshot | AgentHostRest {
    // One copy of every provider's status, not one per provider, so a new provider adds no copy to each publish.
    const providers = clonePlainData([...this.slots.values()].map(slot => slot.status))
    const capabilities = { ...EMPTY_AGENT_HOST.capabilities }
    for (const provider of providers.filter(provider => provider.connection === 'connected')) {
      for (const key of Object.keys(provider.capabilities) as (keyof AgentCapabilities)[]) if (provider.capabilities[key]) capabilities[key] = true
    }
    const connected = providers.filter(provider => provider.connection === 'connected')
    const result: AgentHostSnapshot = { connected: connected.length > 0, name: connected.length === 1 ? connected[0]!.name : 'Native providers', version: '', capabilities, providers,
      models: [], projects: [], threads: [] }
    const parts: AgentModel[][] = []
    for (const [provider, slot] of this.slots) {
      parts.push(this.slotModels(provider, slot))
      result.projects.push(...slot.view.projects.map(project => ({ ...project, providerId: provider, id: this.projectId(provider, project.id) })))
      if (threads) for (const record of slot.threads.threads()) result.threads.push(this.named(provider, slot, record))
    }
    // One catalog for every publish until a provider's own catalog or connection changes, so the layers to the window
    // share it rather than copy it (#917).
    // A host whose adapter does not certify its catalog hands over a new one each time; freezing that would only add work.
    const held = this.aggregateModels
    const certified = [...this.slots.values()].every(slot => !slot.view.models.length || isImmutableModels(slot.view.models))
    result.models = held && held.parts.length === parts.length && held.parts.every((part, index) => part === parts[index]) ? held.models
      : certified ? immutableModels(parts.flat()) : parts.flat()
    this.aggregateModels = { parts, models: result.models }
    if (!result.connected) {
      const error = providers.find(provider => provider.error)?.error
      if (error) result.error = error
    }
    if (threads) return result
    const rest: Partial<AgentHostSnapshot> = result
    delete rest.threads
    return rest as AgentHostRest
  }
  /**
   * A provider's thread as the switch names it: its provider, and its project and model IDs public. The record named for
   * the same provider record before is handed back as it is, so a thread that did not change keeps its record through
   * every publication and every snapshot.
   */
  private named(provider: ProviderId, slot: Slot, record: AgentThread): AgentThread {
    const held = slot.named.get(record.id)
    if (held?.input === record) return held.output
    const usage = record.usage ? ownBuiltRecord({ ...record.usage, modelId: record.usage.modelId ? providerEntityId(provider, 'model', record.usage.modelId) : undefined }) : undefined
    const output = ownBuiltRecord({ ...record, providerId: provider,
      projectId: this.projectId(provider, record.projectId), modelId: record.modelId ? providerEntityId(provider, 'model', record.modelId) : '',
      ...(usage ? { usage } : {}) })
    slot.named.set(record.id, { input: record, output })
    return output
  }
  /** A provider's models as the switch names them, rebuilt only when its catalog or its connection changes. */
  private slotModels(provider: ProviderId, slot: { view: AgentHostRest; status: AgentProviderStatus }): AgentModel[] {
    const connected = slot.status.connection === 'connected'
    const held = this.namedModels.get(provider)
    if (held && held.source === slot.view.models && held.connected === connected) return held.models
    const models = slot.view.models.map(model => ({ ...model, providerId: provider,
      id: providerEntityId(provider, 'model', model.id), ready: model.ready && connected }))
    this.namedModels.set(provider, { source: slot.view.models, connected, models })
    return models
  }
  /** This thread of this provider changed, came or went; `placed`: it came or moved, so the publication places it. */
  private mark(provider: ProviderId, id: string, placed = false): void {
    if (!this.changes.size) return
    for (const marks of this.marks.values()) {
      if (marks.all) continue
      marks.ids.set(id, provider)
      if (placed) marks.placed.add(id)
    }
  }
  /** Anything may have changed: the next publication of each form is worked out from the whole view. */
  private markAll(): void {
    for (const marks of this.marks.values()) { marks.all = true; marks.ids.clear(); marks.placed.clear() }
  }
  /**
   * What the switch's thread changes carry for one form since it was last published, built when its publisher builds it:
   * a publication asked for while another is being delivered builds afterwards, and carries every mark made by then.
   * Each marked thread is upserted as the switch names it, or removed, and a thread that came or moved is placed just
   * before the thread that follows it in the switch's order, provider by provider: a new thread of one provider lands
   * before the next provider's first thread. A first publication, and one after `markAll`, is worked out from the whole
   * view by the shim, which costs a comparison per thread.
   */
  private switchChanges(historyFromEvents: boolean, published: ThreadMap | undefined): ThreadChangeSet {
    const marks = this.marks.get(historyFromEvents)!
    const all = marks.all, rest = marks.rest, ids = [...marks.ids], placed = new Set(marks.placed)
    marks.all = false; marks.rest = false; marks.ids.clear(); marks.placed.clear()
    if (!published || all) return threadChangesBetween(published, this.aggregate())
    const upserts: AgentThread[] = [], removals: string[] = [], placing: { id: string; provider: ProviderId }[] = []
    const upserted = new Set<string>()
    for (const [id, provider] of ids) {
      const slot = this.slots.get(provider)!
      const record = slot.threads.get(id)
      if (record) {
        upserts.push(this.named(provider, slot, record)); upserted.add(id)
        if (!published.has(id) || placed.has(id)) placing.push({ id, provider })
      } else if (published.has(id)) removals.push(id)
    }
    const placements: ThreadPlacement[] = []
    for (const { id, provider } of placing) {
      const beforeId = this.slots.get(provider)!.threads.nextId(id) ?? this.firstThreadAfter(provider)
      // A thread the marks missed would be placed before one the subscriber does not hold; the whole view says it right.
      if (beforeId !== null && !upserted.has(beforeId) && !published.has(beforeId)) return threadChangesBetween(published, this.aggregate())
      placements.push({ id, beforeId })
    }
    return { upserts, removals, ...(placements.length ? { placements: inPlacingOrder(placements) } : {}), ...(rest ? { rest: this.aggregate(false) } : {}) }
  }
  /** The first thread of the first provider after `provider` that has any, or null when none has. */
  private firstThreadAfter(provider: ProviderId): string | null {
    let after = false
    for (const [id, slot] of this.slots) {
      if (after && slot.threads.firstId !== undefined) return slot.threads.firstId
      if (id === provider) after = true
    }
    return null
  }
  /** Whether a provider's view or status changed since the switch's thread changes were last marked for it. */
  private markRest(): void {
    let changed = false
    for (const slot of this.slots.values()) {
      if (slot.marked?.view === slot.view && slot.marked.status === slot.status) continue
      slot.marked = { view: slot.view, status: slot.status }
      changed = true
    }
    if (changed && this.changes.size) for (const marks of this.marks.values()) marks.rest = true
  }
  /**
   * The aggregate is built afresh for each publish over what the slots hold, which is replaced and never edited, so the
   * activity subscribers share it as it is. An ordinary subscriber still gets a copy of its own. The thread changes go out
   * from the same publish, carrying what was marked since the last.
   */
  private publish(): void {
    if (!this.listeners.size && !this.activityListeners.size && !this.changes.size) return
    if (this.listeners.size || this.activityListeners.size) {
      const snapshot = this.aggregate()
      for (const listener of this.listeners) listener(cloneHostSnapshot(snapshot))
      this.activityListeners.publish(() => snapshot, true)
    }
    if (!this.changes.size) return
    this.markRest()
    this.changes.publishChanges((historyFromEvents, published) => this.switchChanges(historyFromEvents, published))
  }
  /** Every thread of every provider as a caller is handed it: its own copy, with certified activity and catalogs shared. */
  private handOut(): AgentHostSnapshot { return cloneSnapshotSharingActivities(this.aggregate()) }
  async connect(provider?: ProviderId): Promise<AgentHostSnapshot> {
    const requested = (provider ? [provider] : this.options.enabledProviders?.() ?? [this.options.provider()]).map(id => ({ id, epoch: this.slots.get(id)!.epoch }))
    await this.initialize()
    await Promise.all(requested.filter(({ id, epoch }) => this.slots.get(id)!.epoch === epoch).map(({ id }) => this.connectOne(id)))
    return this.handOut()
  }
  private async connectOne(id: ProviderId): Promise<void> {
    const slot = this.slots.get(id)!
    if (slot.connecting) return slot.connecting
    if (slot.status.connection === 'connected') return
    slot.wanted = true; const epoch = ++slot.epoch
    slot.unsubscribeSnapshot?.(); slot.unsubscribeEvents?.(); slot.unsubscribeUsage?.()
    slot.status = { ...slot.status, connection: 'connecting' }; delete slot.status.error; delete slot.status.problem; delete slot.status.requiredVersion
    this.watchActivity(id, slot, epoch)
    // A thread belongs to one provider. Its events keep that provider's connection epoch.
    slot.unsubscribeEvents = this.options.hosts[id].subscribeEvents?.(event => {
      if (!slot.wanted || slot.epoch !== epoch) return
      for (const listener of this.eventListeners) listener(event)
    })
    slot.unsubscribeUsage = isUsageProviderId(id) ? this.options.hosts[id].subscribeUsage?.(record => {
      if (!slot.wanted || slot.epoch !== epoch) return
      const projected = { ...record, providerId: id, modelId: providerEntityId(id, 'model', record.modelId) }
      for (const listener of this.usageListeners) listener(projected)
    }) : undefined
    this.publish()
    if (this.observed) this.options.hosts[id].observeThreads?.(this.observed)
    if (this.settled) this.options.hosts[id].useSettledThreads?.(this.settled)
    const pending = (async () => {
      try {
        const snapshot = await this.options.hosts[id].connect()
        if (slot.epoch !== epoch) { if (!slot.wanted) this.options.hosts[id].disconnect(); return }
        this.accept(id, snapshot)
        // A refusal an adapter returns (Claude Code's and Devin's) keeps the reason it named, as a thrown one does.
        if (!snapshot.connected) {
          const message = snapshot.error || `${PROVIDER_LABELS[id]} did not confirm the connection.`
          this.failed(id, snapshot.problem ? new ProviderUnavailable(snapshot.problem, message, snapshot.version || undefined, snapshot.requiredVersion) : new Error(message))
        }
      } catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
      finally { if (slot.epoch === epoch) { slot.connecting = undefined; this.publish() } }
    })()
    slot.connecting = pending
    return pending
  }
  /**
   * One provider's activity for this connection, asking it to leave its messages out only when nothing here reads them.
   * It comes as the provider's thread changes (#925), or, from a host that publishes none, as its activity snapshots,
   * which the shim turns into changes by comparing each thread with the record it last published.
   */
  private watchActivity(id: ProviderId, slot: Slot, epoch: number): void {
    const historyFromEvents = this.historyFromEvents(id)
    slot.unsubscribeSnapshot?.()
    slot.historyFromEvents = historyFromEvents
    // Each subscription numbers its own publications from a whole one, so it starts a map of its own.
    const incoming = new ThreadMap({ verify: false })
    slot.incoming = incoming
    const host = this.options.hosts[id]
    const current = (): boolean => slot.wanted && slot.epoch === epoch && slot.incoming === incoming
    if (host.subscribeActivityChanges) {
      const subscription = host.subscribeActivityChanges(changes => {
        if (!current()) return
        const applied = incoming.apply(changes)
        if (applied === 'resync') subscription.resync()
        if (applied !== 'applied') return
        this.acceptIncoming(id, slot, changes)
        this.publish()
      }, { historyFromEvents })
      slot.unsubscribeSnapshot = subscription
      return
    }
    slot.unsubscribeSnapshot = subscribeActivitySnapshots(host, snapshot => {
      if (!current()) return
      const changes: AgentHostChanges = { ...threadChangesBetween(incoming.sequence === undefined ? undefined : incoming, snapshot), sequence: (incoming.sequence ?? 0) + 1 }
      incoming.apply(changes)
      this.acceptIncoming(id, slot, changes)
      this.publish()
    }, { historyFromEvents })
  }
  /**
   * A subscriber came or went, so whether anything here reads a provider's messages may have changed. Each
   * connected provider whose subscription asked otherwise is subscribed again. When messages are wanted
   * again, what those providers last published carries none, so each is read afresh.
   */
  private reconsider(): void {
    let reread = false
    for (const [id, slot] of this.slots) {
      if (!slot.wanted || !slot.unsubscribeSnapshot) continue
      const historyFromEvents = this.historyFromEvents(id)
      if (slot.historyFromEvents === historyFromEvents) continue
      this.watchActivity(id, slot, slot.epoch)
      if (!historyFromEvents) reread = true
    }
    if (reread) void this.snapshot().catch(() => undefined)
  }
  async snapshot(provider?: ProviderId): Promise<AgentHostSnapshot> {
    await Promise.all((provider ? [provider] : providerIdSchema.options).map(async id => {
      const slot = this.slots.get(id)!
      if (!slot.wanted || slot.status.connection !== 'connected') return
      const epoch = slot.epoch
      try { const snapshot = await this.options.hosts[id].snapshot(); if (slot.epoch === epoch) this.accept(id, snapshot) }
      catch (error) { if (slot.epoch === epoch) this.failed(id, error) }
    }))
    this.publish(); return this.handOut()
  }
  private owner(threadId: string): ProviderId {
    const durable = this.options.threadProvider?.(threadId)
    if (durable) {
      const parsed = providerIdSchema.safeParse(durable)
      if (!parsed.success) throw new Error('This thread belongs to a retired provider. Its session cannot be moved to another provider.')
      return parsed.data
    }
    const candidates = [...this.slots].filter(([, slot]) => slot.threads.has(threadId)).map(([id]) => id)
    if (candidates.length !== 1) throw new Error('This thread is not known to Sotto. Refresh and select it again.')
    return candidates[0]!
  }
  private requireConnected(id: ProviderId): void {
    if (this.slots.get(id)!.status.connection !== 'connected') throw new Error(`Reconnect ${PROVIDER_LABELS[id]} before sending. Your draft is saved.`)
  }
  async listThreadSkills(threadId: string, forceReload = false, scope?: AgentSkillScope) {
    const id = this.providerForThread(threadId) ?? scope?.providerId
    if (!id) throw new Error('This thread is not known to Sotto.')
    this.requireConnected(id)
    const host = this.options.hosts[id]; const epoch = this.slots.get(id)!.epoch
    if (!host.listThreadSkills || !this.slots.get(id)!.status.capabilities.skills) throw new Error('This provider does not expose skills.')
    const catalog = await host.listThreadSkills(threadId, forceReload, scope)
    if (epoch !== this.slots.get(id)!.epoch) throw new Error('The thread provider changed while loading skills.')
    return catalog
  }
  /** Every provider sees the whole offer and keeps the threads it owns; no binding is needed here. */
  async restoreThreadHistory(threads: readonly RestoredThreadHistory[]): Promise<void> {
    await Promise.all(providerIdSchema.options.map(id => this.options.hosts[id].restoreThreadHistory?.(threads)))
  }
  async refreshThread(threadId: string, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    const id = this.owner(threadId); this.requireConnected(id)
    const slot = this.slots.get(id)!; const epoch = slot.epoch; const host = this.options.hosts[id]
    // A caller that keeps history from events is handed no messages only when this connection's own subscription
    // asked the same: what the read puts in the slot is what every subscriber is published next (#368).
    const read = purpose?.historyFromEvents && !slot.historyFromEvents ? { ...purpose, historyFromEvents: false } : purpose
    const snapshot = await (host.refreshThread?.(threadId, read) ?? host.snapshot())
    if (slot.epoch !== epoch) throw new Error('This thread provider disconnected while reading the thread.')
    const whole = await this.whole(id, read?.historyFromEvents === true)
    if (slot.epoch !== epoch) throw new Error('This thread provider disconnected while reading the thread.')
    const before = { view: slot.view, threads: read?.beforeSend ? slot.threads.threads() : [], status: slot.status }
    this.accept(id, whole ?? snapshot)
    // A read before a send that changed nothing publishes nothing (#765): every send makes one.
    if (!read?.beforeSend || !sameSnapshot(before.view, slot.view) || !sameSnapshot(before.threads, slot.threads.threads()) || !sameSnapshot(before.status, slot.status)) this.publish()
    return this.handOut()
  }
  rollbackCapability(threadId: string) {
    const provider = this.providerForThread(threadId)
    return provider ? this.options.hosts[provider].rollbackCapability?.(threadId) ?? { supported: false, reason: `${PROVIDER_LABELS[provider]} does not expose verified conversation rewind.` }
      : { supported: false, reason: 'The original provider binding is unavailable.' }
  }
  async rollbackThread(threadId: string, removedUserMessages: number, expectedUserMessageIds: readonly string[]): Promise<AgentHostResult> {
    const provider = this.owner(threadId); this.requireConnected(provider)
    const host = this.options.hosts[provider]
    if (!host.rollbackThread) throw new Error('This provider does not support conversation rewind.')
    return host.rollbackThread(threadId, removedUserMessages, expectedUserMessageIds)
  }
  /**
   * A cleared thread goes to the adapter that owns it whether or not its provider is connected (ADR-0140): the alias is
   * on disk either way. Its slot drops it at once, so the next aggregate does not carry it until the adapter's own does.
   */
  async forgetThread(threadId: string): Promise<void> {
    const provider = this.providerForThread(threadId)
    if (!provider) return
    await this.options.hosts[provider].forgetThread?.(threadId)
    const slot = this.slots.get(provider)!
    if (!slot.threads.has(threadId)) return
    this.mark(provider, threadId); slot.named.delete(threadId)
    slot.threads.apply({ sequence: slot.threads.sequence! + 1, upserts: [], removals: [threadId] })
    // Until the adapter's own publication drops it too, the next one replaces the slot whole rather than bring it back.
    slot.diverged = !this.followsIncoming(slot)
  }
  /**
   * A fork is its source's provider's own copy (#1028), so it goes to the provider that owns the source thread, on one of
   * that provider's models; no other provider is asked in its place.
   */
  async forkThread(request: ThreadForkRequest): Promise<AgentHostResult> {
    const provider = this.owner(request.source.threadId); this.requireConnected(provider)
    const host = this.options.hosts[provider]
    if (!host.forkThread) throw new Error(`${PROVIDER_LABELS[provider]} has no fork of its own, so nothing was made.`)
    const model = resolveModel(this.aggregate(false).models, this.resolveModelId(request.modelId))
    if (!model?.ready || model.providerId !== provider) throw new Error(`Choose a ready ${PROVIDER_LABELS[provider]} model: a fork stays with its source’s provider. Nothing was made.`)
    return host.forkThread({ ...request, modelId: nativeEntityId(provider, 'model', model.id) })
  }
  /**
   * The thread's own provider writes or nothing does (ADR-0026). A client that is not connected is not
   * started for a side call, and no other provider is asked in its place.
   */
  async writeShortText(threadId: string, prompt: ShortTextPrompt, signal?: AbortSignal): Promise<string | null> {
    const id = this.providerForThread(threadId)
    if (!id || this.slots.get(id)!.status.connection !== 'connected') return null
    return await this.options.hosts[id].writeShortText?.(threadId, prompt, signal) ?? null
  }
  providerForThread(threadId: string): ProviderId | undefined {
    try { return this.owner(threadId) } catch { return undefined }
  }
  resolveProjectId(id: string): string { return id }
  resolveModelId(id: string): string { return this.resolveEntityId(id, 'model') }
  private resolveEntityId(id: string, kind: 'project' | 'model'): string {
    if (!id || id.startsWith('native:')) return id
    return providerEntityId(this.options.provider(), kind, id)
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    return this.executeGuarded(command)
  }
  executeFromWatcher(command: AgentHostCommand, guard: () => void): Promise<AgentHostResult> { return this.executeGuarded(command, guard) }
  private async executeGuarded(command: AgentHostCommand, guard?: () => void): Promise<AgentHostResult> {
    const dispatch = (id: ProviderId, value: AgentHostCommand) => {
      guard?.()
      const host = this.options.hosts[id]
      return guard && host.executeFromWatcher ? host.executeFromWatcher(value, guard) : host.execute(value)
    }
    if (command.type === 'create-project') {
      const id = command.provider ?? this.options.provider(); this.requireConnected(id)
      if (!this.slots.get(id)!.status.capabilities.projects) throw new Error('This provider does not support creating projects.')
      const nativeId = id === this.legacyProjectProvider ? command.projectId : nativeEntityId(id, 'project', command.projectId)
      return dispatch(id, { ...command, projectId: nativeId })
    }
    if (command.type === 'create-thread') {
      const model = resolveModel(this.aggregate(false).models, this.resolveModelId(command.modelId))
      if (!model?.providerId || !model.ready) throw new Error('Choose an available model and provider.')
      const id = model.providerId; this.requireConnected(id)
      if (!this.slots.get(id)!.status.capabilities.threads) throw new Error('This provider cannot create threads.')
      const project = this.aggregate(false).projects.find(project => project.id === this.resolveProjectId(command.projectId))
        ?? (command.project?.id === command.projectId ? command.project : undefined)
      if (!project) throw new Error('Choose an available project.')
      const slot = this.slots.get(id)!; const epoch = slot.epoch
      let target = slot.view.projects.find(candidate => folderKey(candidate.path) === folderKey(project.path))
      const projectId = createHash('sha256').update(JSON.stringify([id, folderKey(project.path)])).digest('hex')
      this.registrationLoad ??= (async () => {
        const saved = this.options.directory ? await readFile(join(this.options.directory, 'provider-project-registrations.json'), 'utf8')
          .then(contents => z.array(z.string()).parse(JSON.parse(contents)))
          .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error }) : []
        for (const key of saved) this.registrations.add(key)
      })().catch(error => { this.registrationLoad = undefined; throw error })
      await this.registrationLoad
      const key = JSON.stringify([id, projectId])
      if (!target) {
        if (!slot.status.capabilities.projects) throw new Error('This provider cannot use a new project folder.')
        if (this.registrations.has(key)) {
          const snapshot = await this.options.hosts[id].snapshot()
          if (slot.epoch !== epoch) throw new Error('The provider disconnected while checking this project.')
          this.accept(id, snapshot)
          target = slot.view.projects.find(candidate => candidate.id === projectId || folderKey(candidate.path) === folderKey(project.path))
          if (!target) throw new Error('The provider has not confirmed the earlier project registration. Refresh its connection before retrying; it will not be registered twice.')
        } else {
          this.registrations.add(key)
          try { await this.registrationStore?.write([...this.registrations]) }
          catch (error) { this.registrations.delete(key); throw error }
          let result: AgentHostResult
          try { result = await dispatch(id, { type: 'create-project', commandId: `${command.commandId}:project`, projectId, title: project.title, path: project.path }) }
          catch (error) { this.registrations.delete(key); await this.registrationStore?.write([...this.registrations]); throw error }
          if (!result.accepted && !result.uncertain) {
            this.registrations.delete(key); await this.registrationStore?.write([...this.registrations])
            throw new Error('The provider rejected this project registration.')
          }
          const snapshot = await this.options.hosts[id].snapshot()
          if (slot.epoch !== epoch) throw new Error('The provider disconnected while registering this project.')
          this.accept(id, snapshot)
          target = slot.view.projects.find(candidate => candidate.id === projectId || folderKey(candidate.path) === folderKey(project.path))
          // The thread itself has never been dispatched. Preserve only the registration intent for recovery.
          if (!target) throw new Error('The provider has not confirmed this project registration. Refresh its connection before retrying; your thread has not been created.')
        }
      }
      if (this.registrations.delete(key)) await this.registrationStore?.write([...this.registrations])
      this.requireConnected(id)
      return dispatch(id, { ...command, projectId: target.id, modelId: nativeEntityId(id, 'model', model.id) })
    }
    const id = this.owner(command.threadId); this.requireConnected(id)
    const capabilities = this.slots.get(id)!.status.capabilities
    const needed = command.type === 'send' ? 'submit' : command.type === 'interrupt' ? 'interrupt' : command.type === 'compact-thread' ? 'compact' : command.type === 'configure-thread' ? 'configureThread' : undefined
    if (needed && !capabilities[needed]) throw new Error('This provider does not support that thread action.')
    if ((command.type === 'send' || command.type === 'steer') && command.skills?.length && !capabilities.skills) throw providerTakesNoSkills(id)
    if (command.type !== 'configure-thread') return dispatch(id, command)
    const slot = this.slots.get(id)!; const epoch = slot.epoch
    // As for a thread refresh: no messages only when this connection's subscription asked for none either (#368).
    const settings = command.historyFromEvents && !slot.historyFromEvents ? { ...command, historyFromEvents: false } : command
    const [result, snapshot] = confirmedSettingsSnapshot(await dispatch(id, settings.modelId !== undefined ? { ...settings, modelId: nativeEntityId(id, 'model', settings.modelId) } : settings))
    // The provider's snapshot of a confirmed change becomes the whole view, as a read of the thread would.
    // One from a connection that has since changed is dropped.
    if (!snapshot || slot.epoch !== epoch) return result
    // The change is made, so a failed read here costs only the snapshot: the coordinator reads the thread instead.
    const whole = await this.whole(id, settings.historyFromEvents === true).catch(() => null)
    if (whole === null || slot.epoch !== epoch) return result
    this.accept(id, whole ?? snapshot)
    return { ...result, snapshot: this.handOut() }
  }
  /**
   * A read or settings result that left its messages out, because this connection's subscription asked for none
   * when it went out, is about to become the provider's slot. If a subscriber that reads messages came while it
   * was on the way, the slot must not lose them, so the provider is read whole and that is taken in instead
   * (#368). Undefined when the result can be taken in as it is.
   */
  private async whole(id: ProviderId, withoutMessages: boolean): Promise<AgentHostSnapshot | undefined> {
    if (!withoutMessages || this.slots.get(id)!.historyFromEvents) return undefined
    return this.options.hosts[id].snapshot()
  }
  /** Early start (#769): the thread's own provider, or for a draft the provider its model belongs to, if connected. */
  async startThreadSession(threadId: string, draft?: ThreadSessionDraft): Promise<void> {
    if (!draft) {
      const id = this.providerForThread(threadId)
      if (!id || this.slots.get(id)!.status.connection !== 'connected') return
      return this.options.hosts[id].startThreadSession?.(threadId)
    }
    const model = resolveModel(this.aggregate(false).models, this.resolveModelId(draft.modelId))
    if (!model?.providerId || !model.ready || this.slots.get(model.providerId)!.status.connection !== 'connected') return
    return this.options.hosts[model.providerId].startThreadSession?.(threadId, { ...draft, modelId: nativeEntityId(model.providerId, 'model', model.id) })
  }
  useSettledThreads(ids: readonly string[]): void {
    this.settled = [...ids]
    for (const [id, slot] of this.slots) if (slot.wanted) this.options.hosts[id].useSettledThreads?.(ids)
  }
  observeThreads(ids: readonly string[]): void {
    this.observed = [...ids]
    // SottoThreadHost independently maps only the bindings belonging to its adapter.
    for (const [id, slot] of this.slots) if (slot.wanted) this.options.hosts[id].observeThreads?.(ids)
  }
  disconnect(provider?: ProviderId): void {
    for (const id of provider ? [provider] : providerIdSchema.options) {
      const slot = this.slots.get(id)!; slot.wanted = false; ++slot.epoch; slot.connecting = undefined
      slot.unsubscribeSnapshot?.(); slot.unsubscribeEvents?.(); slot.unsubscribeUsage?.()
      slot.unsubscribeSnapshot = undefined; slot.unsubscribeEvents = undefined; slot.unsubscribeUsage = undefined
      this.options.hosts[id].disconnect(); this.markDisconnected(slot)
      slot.status = { ...slot.status, connection: 'disconnected' }; delete slot.status.error; delete slot.status.problem; delete slot.status.requiredVersion; delete slot.status.account
    }
    this.publish()
  }
  /** Handed to the provider's own host whatever its slot holds: an adapter that is not connected does nothing. */
  async clientUpdated(provider: ProviderId): Promise<void> {
    await this.options.hosts[provider].clientUpdated?.(provider)
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener); this.reconsider()
    return () => { this.listeners.delete(listener); this.reconsider() }
  }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    const off = this.activityListeners.add(listener, options); this.reconsider()
    return () => { off(); this.reconsider() }
  }
  /**
   * The same publications as thread changes (ADR-0016, #925): every provider's threads as the switch names them,
   * provider by provider, from the same publish as the activity snapshots.
   */
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    const subscriber = { historyFromEvents: options?.historyFromEvents === true }
    this.changeSubscribers.add(subscriber)
    const subscription = this.changes.subscribe(listener, options)
    this.reconsider()
    const off = (() => {
      if (!this.changeSubscribers.delete(subscriber)) return
      subscription()
      this.reconsider()
    }) as ActivityChangesSubscription
    off.resync = () => subscription.resync()
    return off
  }
  /** A provider's own messages are left out of what it publishes here only when it publishes events, every activity
   * subscriber keeps history from the events this switch forwards, and none reads the ordinary subscription. */
  private historyFromEvents(id: ProviderId): boolean {
    const activity = this.activityListeners.size + this.changeSubscribers.size > 0
      && (!this.activityListeners.size || this.activityListeners.everyAsked()) && [...this.changeSubscribers].every(subscriber => subscriber.historyFromEvents)
    return this.listeners.size === 0 && activity && typeof this.options.hosts[id].subscribeEvents === 'function'
  }
}
