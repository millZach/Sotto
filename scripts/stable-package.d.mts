export interface StablePromotion {
  owlVersion: string
  stableVersion: string
  sourceCommit: string
}

export function checkedPromotion(promotion: StablePromotion, checkout: { sourceCommit: string; clean: boolean }): StablePromotion
export function withStableManifestGuard<T>(packageFiles: () => Promise<T>, verifyManifests: () => Promise<void>): Promise<T>

export function stablePackagePlan(platform: 'win' | 'mac' | 'linux', version: string): {
  platform: 'win' | 'mac' | 'linux'
  target: 'nsis' | 'dmg' | 'tar.gz'
  unpacked: string
  installer: string
  config: { extraMetadata: { version: string }; npmRebuild?: boolean }
}
