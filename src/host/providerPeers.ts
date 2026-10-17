import { parsePublicProviderEntityId, threadProviderOf, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread, type AgentThreadDetail, type AgentThreadDetailDelta, type ProviderId } from '../shared/agents'
import type { HeldProviders } from '../shared/heldProviders'
import type { StoredThreadEvent } from '../shared/threadEvents'
import { catalogWithoutHeld, heldProviderOfProject } from '../main/agents/heldProviderGate'

/**
 * What a host sends a client that does not know some of its providers (#1107, ADR-0087): a client whose hello did not
 * accept a provider's host feature (`PROVIDER_HOST_FEATURES`) reads provider IDs against a list without it and refuses a
 * whole shell that names one. So that client is sent no row, model, project, thread, draft, client update, setting, skill
 * catalog, link, handover or Watcher row of those providers, and every thread of theirs is hidden from it as a phone's
 * Watcher threads are: not read, observed, paged or commanded. Nothing on the host changes; another client is sent
 * everything.
 */

const unknownModelId = (id: string | undefined, unknown: HeldProviders): boolean => {
  const provider = id ? parsePublicProviderEntityId(id)?.provider : undefined
  return provider !== undefined && unknown.has(provider)
}
const unknownProvider = (id: unknown, unknown: HeldProviders): boolean => typeof id === 'string' && unknown.has(id as ProviderId)
const unknownThread = (thread: Pick<AgentThread, 'providerId' | 'modelId'>, unknown: HeldProviders): boolean => {
  const provider = threadProviderOf(thread)
  return provider !== undefined && unknown.has(provider)
}
/** A message without a handover from a thread of an unknown provider: its own words stay, the record of where they came from goes. */
function messageWithoutProviders<M extends Pick<AgentMessage, 'handover'>>(message: M, unknown: HeldProviders): M {
  if (!message.handover || !unknown.has(message.handover.provider)) return message
  const { handover, ...rest } = message
  void handover
  return rest as M
}
const handoverNamesAny = (messages: readonly Pick<AgentMessage, 'handover'>[], unknown: HeldProviders): boolean =>
  messages.some(message => message.handover !== undefined && unknown.has(message.handover.provider))

/** A thread the client may read, without its links to threads it may not and its messages' handovers from them. */
function threadWithoutProviders(thread: AgentThread, unknown: HeldProviders, hidden: ReadonlySet<string>): AgentThread {
  const linked = (link: { threadId: string; provider?: ProviderId }): boolean => hidden.has(link.threadId) || (link.provider !== undefined && unknown.has(link.provider))
  const from = thread.continuedFrom !== undefined && linked(thread.continuedFrom)
  const continued = thread.continuedIn?.some(linked) ?? false
  const delegated = thread.delegatedBy !== undefined && hidden.has(thread.delegatedBy)
  const started = thread.startedFrom !== undefined && hidden.has(thread.startedFrom.threadId)
  const handovers = handoverNamesAny(thread.messages, unknown)
  if (!from && !continued && !delegated && !started && !handovers) return thread
  const { continuedFrom, delegatedBy, startedFrom, ...rest } = thread
  return { ...rest,
    ...(continuedFrom && !from ? { continuedFrom } : {}),
    ...(continued ? { continuedIn: thread.continuedIn!.filter(link => !linked(link)) } : {}),
    ...(delegatedBy && !delegated ? { delegatedBy } : {}),
    ...(startedFrom && !started ? { startedFrom } : {}),
    ...(handovers ? { messages: thread.messages.map(message => messageWithoutProviders(message, unknown)) } : {}) }
}

/** A catalog without the unknown providers' rows, models and projects, and a client host's settings without them. */
function hostWithout(host: AgentHostSnapshot, unknown: HeldProviders, threads: AgentThread[]): AgentHostSnapshot {
  const clientHosts = host.clientHosts?.map(client => {
    const { models, providers } = catalogWithoutHeld({ ...host, models: client.models, projects: [], providers: client.providers }, unknown)
    const { agentModelId, ...rest } = client
    return { ...rest, models, ...(providers ? { providers } : {}),
      ...(agentModelId !== undefined && !unknownModelId(agentModelId, unknown) ? { agentModelId } : {}),
      ...(client.clientUpdates ? { clientUpdates: client.clientUpdates.filter(update => !unknown.has(update.id)) } : {}),
      ...(client.clientUpdateRun?.line ? { clientUpdateRun: { ...client.clientUpdateRun, line: client.clientUpdateRun.line.filter(id => !unknown.has(id)) } } : {}),
      ...(client.enabledProviders ? { enabledProviders: client.enabledProviders.filter(id => !unknown.has(id)) } : {}) }
  })
  return { ...host, ...catalogWithoutHeld(host, unknown), threads, ...(clientHosts ? { clientHosts } : {}) }
}

/**
 * A shell without every trace of the providers `unknown` names, for a client that does not know them. The same state when
 * it names none, so a host with no thread, model or row of theirs sends what it always did.
 */
export function stateWithoutProviders<T extends AgentState>(state: T, unknown: HeldProviders): T {
  if (!unknown.size || !namesAny(state, unknown)) return state
  const hidden = new Set(state.host.threads.filter(thread => unknownThread(thread, unknown)).map(thread => thread.id))
  const hiddenProjects = new Set(state.host.projects.filter(project => heldProviderOfProject(project, unknown) !== undefined).map(project => project.id))
  const threads = state.host.threads.filter(thread => !hidden.has(thread.id)).map(thread => threadWithoutProviders(thread, unknown, hidden))
  const configuration = state.configuration
  const enabledProviders = configuration.enabledProviders?.filter(id => !unknown.has(id))
  const provider = unknown.has(configuration.provider) ? enabledProviders?.[0] ?? 'codex' : configuration.provider
  /** Every list the shell keeps by thread, without the hidden threads' entries. */
  const kept = <I extends { threadId: string }>(items: I[] | undefined): I[] | undefined => items && hidden.size ? items.filter(item => !hidden.has(item.threadId)) : items
  const { skillCatalogs, threadDrafts, threadDraftPersistence, deliveries, followups, followupReceipts, deliveredDrafts, obsoleteDrafts, unconfirmedSettings } = state
  return {
    ...state,
    host: hostWithout(state.host, unknown, threads),
    configuration: { ...configuration, provider,
      ...(enabledProviders ? { enabledProviders } : {}),
      ...(configuration.disconnectedProviders ? { disconnectedProviders: configuration.disconnectedProviders.filter(id => !unknown.has(id)) } : {}),
      ...(unknownModelId(configuration.defaultModelId, unknown) ? { defaultModelId: '' } : {}),
      ...(unknownModelId(configuration.newThreadModelId, unknown) ? { newThreadModelId: '' } : {}) },
    ...(state.installedProviders ? { installedProviders: state.installedProviders.filter(id => !unknown.has(id)) } : {}),
    ...(state.clientUpdates ? { clientUpdates: state.clientUpdates.filter(update => !unknown.has(update.id)) } : {}),
    ...(state.clientUpdateRun?.line ? { clientUpdateRun: { ...state.clientUpdateRun, line: state.clientUpdateRun.line.filter(id => !unknown.has(id)) } } : {}),
    // A skill catalog names its thread's provider, an error catalog too (`refresh-thread-skills`).
    ...(skillCatalogs ? { skillCatalogs: skillCatalogs.filter(catalog => !unknown.has(catalog.providerId) && !hidden.has(catalog.threadId)) } : {}),
    ...(threadDrafts ? { threadDrafts: kept(threadDrafts) } : {}),
    ...(threadDraftPersistence ? { threadDraftPersistence: kept(threadDraftPersistence) } : {}),
    ...(deliveries ? { deliveries: kept(deliveries) } : {}),
    ...(followups ? { followups: kept(followups) } : {}),
    ...(followupReceipts ? { followupReceipts: kept(followupReceipts) } : {}),
    ...(deliveredDrafts ? { deliveredDrafts: kept(deliveredDrafts) } : {}),
    ...(obsoleteDrafts ? { obsoleteDrafts: kept(obsoleteDrafts) } : {}),
    ...(unconfirmedSettings ? { unconfirmedSettings: kept(unconfirmedSettings)!.filter(item => !unknownModelId(item.modelId, unknown)) } : {}),
    ...(state.busyThreadIds && hidden.size ? { busyThreadIds: state.busyThreadIds.filter(id => !hidden.has(id)) } : {}),
    ...(state.activeThreadId && hidden.has(state.activeThreadId) ? { activeThreadId: null } : {}),
    ...(state.draftThreadId && hidden.has(state.draftThreadId) ? { draftThreadId: null } : {}),
    ...(state.activeProjectId && (hiddenProjects.has(state.activeProjectId) || unknownModelId(state.activeProjectId, unknown)) ? { activeProjectId: null } : {}),
  }
}

/**
 * Whether a shell names any of the providers at all, read without copying anything. A part a shell leaves out, as a stand-in
 * service's may, names none. A list the shell keeps by thread names one only through a thread of theirs, which the threads
 * themselves answer for.
 */
function namesAny(state: AgentState, unknown: HeldProviders): boolean {
  const host: Partial<AgentHostSnapshot> = state.host ?? {}
  const configuration: Partial<AgentState['configuration']> = state.configuration ?? {}
  return (host.threads ?? []).some(thread => unknownThread(thread, unknown)
    || (thread.continuedFrom !== undefined && unknown.has(thread.continuedFrom.provider))
    || (thread.continuedIn?.some(link => unknown.has(link.provider)) ?? false)
    || handoverNamesAny(thread.messages ?? [], unknown))
    || (host.models ?? []).some(model => (model.providerId !== undefined && unknown.has(model.providerId)) || unknownModelId(model.id, unknown))
    || (host.projects ?? []).some(project => (project.providerId !== undefined && unknown.has(project.providerId)) || unknownModelId(project.id, unknown))
    || (host.providers?.some(row => unknown.has(row.id)) ?? false)
    || (host.clientHosts?.some(client => client.models.some(model => model.providerId !== undefined && unknown.has(model.providerId))
      || (client.providers?.some(row => unknown.has(row.id)) ?? false) || (client.clientUpdates?.some(update => unknown.has(update.id)) ?? false)
      || (client.enabledProviders?.some(id => unknown.has(id)) ?? false) || (client.clientUpdateRun?.line?.some(id => unknown.has(id)) ?? false)
      || unknownModelId(client.agentModelId, unknown)) ?? false)
    || (configuration.provider !== undefined && unknown.has(configuration.provider))
    || (configuration.enabledProviders?.some(id => unknown.has(id)) ?? false)
    || (configuration.disconnectedProviders?.some(id => unknown.has(id)) ?? false)
    || unknownModelId(configuration.defaultModelId, unknown) || unknownModelId(configuration.newThreadModelId, unknown)
    || (state.installedProviders?.some(id => unknown.has(id)) ?? false)
    || (state.clientUpdates?.some(update => unknown.has(update.id)) ?? false)
    || (state.clientUpdateRun?.line?.some(id => unknown.has(id)) ?? false)
    || (state.skillCatalogs?.some(catalog => unknown.has(catalog.providerId)) ?? false)
    || (state.unconfirmedSettings?.some(item => unknownModelId(item.modelId, unknown)) ?? false)
}

/**
 * A detail of a thread the client may read, without a handover from an unknown provider's thread: the message keeps its
 * own words and loses the record of where its handover came from, which that client could not read.
 */
export function detailWithoutProviders(detail: AgentThreadDetail, unknown: HeldProviders): AgentThreadDetail {
  if (!unknown.size || !handoverNamesAny(detail.messages, unknown)) return detail
  return { ...detail, messages: detail.messages.map(message => messageWithoutProviders(message, unknown)) }
}
/** The same for a delta: a whole message it carries loses a handover from an unknown provider's thread. */
export function deltaWithoutProviders(delta: AgentThreadDetailDelta, unknown: HeldProviders): AgentThreadDetailDelta {
  if (!unknown.size || !delta.messageDeltas.some(item => 'message' in item && item.message.handover && unknown.has(item.message.handover.provider))) return delta
  return { ...delta, messageDeltas: delta.messageDeltas.map(item => 'message' in item ? { ...item, message: messageWithoutProviders(item.message, unknown) } : item) }
}
/** The same for an event page of threads the client may read: a message an event carries loses that handover. */
export function eventsWithoutProviders<E extends StoredThreadEvent>(events: E[], unknown: HeldProviders): E[] {
  const names = (row: StoredThreadEvent): boolean => 'message' in row.event && row.event.message.handover !== undefined && unknown.has(row.event.message.handover.provider)
  if (!unknown.size || !events.some(names)) return events
  return events.map(row => names(row) && 'message' in row.event ? { ...row, event: { ...row.event, message: messageWithoutProviders(row.event.message, unknown) } } : row)
}

/**
 * How a host tells, for one client, what that client may not be sent: the providers it does not know, and whether a thread
 * or project is one of theirs as the host holds it now. A thread or project the host does not hold is named by its ID alone.
 */
export interface ProviderScope {
  readonly providers: HeldProviders
  thread?(threadId: string): boolean
  project?(projectId: string): boolean
}
/** Whether a thread target, a project target or a model ID names one of the providers a client does not know. */
export function scopeHidesThread(scope: ProviderScope, threadId: unknown): boolean {
  return typeof threadId === 'string' && scope.thread?.(threadId) === true
}
export function scopeHidesProject(scope: ProviderScope, projectId: unknown): boolean {
  return typeof projectId === 'string' && (scope.project?.(projectId) === true || unknownModelId(projectId, scope.providers))
}
export function scopeHidesModel(scope: ProviderScope, modelId: unknown): boolean {
  return typeof modelId === 'string' && unknownModelId(modelId, scope.providers)
}
/** The places a Watcher record names a thread or a project: its own fields and the targets it carries. */
const TARGET_KEYS = ['target', 'openTarget', 'source', 'project', 'receipt', 'reference'] as const
/**
 * Whether one object of a Watcher answer names a provider the client does not know: by its provider or model, or by the
 * thread or project it is for, its own or a target's. Only its own fields are read; what it holds is the walk's.
 */
export function namesHidden(value: Record<string, unknown>, scope: ProviderScope): boolean {
  if (unknownProvider(value.provider, scope.providers) || unknownProvider(value.providerId, scope.providers) || scopeHidesModel(scope, value.modelId)
    || scopeHidesThread(scope, value.threadId) || scopeHidesProject(scope, value.projectId)) return true
  return TARGET_KEYS.some(key => {
    const target = value[key]
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return false
    const fields = target as Record<string, unknown>
    return scopeHidesThread(scope, fields.threadId) || scopeHidesProject(scope, fields.projectId)
      || (key === 'receipt' || key === 'reference') && namesHidden(fields, scope)
  })
}
/**
 * A Watcher answer, a Watcher projection or a phone's Watcher state without a row that names a provider the client does not
 * know: any object in a list that names one (`namesHidden`) is left out, as a thread, worker, project, card or receipt of
 * that provider would be on a shell. Everything else keeps its shape.
 */
export function readWithoutProviders<T>(value: T, scope: ProviderScope): T {
  if (!scope.providers.size || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.filter(item => !(item !== null && typeof item === 'object' && !Array.isArray(item) && namesHidden(item as Record<string, unknown>, scope)))
      .map(item => readWithoutProviders(item, scope)) as T
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readWithoutProviders(item, scope)])) as T
}
