import { z } from 'zod'
import { phonesStateSchema, type PhonesState } from '../../shared/phones'
import { isTailnetAddress } from '../../shared/hostConnection'
import type { PressConnection } from './adminConnection'
import { HOST_ADMIN_COMMAND_TIMEOUT_MS, hostAdminRequest } from './hostAdminRequest'
import { hostPhonesAnswerSchema } from './hostPhones'

/**
 * A host's own `tailnetConnections` setting (ADR-0053, "The host side"), read or set through its administrative route on
 * the port an SSH connection or an admin connection forwards, with the token that connection's launch read. Setting it
 * answers once the host's Tailscale Serve has followed, so the answer says how Serve came out. A refusal is
 * `HostAdminRefused`.
 */
export interface HostTailnetSetting {
  readonly enabled: boolean
  readonly state: PhonesState
  /** The host's sentence when it could not save the setting. Nothing was changed then. */
  readonly error?: string | undefined
}

const answerSchema = z.object({ v: z.literal(1), hostId: z.uuid(), enabled: z.boolean(), state: phonesStateSchema, error: z.string().max(1000).optional() })

/** Sets the host's tailnet connections on or off, or, with `enabled` left out, reads the setting as it stands. */
export async function hostTailnetSetting(connection: PressConnection, hostId: string, enabled?: boolean): Promise<HostTailnetSetting> {
  const answer = await hostAdminRequest(connection, 'tailnet', enabled === undefined ? {} : { enabled }, answerSchema, hostId, HOST_ADMIN_COMMAND_TIMEOUT_MS)
  return { enabled: answer.enabled, state: answer.state, ...(answer.error ? { error: answer.error } : {}) }
}

/**
 * Asks the host to set up its Tailscale Serve again, as the Phones dialog's Try again does, then reads the setting: for a
 * Serve that failed because Tailscale was not running or the SSH account was not Tailscale's operator, which the host does
 * not try again by itself.
 */
export async function retryTailnetServe(connection: PressConnection, hostId: string): Promise<HostTailnetSetting> {
  await hostAdminRequest(connection, 'phones-command', { command: { type: 'retry' } }, hostPhonesAnswerSchema, hostId, HOST_ADMIN_COMMAND_TIMEOUT_MS)
  return hostTailnetSetting(connection, hostId)
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
