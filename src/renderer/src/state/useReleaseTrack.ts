import { getReleaseTrack, type ReleaseTrack } from '../../../shared/releaseTrack'
import type { UpdateStatus } from '../../../shared/contracts'
import { useOptionalApp } from './AppContext'

/** Main's own word for the track when it sent one, else the version it reported; stable before either arrives. */
export function releaseTrackOf(update: UpdateStatus | null | undefined): ReleaseTrack {
  return update?.releaseTrack ?? getReleaseTrack(update?.currentVersion ?? '')
}

/** Branding reads main's existing update information; no new bridge or request. Stable outside the app. */
export function useReleaseTrack(): ReleaseTrack {
  return releaseTrackOf(useOptionalApp()?.update)
}
