import { getReleaseTrack, type ReleaseTrack } from '../../../shared/releaseTrack'
import { useApp } from './AppContext'

/** Branding reads main's existing update information; no new bridge or request. */
export function useReleaseTrack(): ReleaseTrack {
  const { update } = useApp()
  return update?.releaseTrack ?? getReleaseTrack(update?.currentVersion ?? '')
}
