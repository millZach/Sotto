import { getReleaseTrack } from '../../shared/releaseTrack'

/** Stable uses its packaged version; Owl needs its matching host while Muse or Usage is enabled. */
export function hostReleaseVersion(runningVersion: string, sourceVersion: string, requiresOwlHost = false): string {
  return getReleaseTrack(runningVersion) === 'owl' && !requiresOwlHost ? sourceVersion : runningVersion
}

/**
 * The host version an update of this computer to `appVersion` brings (ADR-0077): its own Owl build when an Owl host is
 * required, and otherwise the stable release it is built on, never this running computer's own.
 */
export function updateHostReleaseVersion(appVersion: string, requiresOwlHost = false): string {
  return hostReleaseVersion(appVersion, appVersion.replace(/-owl\.\d+\.\d+$/u, ''), requiresOwlHost)
}
