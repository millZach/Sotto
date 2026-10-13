import { APP_NAME } from './constants'
import { isOwlFeatureEnabled } from './owlFeatures'

export type ReleaseTrack = 'stable' | 'owl'

/** Compatibility wrapper around the Owl feature list for Watcher branches in flight. */
export function isWatcherEnabled(track: ReleaseTrack): boolean { return isOwlFeatureEnabled('watcher', track) }

/** Whether Muse threads may be shown or started on this track at all (ADR-0078). */
export function isMuseProviderEnabled(track: ReleaseTrack): boolean { return isOwlFeatureEnabled('muse', track) }

/** Owl is a versioned preview track, independent of the app's identity. */
export function getReleaseTrack(version: string): ReleaseTrack {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u.test(version) ? 'owl' : 'stable'
}

/**
 * What the running build calls itself in words: the window title, the tray's tooltip and the version line. Only
 * the words change; the app's name, identity and data stay Sotto's on either track (ADR-0072).
 */
export function releaseTrackName(track: ReleaseTrack): string {
  return track === 'owl' ? `${APP_NAME} Owl` : APP_NAME
}
