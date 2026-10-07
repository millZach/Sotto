/**
 * The two connections a desktop reaches a saved host by (ADR-0053): its **tailnet connection**, at the host's tailnet
 * address, and its **SSH connection**, whose port forward carries the socket. The same pair names which one the owner
 * prefers and which one carries the socket.
 */
export const HOST_CONNECTIONS = ['tailnet', 'ssh'] as const
export type HostConnectionName = typeof HOST_CONNECTIONS[number]

/** Who started a host, as its descriptor records: the desktop's launch script, or its start at boot unit (ADR-0054). */
export const HOST_STARTERS = ['launch-script', 'boot'] as const
export type HostStartedBy = typeof HOST_STARTERS[number]
/** Whether a host's own word on who started it names Sotto, which is what lets the desktop offer Stop host. */
export function startedBySotto(value: unknown): value is HostStartedBy {
  return typeof value === 'string' && (HOST_STARTERS as readonly string[]).includes(value)
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
