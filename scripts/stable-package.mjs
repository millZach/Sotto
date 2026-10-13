import { decideStablePromotion, requireStableCheckout, stableVersionParts } from './stable-promotion.mjs'

/** Recheck the checkout and evidence recorded by release:check, without another network call. */
export function checkedPromotion(promotion, checkout) {
  if (promotion?.schemaVersion !== 2 || typeof promotion.explicitVersion !== 'boolean' || !Array.isArray(promotion.checks) ||
      !/^[a-f0-9]{40}$/u.test(promotion.mainCommit) || !(promotion.latestStableVersion === null || typeof promotion.latestStableVersion === 'string')) {
    throw new Error('The saved stable release check is missing or outdated. Run release:check again.')
  }
  requireStableCheckout(checkout)
  if (checkout.sourceCommit !== promotion.sourceCommit || checkout.sourceVersion !== promotion.sourceVersion) {
    throw new Error('This checkout does not match the saved stable source or version. Run release:check again.')
  }
  const releases = promotion.latestStableVersion === null ? [] : [{ tag_name: `v${promotion.latestStableVersion}`, published_at: '2026-10-13T00:00:00Z' }]
  const checked = decideStablePromotion(releases, checkout, promotion.checks, promotion.explicitVersion ? promotion.stableVersion : undefined)
  if (checked.stableVersion !== promotion.stableVersion || checked.latestStableVersion !== promotion.latestStableVersion) throw new Error('The saved stable version does not match the release check. Run release:check again.')
  return promotion
}

export function stablePackagePlan(platform, version) {
  stableVersionParts(version)
  if (platform === 'win') return { platform, target: 'nsis', unpacked: 'release/win-unpacked', installer: `release/Sotto Setup ${version}.exe`, config: { extraMetadata: { version } } }
  if (platform === 'mac') return { platform, target: 'dmg', unpacked: 'release/mac-arm64', installer: `release/Sotto-${version}-arm64.dmg`, config: { extraMetadata: { version }, npmRebuild: true } }
  if (platform === 'linux') return { platform, target: 'tar.gz', unpacked: 'release/linux-unpacked', installer: `release/Sotto-${version}-linux-x64.tar.gz`, config: { extraMetadata: { version }, npmRebuild: true } }
  throw new Error('Stable release packaging supports win, mac or linux.')
}

/** Always check manifests, retaining both failures when packaging also failed. */
export async function withStableManifestGuard(packageFiles, verifyManifests) {
  let result
  try { result = await packageFiles() }
  catch (packagingError) {
    try { await verifyManifests() }
    catch (manifestError) {
      throw new AggregateError([packagingError, manifestError], 'Packaging failed and the source package manifests changed.', { cause: manifestError })
    }
    throw packagingError
  }
  await verifyManifests()
  return result
}
