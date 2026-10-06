import { z } from 'zod'
import type { AgentThread } from './agents'

/**
 * A host update (ADR-0040): this computer puts its own Sotto version on a remote host that runs an older one, from
 * the pill and panel on the Threads page, and only when the user presses Update. These are the shapes main publishes
 * in the hosts state and the one command the window sends back.
 */

/** The four steps, in order. Cancel update is offered during the first two only. */
export const HOST_UPDATE_STEPS = ['download', 'check', 'install', 'restart'] as const
export type HostUpdateStep = typeof HOST_UPDATE_STEPS[number]
/**
 * `needs` until Update is pressed. `confirm` while the host has working threads and the user has not said whether to
 * wait for them; `waiting` until none of the host's threads is working; `updating` through the steps; then `done` or
 * `failed`.
 */
export type HostUpdatePhase = 'needs' | 'confirm' | 'waiting' | 'updating' | 'done' | 'failed'
/** How the archive reached the host: the host downloaded it, or this computer downloaded it and copied it over SSH. */
export type HostUpdateRoute = 'host' | 'desktop'
export interface HostUpdateFailure {
  readonly step: HostUpdateStep
  /** What happened. */
  readonly message: string
  /** What the host runs now, and that nothing was lost. */
  readonly kept: string
  /** What to do next. */
  readonly next: string
}
export interface HostUpdateState {
  /** The saved host's ID, which every action names. */
  readonly id: string
  readonly name: string
  /** The Sotto version the host runs, and this computer's, which an update installs. */
  readonly from: string
  readonly to: string
  readonly phase: HostUpdatePhase
  /** Whether Sotto started the host. Only such a host is updated from here; any other shows the commands to run. */
  readonly owned: boolean
  /** How many of the host's threads are working now. */
  readonly working: number
  /** The host starts at boot, so its systemd unit restarts it into the new version (ADR-0054). */
  readonly boot?: boolean | undefined
  readonly step?: HostUpdateStep | undefined
  readonly route?: HostUpdateRoute | undefined
  readonly failure?: HostUpdateFailure | undefined
  /** The commands that update the host by hand, for the user to copy. Sotto never runs them. */
  readonly commands: string
  /** Why the last action was refused, such as Try again on a host that is no longer connected. */
  readonly error?: string | undefined
}
/**
 * What the panel's buttons send. `update` is Update and Try again; `when-idle` is Update when they finish;
 * `stop-threads` is Stop N threads and update (now); `cancel` is Cancel and Cancel update; `not-now` hides the host's
 * update until Sotto next starts; `dismiss` puts away a finished one.
 */
export const HOST_UPDATE_ACTIONS = ['update', 'when-idle', 'stop-threads', 'cancel', 'not-now', 'dismiss'] as const
export type HostUpdateAction = typeof HOST_UPDATE_ACTIONS[number]
export const hostUpdateCommandSchema = z.object({ type: z.literal('host-update'), id: z.uuid(), action: z.enum(HOST_UPDATE_ACTIONS) }).strict()
export type HostUpdateCommand = z.infer<typeof hostUpdateCommandSchema>

/** Where release archives are published: `<base>/v<version>/<archive>`, with a `.sha256` sidecar beside each. */
export const HOST_RELEASES_URL = 'https://github.com/millZach/Sotto-releases/releases/download'
/** The archive name the release procedure publishes for a platform and architecture, such as `linux-x64`. */
export function hostArchiveName(version: string, platform = 'linux', arch = 'x64'): string {
  return `Sotto-host-${version}-${platform}-${arch}.tar.gz`
}
/** A release number, the only form a version folder or the `current` pointer may take. */
export const HOST_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u
/** An archive name as `hostArchiveName` writes it, for a name a host reports back. */
export const HOST_ARCHIVE_PATTERN = /^Sotto-host-\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$/u

/**
 * Whether a thread keeps its host busy for an update: a turn running, context compacting, or background work its turn
 * started. Restarting the host would stop any of them. An archived thread does none of these.
 */
export function threadKeepsHostBusy(thread: Pick<AgentThread, 'status' | 'compaction' | 'backgroundWork' | 'archivedAt'>): boolean {
  if (thread.archivedAt) return false
  return thread.status === 'running' || thread.compaction?.status === 'running' || (thread.backgroundWork?.length ?? 0) > 0
}
