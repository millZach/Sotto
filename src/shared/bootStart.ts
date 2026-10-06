import { z } from 'zod'

/**
 * Start at boot (ADR-0054): a host's systemd user unit, installed by Sotto, that starts the host when its machine starts.
 * This is what the launch script's `boot-status` says about it, and what a launch, `boot-install` and `boot-remove`
 * report alongside their own result.
 */
export interface BootStatus {
  /** Whether start at boot can work on this host: Linux with a systemd user manager. */
  readonly supported: boolean
  /** Why it cannot, when it cannot, as a code `bootUnsupportedSentence()` turns into words. */
  readonly reason?: BootUnsupportedReason | undefined
  /** The unit file for this installation is in the account's systemd folder, enabled or not. */
  readonly installed: boolean
  /** The unit is enabled, so the user manager starts it with the account's default target. */
  readonly enabled: boolean
  /** The unit is running a host now. */
  readonly active: boolean
  /** The account lingers: its user manager, and the unit, run from boot rather than from its first sign-in. */
  readonly linger: boolean
  /** The Node the unit's script names is gone, or is not the one the launch script ran under. An update rewrites it. */
  readonly nodeDrift: boolean
  /** The command that turns linger on, for the owner to run on the host, whenever linger is off. Sotto never runs it. */
  readonly fix?: string | undefined
}

/** Why a host cannot start at boot: it runs macOS, or Linux without a systemd user manager (WSL without systemd, a container). */
export const BOOT_UNSUPPORTED_REASONS = ['macos', 'no-user-manager'] as const
export type BootUnsupportedReason = typeof BOOT_UNSUPPORTED_REASONS[number]

/** The one plain sentence a host that cannot start at boot gets, in place of the offer. */
export function bootUnsupportedSentence(reason: BootUnsupportedReason | undefined): string {
  return reason === 'macos'
    ? 'This host runs macOS, where a program starts at boot only with an administrator’s help, so Sotto cannot start it at boot.'
    : 'This host has no systemd user manager, so Sotto cannot start it at boot.'
}

/** The launch script's line, read leniently: a field this build cannot read makes the whole status absent, never wrong. */
export const bootStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.enum(BOOT_UNSUPPORTED_REASONS).optional().catch(undefined),
  installed: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  linger: z.boolean(),
  nodeDrift: z.boolean(),
  fix: z.string().max(300).regex(/^sudo loginctl enable-linger [^\p{Cc}]+$/u).optional().catch(undefined),
})
