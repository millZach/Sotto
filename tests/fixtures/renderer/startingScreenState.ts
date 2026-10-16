import { EMPTY_AGENT_HOST, PROVIDER_LABELS, type AgentProviderStatus, type AgentState, type ProviderId } from '../../../src/shared/agents'
import { threadsStateFixture } from '../agentState'

/** This computer's host in the window's agent state. */
export const LOCAL_HOST_ID = '11111111-1111-4111-8111-111111111111'
/** The saved host forge, as a client host in the agent state and as a saved host in the hosts state. */
export const FORGE_HOST_ID = '22222222-2222-4222-8222-222222222222'

/** One provider as a client host lists it. */
export function providerStatus(id: ProviderId, connection: AgentProviderStatus['connection'], patch: Partial<AgentProviderStatus> = {}): AgentProviderStatus {
  return { id, connection, name: PROVIDER_LABELS[id], version: '', capabilities: EMPTY_AGENT_HOST.capabilities, ...patch }
}

/** This computer's providers by where each stands, in the order given. */
export function providerStatuses(providers: Partial<Record<ProviderId, AgentProviderStatus['connection']>>): AgentProviderStatus[] {
  return Object.entries(providers).map(([id, connection]) => providerStatus(id as ProviderId, connection))
}

/**
 * The window's agent state as the desktop router publishes it at launch: this computer's providers on its own client host
 * entry, and with `remote`, forge connected with providers of its own.
 */
export function startingAgentState(local: readonly AgentProviderStatus[], remote?: readonly AgentProviderStatus[]): AgentState {
  return threadsStateFixture({
    topLevel: { clientScoped: true, connections: [
      { hostId: LOCAL_HOST_ID, name: 'This computer', kind: 'local', connected: true },
      ...(remote ? [{ hostId: FORGE_HOST_ID, name: 'forge', kind: 'remote' as const, connected: true }] : []),
    ] },
    host: { clientHosts: [
      { hostId: LOCAL_HOST_ID, connected: true, models: [], capabilities: EMPTY_AGENT_HOST.capabilities, providers: [...local] },
      ...(remote ? [{ hostId: FORGE_HOST_ID, connected: true, models: [], capabilities: EMPTY_AGENT_HOST.capabilities, providers: [...remote] }] : []),
    ] },
  })
}
