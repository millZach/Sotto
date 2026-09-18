/**
 * Where Sotto's releases live. electron-builder's publish block points the
 * updater at the same repository, so a version the updater names is always a
 * tag on this page.
 */
export const RELEASES_URL = 'https://github.com/millZach/Sotto-releases/releases' as const

/** The release page for one version, or null when there is no version to point at. */
export function releaseUrl(version: string | null | undefined): string | null {
  const trimmed = version?.trim()
  if (!trimmed) return null
  return `${RELEASES_URL}/tag/v${encodeURIComponent(trimmed)}`
}
