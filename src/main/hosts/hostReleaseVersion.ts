import { getReleaseTrack } from '../../shared/releaseTrack'

/** Stable promotion overrides the source manifest; Owl keeps its existing stable host version. */
export function hostReleaseVersion(runningVersion: string, sourceVersion: string): string {
  return getReleaseTrack(runningVersion) === 'owl' ? sourceVersion : runningVersion
}
