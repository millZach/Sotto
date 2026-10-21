/**
 * The launch script's timings (ADR-0040). The desktop sends them with every operation it runs over SSH, and a host that
 * updates itself when a paired desktop asks over its socket (ADR-0088) sends the same ones to the same script, so the two
 * routes cannot drift apart.
 */

/** How long a host has to answer its health once it was started, before a start counts as failed. */
export const HOST_READY_TIMEOUT_MS = 30_000
/** How long Stop host lets a host finish its running turns after SIGTERM before the script kills it. */
export const HOST_STOP_DRAIN_MS = 15_000
/** How long a host has to download an archive and its checksum before the download counts as failed. */
export const HOST_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/**
 * The largest archive an update takes. Today's is about 1 MB; one that carries its own Node (#207) is tens of
 * megabytes. Anything larger is not a Sotto host.
 */
export const HOST_ARCHIVE_LIMIT_BYTES = 512 * 1024 * 1024
/**
 * How long an update lock that names no process counts as held: one being taken right now has not written its process
 * yet. The launch script and a host that updates itself judge the lock by the same rule.
 */
export const HOST_UPDATE_LOCK_UNNAMED_MS = 30_000

/** The timings every launch script operation reads from its configuration. */
export interface HostLaunchTimings {
  readonly readyTimeoutMs: number
  readonly stopDrainMs: number
  readonly downloadTimeoutMs: number
  readonly archiveLimit: number
}
export function hostLaunchTimings(readyTimeoutMs = HOST_READY_TIMEOUT_MS): HostLaunchTimings {
  return { readyTimeoutMs, stopDrainMs: HOST_STOP_DRAIN_MS, downloadTimeoutMs: HOST_DOWNLOAD_TIMEOUT_MS, archiveLimit: HOST_ARCHIVE_LIMIT_BYTES }
}
