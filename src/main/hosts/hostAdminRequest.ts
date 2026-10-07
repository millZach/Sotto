import type { z } from 'zod'
import type { PressConnection } from './adminConnection'

/** A command that changes phone access or tailnet connections waits on Tailscale, whose own calls time out after 20 seconds. */
export const HOST_ADMIN_COMMAND_TIMEOUT_MS = 45_000

/**
 * The host answered an administrative request, but not with what was asked: it refused it (`status` is the HTTP status,
 * 401 when it would not take the token even when asked again), or answered something else (`status` is then 200). A
 * host older than the route answers 400.
 */
export class HostAdminRefused extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/**
 * One request to a host's administrative routes (ADR-0050, ADR-0053), on the port an SSH connection or an admin connection
 * forwards, with the token that connection's launch read. The token is asked of the connection again once when the host
 * does not take it, in case the host started again under it. The answer must name `hostId`, or it is not this host's.
 */
export async function hostAdminRequest<T extends { readonly hostId: string }>(connection: PressConnection, route: string, body: unknown,
  answer: z.ZodType<T>, hostId: string, timeoutMs: number, fetcher: typeof fetch = fetch, again = true): Promise<T> {
  const token = await connection.hostAdminToken()
  const response = await fetcher(`${connection.url}/v1/admin/${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status === 401 && again) return hostAdminRequest(connection, route, body, answer, hostId, timeoutMs, fetcher, false)
  if (!response.ok) throw new HostAdminRefused(response.status, response.status === 401 ? 'The host refused the administrative token.' : 'The host refused the request.')
  const parsed = answer.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new HostAdminRefused(response.status, 'The host answered with something else.')
  if (parsed.data.hostId !== hostId) throw new Error('The host identity changed.')
  return parsed.data
}
