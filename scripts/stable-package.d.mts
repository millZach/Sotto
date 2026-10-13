export interface StablePromotion {
  schemaVersion: 2
  mainCommit: string
  sourceVersion: string
  explicitVersion: boolean
  latestStableVersion: string | null
  checkedAt?: string
  checks: Array<{ id: number; name: string; head_sha: string; status: string; conclusion: string; app: { slug: string } }>
  stableVersion: string
  sourceCommit: string
}

export function checkedPromotion(promotion: StablePromotion, checkout: { sourceCommit: string; clean: boolean; onMain: boolean; mainCommit: string | null; sourceVersion: string }): StablePromotion
export function withStableManifestGuard<T>(packageFiles: () => Promise<T>, verifyManifests: () => Promise<void>): Promise<T>

export function stablePackagePlan(platform: 'win' | 'mac' | 'linux', version: string): {
  platform: 'win' | 'mac' | 'linux'
  target: 'nsis' | 'dmg' | 'tar.gz'
  unpacked: string
  installer: string
  config: { extraMetadata: { version: string }; npmRebuild?: boolean }
}
