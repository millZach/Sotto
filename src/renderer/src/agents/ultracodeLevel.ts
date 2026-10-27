import type { AgentModel, AgentState, AgentThread } from '../../../shared/agents'
import { DEFAULT_ULTRACODE_EFFORT, ULTRACODE, ultracodeRunsAt } from '../../../shared/ultracode'
import { localHostId } from '../features/onboarding/localAgents'

/**
 * The level a thread on this model would run Ultracode at (ADR-0148), for the effort card to name: this computer's
 * setting, fitted to what the model offers. Undefined where the model has no Ultracode, and for a thread on another
 * host, whose own setting this window does not read, so the card names no level rather than the wrong one.
 */
export function ultracodeLevel(state: AgentState, thread: Pick<AgentThread, 'hostId'>, model: AgentModel | undefined): string | undefined {
  const levels = model?.reasoningEfforts ?? []
  if (!levels.includes(ULTRACODE)) return undefined
  const joined = Boolean(state.connections?.length)
  const local = localHostId(state)
  if (joined && thread.hostId && thread.hostId !== local) return undefined
  const chosen = joined ? state.host.clientHosts?.find(host => host.hostId === local)?.claudeUltracodeEffort : state.configuration.claudeUltracodeEffort
  return ultracodeRunsAt(levels, chosen ?? DEFAULT_ULTRACODE_EFFORT)
}
