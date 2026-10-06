import { HostConnectionError, WrongHostError } from '../agents/socketHostService'

/**
 * The order of a connect to a saved host (ADR-0053, "The order of a connect"), as a small pure table so each row can be
 * tested on its own. `DesktopHosts.open()` follows it: which connection a connect tries first, what a failed tailnet
 * connection leads to, and when a host on its SSH connection tries the tailnet again.
 *
 * A **tailnet connection** opens the host service at the host's tailnet address, authenticated by this computer's
 * pairing, and spawns no `ssh`. The **SSH connection** is today's launch, pairing and port forward. SSH stays the
 * fallback, and the only way a desktop pairs.
 */

/** Which connection the owner prefers for a saved host. A host with no entry in the tailnet store prefers SSH. */
export type HostConnectionPreference = 'tailnet' | 'ssh'
/** Which connection carries a host's socket. */
export type HostVia = 'tailnet' | 'ssh'

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
  /** Who started the host, as it last said. `boot` is a host its start at boot unit started (ADR-0054). */
  readonly startedBy?: string | undefined
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
  if (facts.adding || facts.prefer !== 'tailnet' || !facts.address || !facts.paired) return ['ssh']
  const bootRetry = facts.startedBy === 'boot' && facts.lastVia === 'tailnet' && facts.retryingForMs !== undefined && facts.retryingForMs < BOOT_TAILNET_ONLY_MS
  return bootRetry ? ['tailnet'] : ['tailnet', 'ssh']
}

/** Whether a host just connected over SSH tries to move its socket to the tailnet. */
export function tryTailnetAfterSsh(facts: Pick<ConnectFacts, 'prefer' | 'address' | 'paired'>): boolean {
  return facts.prefer === 'tailnet' && facts.address !== undefined && facts.paired
}

/**
 * An `https:` address on a MagicDNS name, with its port and nothing else: the only tailnet address a desktop accepts. It
 * is evidence of where to look, never of identity: the host's certificate, the pairing and its host ID are.
 */
export function isTailnetAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'https:' && !url.username && !url.password && url.port !== '' && (url.pathname === '/' || url.pathname === '')
    && !url.search && !url.hash && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/u.test(url.hostname) && value === `https://${url.hostname}:${url.port}`
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
