import { PROVIDER_LABELS, providerIdSchema, type AgentProject, type AgentProviderStatus, type AgentState, type ProviderId } from '../../../../shared/agents'
import { projectOnHost } from '../../agents/projectFolders'

/** The providers in the order setup lists them. */
export const SETUP_PROVIDERS: readonly ProviderId[] = providerIdSchema.options

/** Main's state as it is now; a cached shell from the last run says nothing about this one. */
export function liveAgentState(state: AgentState | null | undefined): AgentState | null {
  return state && !state.stale ? state : null
}

/** This computer's own host. Before any other host is paired, the state is the local host's alone. */
export function localHostId(state: AgentState): string | undefined {
  return state.connections ? state.connections.find(host => host.kind === 'local')?.hostId : state.hostId
}

/** This computer's providers, whichever host is selected for new work. */
export function localProviders(state: AgentState): readonly AgentProviderStatus[] {
  const local = localHostId(state)
  const client = state.host.clientHosts?.find(host => host.hostId === local)
  return client?.providers ?? (state.connections?.length ? [] : state.host.providers ?? [])
}

/** This computer's projects. */
export function localProjects(state: AgentState): readonly AgentProject[] {
  const local = localHostId(state)
  return local === undefined ? state.host.projects : state.host.projects.filter(project => projectOnHost(project, local))
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider]
}
