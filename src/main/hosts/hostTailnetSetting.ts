import { z } from 'zod'
import { phonesStateSchema, type PhonesState } from '../../shared/phones'
import type { PressConnection } from './adminConnection'
import { isTailnetAddress } from './hostConnectionPlan'

/**
 * A host's own `tailnetConnections` setting (ADR-0053, "The host side"), read or set through its administrative route on
 * the port an SSH connection or an admin connection forwards, with the token that connection's launch read. Setting it
 * answers once the host's Tailscale Serve has followed, so the answer says how Serve came out.
 */
export interface HostTailnetSetting {
  readonly enabled: boolean
  readonly state: PhonesState
  /** The host's sentence when it could not save the setting. Nothing was changed then. */
  readonly error?: string | undefined
}

const answerSchema = z.object({ v: z.literal(1), hostId: z.uuid(), enabled: z.boolean(), state: phonesStateSchema, error: z.string().max(1000).optional() })

/** Serve can take Tailscale's own 20 seconds a call, and setting the switch waits for it. */
const TIMEOUT_MS = 45_000

/** The host answered, but not with its tailnet setting: it has no such route, or answered something else. */
export class TailnetSettingRefused extends Error {}

export async function hostTailnetSetting(connection: PressConnection, hostId: string, enabled: boolean | undefined, fetcher: typeof fetch = fetch, again = true): Promise<HostTailnetSetting> {
  const token = await connection.hostAdminToken()
  const response = await fetcher(`${connection.url}/v1/admin/tailnet`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(enabled === undefined ? {} : { enabled }), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // The token is asked of the connection again once, as the Phones dialog does, in case the host started again under it.
  if (response.status === 401 && again) return hostTailnetSetting(connection, hostId, enabled, fetcher, false)
  if (!response.ok) throw new TailnetSettingRefused('The host refused the request.')
  const parsed = answerSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new TailnetSettingRefused('The host answered with something else.')
  if (parsed.data.hostId !== hostId) throw new Error('The host identity changed.')
  return { enabled: parsed.data.enabled, state: parsed.data.state, ...(parsed.data.error ? { error: parsed.data.error } : {}) }
}

/** The tailnet address a setting's answer carries: there only while Serve carries the host's tailnet listener. */
export function settingAddress(setting: HostTailnetSetting): string | undefined {
  const address = setting.state.phase === 'on' ? setting.state.address : null
  return isTailnetAddress(address) ? address : undefined
}

/**
 * Why a setting's answer gives no tailnet address that the owner can act on: Tailscale is not running on the host, or its
 * Serve is waiting for the SSH account to be Tailscale's operator, as Linux asks (ADR-0053's consequences).
 */
export function settingNote(setting: HostTailnetSetting): 'no-tailscale' | 'operator' | undefined {
  if (setting.state.tailscale.status === 'failed') return 'no-tailscale'
  return setting.state.serve.status === 'failed' && setting.state.serve.reason === 'denied' ? 'operator' : undefined
}
