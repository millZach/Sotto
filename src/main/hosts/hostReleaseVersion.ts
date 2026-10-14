import { getReleaseTrack } from '../../shared/releaseTrack'

/** Stable uses its packaged version; Owl needs its matching host while Muse or Usage is enabled. */
export function hostReleaseVersion(runningVersion: string, sourceVersion: string, requiresOwlHost = false): string {
  return getReleaseTrack(runningVersion) === 'owl' && !requiresOwlHost ? sourceVersion : runningVersion
}
