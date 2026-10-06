import { HostConnectionError, WrongHostError } from '../agents/socketHostService'
import type { HostConnectionName, HostStartedBy } from '../../shared/hostConnection'

/**
 * The order of a connect to a saved host (ADR-0053, "The order of a connect"), as a small pure table so each row can be
 * tested on its own. `DesktopHosts.open()` follows it: which connection a connect tries first, what a failed tailnet
 * connection leads to, and when a host on its SSH connection tries the tailnet again: at once or at the 5-minute check.
 *
 * A **tailnet connection** opens the host service at the host's tailnet address, authenticated by this computer's
 * pairing, and spawns no `ssh`. The **SSH connection** is today's launch, pairing and port forward. SSH stays the
 * fallback, and the only way a desktop pairs.
 */

/** Which connection the owner prefers for a saved host. A host with no entry in the tailnet store prefers SSH. */
export type HostConnectionPreference = HostConnectionName
/** Which connection carries a host's socket. */
export type HostVia = HostConnectionName

/**
 * Why a tailnet connection failed, beside the SSH failure codes. Each goes to SSH: unreachable (DNS, connect, TLS, a
 * timeout, or Serve's 502 or 503), a host whose ID is not the saved one, a session refused because the host does not know
 * this client as a desktop (403), and a refused pairing (401), which SSH pairs again over its forward. A version mismatch
 * goes to SSH too, whose launch gives the same final answer and keeps the SSH session Stop host and Update need.
 */
export type TailnetFailure = 'tailnet-unreachable' | 'tailnet-wrong-host' | 'tailnet-not-desktop' | 'pairing-required' | 'version-mismatch'

/** How long a host on its SSH connection waits before it tries the tailnet again, while the owner prefers the tailnet. */
export const TAILNET_RETURN_MS = 5 * 60_000
/** How long a tailnet connection's health check may take before the tailnet counts as not answering. */
export const TAILNET_HEALTH_MS = 5_000
/** How long the retries of a host that starts at boot try the tailnet alone after a drop from it. */
export const BOOT_TAILNET_ONLY_MS = 60_000

/** What a connect knows about a saved host before it starts. */
export interface ConnectFacts {
  readonly prefer: HostConnectionPreference
  /** The host's last reported tailnet address, already checked by `isTailnetAddress`. */
  readonly address?: string | undefined
  /** This computer holds the host's pairing and knows its ID: a tailnet connection never pairs. */
  readonly paired: boolean
  /** Add host's or the setup's connect: it always goes over SSH, the only place a desktop pairs. */
  readonly adding: boolean
  /**
   * The first connect after Edit connection was saved: it goes over SSH, so the saved route is tried, and a route that
   * now reaches another machine ends in the host identity error rather than going unnoticed behind the tailnet.
   */
  readonly edited?: boolean | undefined
  /** Who started the host, as it last said. `boot` is a host its start at boot unit started (ADR-0054). */
  readonly startedBy?: HostStartedBy | undefined
  /** The connection the host was last on. */
  readonly lastVia?: HostVia | undefined
  /** How long this run of retries has gone on, from the drop that began it; absent when this is not a retry. */
  readonly retryingForMs?: number | undefined
}

/**
 * The connections a connect tries, in order. The tailnet comes first when the owner prefers it, an address is known and
 * this computer is paired; SSH follows it, except in the first minute of retries for a host that starts at boot whose
 * last connection was a tailnet connection, since that host restarts by itself and an SSH attempt would ask for an
 * approval for nothing.
 */
export function connectOrder(facts: ConnectFacts): readonly HostVia[] {
  if (facts.adding || facts.edited || facts.prefer !== 'tailnet' || !facts.address || !facts.paired) return ['ssh']
  const bootRetry = facts.startedBy === 'boot' && facts.lastVia === 'tailnet' && facts.retryingForMs !== undefined && facts.retryingForMs < BOOT_TAILNET_ONLY_MS
  return bootRetry ? ['tailnet'] : ['tailnet', 'ssh']
}

/**
 * What a failed tailnet connection leads to (ADR-0053, step 2 and the October 6 amendment). In the tailnet-only first
 * minute of a host that starts at boot, a tailnet that did not answer is tried again on the backoff, with no SSH, since
 * the host is coming back by itself; every other failure goes to SSH, which mends it. `note` is what the row says while
 * the host is on SSH: only a tailnet that did not answer, or answered as another host, is something SSH cannot mend, so
 * only those wait for the 5-minute check rather than being tried again as soon as the SSH connection is up.
 */
export type AfterTailnetFailure = { readonly next: 'retry-tailnet' } | { readonly next: 'ssh'; readonly note?: 'unreachable' }
export function afterTailnetFailure(failure: TailnetFailure, order: readonly HostVia[]): AfterTailnetFailure {
  if (!order.includes('ssh') && failure === 'tailnet-unreachable') return { next: 'retry-tailnet' }
  return failure === 'tailnet-unreachable' || failure === 'tailnet-wrong-host' ? { next: 'ssh', note: 'unreachable' } : { next: 'ssh' }
}

/**
 * Whether a host on its SSH connection tries to move its socket to the tailnet now. It does when the owner prefers the
 * tailnet, an address is known and this computer is paired, unless that very address just failed this connect, which
 * waits for the 5-minute check. A new address, from the launch, hello or a setting's answer, is tried at once.
 */
export function tryTailnetAfterSsh(facts: Pick<ConnectFacts, 'prefer' | 'address' | 'paired'> & { readonly failed?: string | undefined }): boolean {
  return facts.prefer === 'tailnet' && facts.address !== undefined && facts.paired && facts.address !== facts.failed
}

/** The class of a failed tailnet connection, by its code and never its message. */
export function classifyTailnetFailure(error: unknown): TailnetFailure {
  if (error instanceof WrongHostError) return 'tailnet-wrong-host'
  if (error instanceof HostConnectionError) {
    if (error.code === 'version_mismatch') return 'version-mismatch'
    if (error.pairingRequired) return 'pairing-required'
    if (error.code === 'forbidden') return 'tailnet-not-desktop'
  }
  return 'tailnet-unreachable'
}
