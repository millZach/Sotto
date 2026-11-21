import type { AgentConfiguration, AgentState } from '../../shared/agents'
import { REMOTE_PERMISSION_DENIED } from './authority'
import type { AgentHost } from './host'
import type { ClientIdentity } from './hostService'

/**
 * What the coordinator does when Antigravity's sign-in changes (ADR-0212). `agy` reads its sign-in once, when it starts,
 * so a connected one is started again on a new sign-in, and only this machine's own Settings name the `agy` it runs.
 */

/** What `agy` signs in with, each read when it starts. */
const SIGN_IN_FIELDS = ['antigravitySignInMethod', 'antigravityProject', 'antigravityLocation', 'antigravityBinaryPath'] as const

/** Whether a configuration change touches what a running `agy` signed in with. */
export const antigravitySignInChanged = (before: AgentConfiguration, next: AgentConfiguration): boolean =>
  SIGN_IN_FIELDS.some(field => next[field] !== before[field])

/** Antigravity's binary path names a program this machine starts, so a paired client may not change it. */
export function guardAntigravityPath(patch: { antigravityBinaryPath?: string | undefined }, current: AgentConfiguration, client: ClientIdentity): void {
  if (patch.antigravityBinaryPath !== undefined && patch.antigravityBinaryPath !== current.antigravityBinaryPath && client.transport === 'socket') throw new Error(REMOTE_PERMISSION_DENIED)
}

/** A connected Antigravity starts again on a new sign-in: a running `agy` keeps the one it started with. */
export function restartAntigravity(state: AgentState, host: Pick<AgentHost, 'disconnect'>, connect: () => Promise<unknown>): void {
  if (state.host.providers?.find(status => status.id === 'antigravity')?.connection !== 'connected') return
  host.disconnect('antigravity')
  void connect().catch(() => undefined)
}
