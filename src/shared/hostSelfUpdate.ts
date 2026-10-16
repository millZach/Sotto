import { z } from 'zod'
import { HOST_READY_TIMEOUT_MS, HOST_STOP_DRAIN_MS } from './hostLaunchTimings'
import { hostIsNewer, hostIsOlder } from './hostProtocol'
import { compareOwlHostTarget, HOST_ARCHIVE_PATTERN } from './hostUpdates'
import { getReleaseTrack } from './releaseTrack'

/**
 * A host that updates itself (ADR-0088): a paired desktop asks the host over its socket, on either listener, and the host
 * runs the launch script's own update operations against itself, as the desktop would run them over SSH. These are the
 * shapes both sides read. The request is `host-update` on the host protocol's closed list (`hostRequestSchema`), and only
 * a desktop the launch script recorded as one, whose `remote-answer` policy lets it answer, is offered the feature.
 */

/** The file in the host's data folder where a restart over the socket reports how it went, for `outcome` to read. */
export const HOST_UPDATE_STATUS_FILE = 'host-update-status.json'
/** The largest status file the host reads: a few small fields, so anything larger is not one it wrote. */
export const HOST_UPDATE_STATUS_LIMIT_BYTES = 4096
/** How long the host waits for its restart to say it has passed its checks, or why not, before it gives up on it. */
export const HOST_UPDATE_RESTART_WAIT_MS = 10_000
/**
 * How long the restart, once it has passed its checks, waits for the host to say it has answered its desktop, before it
 * stops the host anyway. The host says so in `<status file>.<attempt>.answered`.
 */
export const HOST_UPDATE_ANSWER_WAIT_MS = 5_000
/**
 * The longest a restart can take once it has claimed its attempt: the wait for the host's answer, the old host's drain, and
 * a start of the new version and of the old one again, with room to spare. A `restarting` status older than this, or
 * whose process has gone, is a restart that was interrupted, as by a kill or the machine restarting.
 */
export const HOST_UPDATE_RESTART_BUDGET_MS = HOST_UPDATE_ANSWER_WAIT_MS + HOST_STOP_DRAIN_MS + 2 * HOST_READY_TIMEOUT_MS + 60_000
/** The claim file that decides one restart attempt (`<status file>.<attempt>.claim`), and the host's word that it answered. */
export const hostUpdateAttemptFile = (statusFile: string, attempt: string, kind: 'claim' | 'answered'): string => `${statusFile}.${attempt}.${kind}`

/**
 * How a host's `version` stands against an update's `target`: -1 behind it, 0 on it, 1 ahead of it, or undefined when an
 * Owl target cannot be compared with it. By the Owl build order for an Owl target, and by release number otherwise. The
 * desktop decides which hosts need an update by it (ADR-0040), and a host that updates itself refuses any version that is
 * not ahead of its own by the same rule.
 */
export function compareHostToTarget(version: string, target: string): -1 | 0 | 1 | undefined {
  if (getReleaseTrack(target) === 'owl') return compareOwlHostTarget(version, target)
  return hostIsOlder(version, target) ? -1 : hostIsNewer(version, target) ? 1 : 0
}

const version = z.string().min(1).max(64)
const reason = z.string().min(1).max(64)
/** A launch script failure, by its own code, which `HostUpdates.describe()` turns into sentences. */
export const hostUpdateErrorSchema = z.object({ type: z.literal('error'), reason, file: z.string().regex(HOST_ARCHIVE_PATTERN).optional(),
  restarted: z.boolean().optional(), range: z.string().max(64).optional(), node: z.string().max(32).optional(), cause: reason.optional() })
/** How a restart over the socket ended, as its status file keeps it: the new host started, or the launch script's failure. */
export const hostUpdateRestartResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), hostId: z.string().min(1).max(64), pid: z.number().int().positive() }),
  z.object({ type: z.literal('error'), reason, restarted: z.boolean().optional(), cause: reason.optional() }),
])
export type HostUpdateRestartResult = z.infer<typeof hostUpdateRestartResultSchema>
/**
 * What the status file holds: `restarting` once the restart has passed its checks and is about to stop the host, then
 * `finished` with its result. A restart refused before it touched anything is `finished` at once.
 */
const attempt = z.string().regex(/^[a-f0-9]{8,64}$/u)
export const hostUpdateStatusSchema = z.discriminatedUnion('state', [
  z.object({ v: z.literal(1), attempt, state: z.literal('restarting'), version: version.nullable(), pid: z.number().int().positive().optional() }),
  z.object({ v: z.literal(1), attempt, state: z.literal('finished'), version: version.nullable(), result: hostUpdateRestartResultSchema }),
])
export type HostUpdateStatus = z.infer<typeof hostUpdateStatusSchema>

/**
 * What a `host-update` request answers.
 * - `fetch`: `update-fetched` with the archive's name and checksum, which `install` takes back; or `update-cancelled`.
 * - `install`: `update-installed`.
 * - `restart`: `update-restarting` once the restart has passed its checks; the host stops a moment later.
 * - `cancel`: `update-cancelled`, saying whether this client's download was running.
 * - `outcome`: `update-outcome`, with the version this host runs and how the last restart over the socket went.
 * Any of them can be `error`, with the launch script's own reason.
 */
export const hostUpdateFetchedSchema = z.object({ type: z.literal('update-fetched'), file: z.string().regex(HOST_ARCHIVE_PATTERN), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })
export const hostUpdateInstalledSchema = z.object({ type: z.literal('update-installed'), version })
export const hostUpdateAnswerSchema = z.discriminatedUnion('type', [
  hostUpdateFetchedSchema,
  hostUpdateInstalledSchema,
  z.object({ type: z.literal('update-restarting'), version }),
  z.object({ type: z.literal('update-cancelled'), cancelled: z.boolean() }),
  z.object({ type: z.literal('update-outcome'), running: version,
    restart: z.discriminatedUnion('state', [
      z.object({ state: z.literal('none') }),
      z.object({ state: z.literal('restarting'), version: version.nullable() }),
      z.object({ state: z.literal('finished'), version: version.nullable(), result: hostUpdateRestartResultSchema }),
    ]) }),
  hostUpdateErrorSchema,
])
export type HostUpdateAnswer = z.infer<typeof hostUpdateAnswerSchema>
