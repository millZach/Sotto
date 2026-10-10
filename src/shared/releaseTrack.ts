import { APP_NAME } from './constants'

export type ReleaseTrack = 'stable' | 'owl'

/** Owl is a versioned preview track, independent of the app's identity. */
export function getReleaseTrack(version: string): ReleaseTrack {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u.test(version) ? 'owl' : 'stable'
}

/**
 * What the running build calls itself in words: the window title, the tray's tooltip and the version line. Only
 * the words change; the app's name, identity and data stay Sotto's on either track (ADR-0070).
 */
export function releaseTrackName(track: ReleaseTrack): string {
  return track === 'owl' ? `${APP_NAME} Owl` : APP_NAME
}
