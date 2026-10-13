import { getReleaseTrack } from '../../shared/releaseTrack'

/** Stable uses its packaged version; Owl needs its matching host only while Usage is enabled. */
export function hostReleaseVersion(runningVersion: string, sourceVersion: string, usageEnabled = false): string {
  return getReleaseTrack(runningVersion) === 'owl' && !usageEnabled ? sourceVersion : runningVersion
}
