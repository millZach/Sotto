import { HostUpdateMissed, type HostUpdateMiss } from '../agents/socketHostService'
import type { HostUpdateAnswer, HostUpdateRestartResult } from '../../shared/hostSelfUpdate'
import type { HostVia } from './hostConnectionPlan'
import type { SshHostUpdateOperation, SshHostUpdateResult } from './sshLauncher'

/**
 * How a host update's steps travel (ADR-0088, October 16 amendment), as a small pure table so each row can be tested on its
 * own. `DesktopHosts.runUpdate()` and `restartForUpdate()` follow it: which steps the host's socket carries, what a step the
 * socket did not answer leads to, and what the host's `outcome` says of a restart sent over the socket.
 *
 * The socket carries download, install and restart only for a host on its tailnet connection whose hello lists
 * `host-update`, so an update there signs in nothing and asks Tailscale for no approval. Everything else goes through
 * `press()` as before: over the SSH connection the host is on, or an admin connection.
 */

/** What carries one step: the host's socket, or `press()`. */
export type HostUpdateCarrier = 'socket' | 'press'
/** What a step's carrier is decided by: the step, and the connection the host is on now. */
export interface CarrierFacts {
  readonly op: SshHostUpdateOperation['op']
  /** The connection the host's socket is on, or undefined when it has none. */
  readonly via: HostVia | undefined
  /** The row is connected and its socket is up. */
  readonly connected: boolean
  /** The socket is moving from the SSH connection to the tailnet: the step stays on the SSH connection it began on. */
  readonly moving: boolean
  /** This connection's hello lists `host-update`. */
  readonly offers: boolean
}
/**
 * The socket when the host is on its tailnet connection, connected, not moving, and offers the route. A host on its SSH
 * connection keeps running the launch script over it, which signs in nothing new. Copying an archive this computer
 * downloaded (`update-receive`) is SSH's alone: the socket carries no archive.
 */
export function updateCarrier(facts: CarrierFacts): HostUpdateCarrier {
  if (facts.op === 'update-receive') return 'press'
  return facts.via === 'tailnet' && facts.connected && !facts.moving && facts.offers ? 'socket' : 'press'
}

/** The steps the socket carries. */
export type SocketUpdateAction = 'fetch' | 'install' | 'restart'
/**
 * What a step the socket did not answer leads to: the same step over SSH, a lost connection that ends this try, a reconnect
 * that reads how the restart went, asking the host on the connection still open whether its restart is under way, or
 * nothing at all because the user cancelled.
 */
export type AfterSocketMiss = 'ssh' | 'lost' | 'reconnect' | 'ask' | 'cancelled'
/**
 * - A refusal (`forbidden`, `invalid_request`, `version_mismatch` and `busy`) and a request that never went (`unsent`) ran
 *   nothing on the host, so the step goes over SSH. A host of another version than this computer refuses a request it cannot
 *   read as `version_mismatch` (the client's own reading of `invalid_request`), which is why that is here.
 * - A connection that closed before the answer ended a download with it, so a download goes over SSH. An install finishes on
 *   the host under its update lock whatever happens to the connection, and SSH would only answer `update-busy`, so the try
 *   ends as a lost connection and Try again starts over, reusing what was installed. A restart may have gone ahead, so it is
 *   never sent again: the desktop reconnects and asks the host how it went.
 * - A failure the host answered with ended a download, which goes over SSH. An install may still be running, so it is a
 *   lost connection. A download whose deadline passed closes its connection to end the download, then goes over SSH;
 *   an install whose deadline passed is a lost connection.
 * - A restart the host answered with a failure, or whose deadline passed, may have gone ahead, so it is never sent again:
 *   the desktop asks the host, on the connection still open, whether a restart is under way (`ask`).
 * - Anything after Cancel update is cancelled, and falls back to nothing.
 */
export function afterSocketMiss(action: SocketUpdateAction, miss: HostUpdateMiss, aborted: boolean): AfterSocketMiss {
  if (aborted) return 'cancelled'
  switch (miss) {
    case 'forbidden': case 'invalid_request': case 'version_mismatch': case 'busy': case 'unsent': return 'ssh'
    case 'closed': return action === 'fetch' ? 'ssh' : action === 'install' ? 'lost' : 'reconnect'
    case 'failed': case 'timeout': return action === 'fetch' ? 'ssh' : action === 'install' ? 'lost' : 'ask'
  }
}
/** Why a socket step has no answer, by the error's class; anything unexpected counts as an answer lost. */
export function missOf(error: unknown): HostUpdateMiss {
  return error instanceof HostUpdateMissed ? error.miss : 'closed'
}

/**
 * A download's or an install's answer over the socket, as the same step over SSH answers it, so `HostUpdates` reads both
 * alike. A download's `update-error` keeps its archive name, so a host that cannot reach GitHub is sent the archive this
 * computer downloads, over SSH (`update-receive`). Undefined for `update-cancelled`, which only Cancel update brings.
 */
export function socketStepResult(action: 'fetch' | 'install', answer: HostUpdateAnswer): SshHostUpdateResult | undefined {
  if (answer.type === 'error') return answer
  if (answer.type === 'update-cancelled') return undefined
  if (action === 'fetch' && answer.type === 'update-fetched') return answer
  if (action === 'install' && answer.type === 'update-installed') return answer
  return { type: 'error', reason: 'update-failed' }
}

/** Whether `outcome` is the restart the host had already recorded in `before`, by its attempt ID or, without one, whole. */
function recordedBefore(outcome: HostUpdateAnswer, before: HostUpdateAnswer | undefined): boolean {
  if (outcome.type !== 'update-outcome' || before?.type !== 'update-outcome' || before.restart.state === 'none') return false
  if (before.restart.attempt && 'attempt' in outcome.restart && outcome.restart.attempt) return before.restart.attempt === outcome.restart.attempt
  return JSON.stringify(before.restart) === JSON.stringify(outcome.restart)
}
/**
 * Whether what the host says after a restart over its socket is the last word on it: a finished restart other than the one
 * it recorded before (`before`), or an answer that is no outcome at all. A host that says restarting, that has no restart
 * recorded, or that still shows the earlier one may be the old host before this restart reached it, so it is asked again.
 */
export function restartSettled(outcome: HostUpdateAnswer, before?: HostUpdateAnswer): boolean {
  if (outcome.type !== 'update-outcome') return true
  return outcome.restart.state === 'finished' && !recordedBefore(outcome, before)
}
/**
 * How a restart sent over the socket ended, from what the host says once this computer has connected to it again: the new
 * host started, or the launch script's own failure, such as the old version started again. Undefined when the answer cannot
 * say: no restart recorded, one still restarting at the deadline, one interrupted (`update-lost`), one for another version,
 * one the host already recorded before this restart was sent (`before`, as from an earlier Try again), or no answer at
 * all. `HostUpdates` then decides by the version the host says it runs, as after a lost SSH restart.
 */
export function restartFromOutcome(outcome: HostUpdateAnswer | undefined, to: string, before?: HostUpdateAnswer): HostUpdateRestartResult | undefined {
  if (outcome?.type !== 'update-outcome' || outcome.restart.state !== 'finished' || outcome.restart.version !== to) return undefined
  if (recordedBefore(outcome, before)) return undefined
  const { result } = outcome.restart
  if (result.type === 'ready') return outcome.running === to ? result : undefined
  return result.reason === 'update-lost' ? undefined : result
}
