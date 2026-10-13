import { getReleaseTrack } from '../../shared/releaseTrack'

/** An enabled Usage dashboard asks for its matching Owl host; other clients keep the stable target. */
export function hostReleaseVersion(runningVersion: string, sourceVersion: string, usageEnabled = false): string {
  return getReleaseTrack(runningVersion) === 'owl' && !usageEnabled ? sourceVersion : runningVersion
}
