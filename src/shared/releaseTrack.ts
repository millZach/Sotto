export type ReleaseTrack = 'stable' | 'owl'

/** Owl is a versioned preview track, independent of the app's identity. */
export function getReleaseTrack(version: string): ReleaseTrack {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u.test(version) ? 'owl' : 'stable'
}
