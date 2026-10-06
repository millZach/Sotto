import { z } from 'zod'

/** Why a host cannot start at boot: it runs macOS, or Linux without a systemd user manager (WSL without systemd, a container). */
export const BOOT_UNSUPPORTED_REASONS = ['macos', 'no-user-manager'] as const
export type BootUnsupportedReason = typeof BOOT_UNSUPPORTED_REASONS[number]

/** The one plain sentence a host that cannot start at boot gets, in place of the offer. */
export function bootUnsupportedSentence(reason: BootUnsupportedReason | undefined): string {
  return reason === 'macos'
    ? 'This host runs macOS, where a program starts at boot only with an administrator’s help, so Sotto cannot start it at boot.'
    : 'This host has no systemd user manager, so Sotto cannot start it at boot.'
}

/**
 * The linger command exactly as the launch script writes it: the account's name bare, or as one single-quoted word. It
 * is shown for the owner to paste into a shell on the host, so nothing else a host might send is taken for it.
 */
const LINGER_FIX = /^sudo loginctl enable-linger (?:[A-Za-z0-9._-]+|'[^'\p{Cc}]+')$/u

/**
 * Start at boot (ADR-0054): a host's systemd user unit, installed by Sotto, that starts the host when its machine starts.
 * This is what the launch script's `boot-status` says about it, and what a launch, `boot-install` and `boot-remove`
 * report alongside their own result. It is read leniently: a `reason` or `fix` this build cannot read is left out, and
 * any other field it cannot read makes the whole status unreadable, never wrong.
 */
export const bootStatusSchema = z.object({
  /** Whether start at boot can work on this host: Linux with systemd, where the account's user manager runs or linger would start it. */
  supported: z.boolean(),
  /** Why it cannot, when it cannot, as a code `bootUnsupportedSentence()` turns into words. */
  reason: z.enum(BOOT_UNSUPPORTED_REASONS).optional().catch(undefined),
  /** The unit file for this installation is in the account's systemd folder, enabled or not. */
  installed: z.boolean(),
  /** The unit is enabled, so the user manager starts it with the account's default target. */
  enabled: z.boolean(),
  /** The unit is running a host now. */
  active: z.boolean(),
  /** The account lingers: its user manager, and the unit, run from boot rather than from its first sign-in. */
  linger: z.boolean(),
  /** The Node the unit's script names is gone, or is not the one the launch script ran under. The next unit start rewrites it. */
  nodeDrift: z.boolean(),
  /** The command that turns linger on, for the owner to run on the host, when the host is supported and linger is off. Sotto never runs it. */
  fix: z.string().max(300).regex(LINGER_FIX).optional().catch(undefined),
})
export type BootStatus = Readonly<z.infer<typeof bootStatusSchema>>

/**
 * The presses of a start at boot change in Settings > Hosts (ADR-0054): `install` is Start at boot, `remove` is Stop
 * starting at boot, and the busy-host question's answers follow ADR-0040's: `when-idle` waits for the host's working
 * threads, `stop-threads` stops them and goes on at once, `cancel` changes nothing. `dismiss` puts a result away.
 */
export const HOST_BOOT_ACTIONS = ['install', 'remove', 'when-idle', 'stop-threads', 'cancel', 'dismiss'] as const
export type HostBootAction = typeof HOST_BOOT_ACTIONS[number]
export const hostBootCommandSchema = z.object({ type: z.literal('host-boot'), id: z.uuid(), action: z.enum(HOST_BOOT_ACTIONS) }).strict()
export type HostBootCommand = z.infer<typeof hostBootCommandSchema>
/**
 * `confirm` while the change would restart a host with working threads and the user has not said what to do with them;
 * `waiting` until none of them is working; `changing` while the launch script runs it; then `done` or `failed`.
 */
export type HostBootPhase = 'confirm' | 'waiting' | 'changing' | 'done' | 'failed'
/**
 * Why a change did not happen: `linger` when the host would not turn linger on without an administrator, `unsupported`
 * when the host cannot start at boot at all, and `failed` for anything else. Each says what happened, whether anything
 * was lost and what to do next; `fix` is a command for the owner to run on the host, which Sotto never runs.
 */
export interface HostBootFailure {
  readonly kind: 'linger' | 'unsupported' | 'failed'
  readonly message: string
  readonly fix?: { readonly text: string; readonly command: string } | undefined
}
/** One saved host's start at boot change, from the press until its result is put away. Kept in memory only. */
export interface HostBootState {
  /** The saved host's ID, which every press names. */
  readonly id: string
  readonly name: string
  /** Start at boot (`install`) or Stop starting at boot (`remove`). */
  readonly change: 'install' | 'remove'
  readonly phase: HostBootPhase
  /** How many of the host's threads are working now. */
  readonly working: number
  /** Whether the change restarts the host: one Sotto started, handed to the unit or taken off it. */
  readonly restarts: boolean
  /** Once done: whether the host restarted, under the unit or outside it. */
  readonly restarted?: boolean | undefined
  readonly failure?: HostBootFailure | undefined
}
