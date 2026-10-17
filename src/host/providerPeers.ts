import { parsePublicProviderEntityId, threadProviderOf, type AgentHostSnapshot, type AgentState, type AgentThread, type AgentThreadDetail, type AgentThreadDetailDelta, type ProviderId } from '../shared/agents'
import type { HeldProviders } from '../shared/heldProviders'
import { catalogWithoutHeld } from '../main/agents/heldProviderGate'

/**
 * What a host sends a client that does not know some of its providers (#1107, ADR-0087): a client whose hello did not
 * accept a provider's host feature (`PROVIDER_HOST_FEATURES`) reads provider IDs against a list without it and refuses a
 * whole shell that names one. So that client is sent no row, model, project, thread, draft, client update or setting of
 * those providers, and every thread of theirs is hidden from it as a phone's Watcher threads are: not read, observed,
 * paged or commanded. Nothing on the host changes; another client is sent everything.
 */

const unknownModelId = (id: string, unknown: HeldProviders): boolean => {
  const provider = parsePublicProviderEntityId(id)?.provider
  return provider !== undefined && unknown.has(provider)
}

/** A catalog without the unknown providers' rows, models and projects, and a client host's settings without them. */
function hostWithout(host: AgentHostSnapshot, unknown: HeldProviders, threads: AgentThread[]): AgentHostSnapshot {
  const clientHosts = host.clientHosts?.map(client => {
    const { models, providers } = catalogWithoutHeld({ ...host, models: client.models, projects: [], providers: client.providers }, unknown)
    return { ...client, models, ...(providers ? { providers } : {}),
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
  const hidden = new Set<string>()
  const threads = state.host.threads.filter(thread => {
    const provider = threadProviderOf(thread)
    if (provider === undefined || !unknown.has(provider)) return true
    hidden.add(thread.id)
    return false
  })
  const configuration = state.configuration
  const enabledProviders = configuration.enabledProviders?.filter(id => !unknown.has(id))
  const provider = unknown.has(configuration.provider) ? enabledProviders?.[0] ?? 'codex' : configuration.provider
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
    ...(state.threadDrafts && hidden.size ? { threadDrafts: state.threadDrafts.filter(draft => !hidden.has(draft.threadId)) } : {}),
    ...(state.activeThreadId && hidden.has(state.activeThreadId) ? { activeThreadId: null } : {}),
    ...(state.draftThreadId && hidden.has(state.draftThreadId) ? { draftThreadId: null } : {}),
  }
}

/** Whether a shell names any of the providers at all, read without copying anything. */
function namesAny(state: AgentState, unknown: HeldProviders): boolean {
  const { host, configuration } = state
  return host.threads.some(thread => { const provider = threadProviderOf(thread); return provider !== undefined && unknown.has(provider) })
    || host.models.some(model => (model.providerId !== undefined && unknown.has(model.providerId)) || unknownModelId(model.id, unknown))
    || host.projects.some(project => (project.providerId !== undefined && unknown.has(project.providerId)) || unknownModelId(project.id, unknown))
    || (host.providers?.some(row => unknown.has(row.id)) ?? false)
    || (host.clientHosts?.some(client => client.models.some(model => model.providerId !== undefined && unknown.has(model.providerId))
      || (client.providers?.some(row => unknown.has(row.id)) ?? false) || (client.clientUpdates?.some(update => unknown.has(update.id)) ?? false)
      || (client.enabledProviders?.some(id => unknown.has(id)) ?? false) || (client.clientUpdateRun?.line?.some(id => unknown.has(id)) ?? false)) ?? false)
    || unknown.has(configuration.provider)
    || (configuration.enabledProviders?.some(id => unknown.has(id)) ?? false)
    || (configuration.disconnectedProviders?.some(id => unknown.has(id)) ?? false)
    || unknownModelId(configuration.defaultModelId, unknown) || unknownModelId(configuration.newThreadModelId, unknown)
    || (state.installedProviders?.some(id => unknown.has(id)) ?? false)
    || (state.clientUpdates?.some(update => unknown.has(update.id)) ?? false)
    || (state.clientUpdateRun?.line?.some(id => unknown.has(id)) ?? false)
}

/**
 * A detail of a thread the client may read, without a handover from an unknown provider's thread: the message keeps its
 * own words and loses the record of where its handover came from, which that client could not read.
 */
export function detailWithoutProviders(detail: AgentThreadDetail, unknown: HeldProviders): AgentThreadDetail {
  if (!unknown.size || !detail.messages.some(message => message.handover && unknown.has(message.handover.provider))) return detail
  return { ...detail, messages: detail.messages.map(message => {
    if (!message.handover || !unknown.has(message.handover.provider)) return message
    const { handover, ...rest } = message
    void handover
    return rest
  }) }
}
/** The same for a delta: a whole message it carries loses a handover from an unknown provider's thread. */
export function deltaWithoutProviders(delta: AgentThreadDetailDelta, unknown: HeldProviders): AgentThreadDetailDelta {
  if (!unknown.size || !delta.messageDeltas.some(item => 'message' in item && item.message.handover && unknown.has(item.message.handover.provider))) return delta
  return { ...delta, messageDeltas: delta.messageDeltas.map(item => {
    if (!('message' in item) || !item.message.handover || !unknown.has(item.message.handover.provider)) return item
    const { handover, ...message } = item.message
    void handover
    return { ...item, message }
  }) }
}

/**
 * A Watcher read's answer without rows that name an unknown provider: any object in a list whose `provider` or
 * `providerId` is one is left out, as a thread or worker of that provider would be on a shell.
 */
export function readWithoutProviders(value: unknown, unknown: HeldProviders): unknown {
  if (!unknown.size || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const kept = value.filter(item => !(item !== null && typeof item === 'object' && !Array.isArray(item)
      && [(item as Record<string, unknown>).provider, (item as Record<string, unknown>).providerId].some(id => typeof id === 'string' && unknown.has(id as ProviderId))))
    return kept.map(item => readWithoutProviders(item, unknown))
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readWithoutProviders(item, unknown)]))
}
