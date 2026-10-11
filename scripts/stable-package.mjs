import { decideStablePromotion } from './stable-promotion.mjs'

/** Recheck the checkout before consuming the promotion produced by release:check. */
export function checkedPromotion(promotion, checkout) {
  const checked = decideStablePromotion([{ tag_name: `v${promotion.owlVersion}`, body: `Source commit: ${promotion.sourceCommit}`,
    published_at: '2026-10-10T00:00:00Z' }], checkout)
  if (checked.stableVersion !== promotion.stableVersion) throw new Error('The saved promotion version does not match its Owl build. Run release:check again.')
  return checked
}

export function stablePackagePlan(platform, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) throw new Error('Stable packaging needs the base version of the promoted Owl build.')
  if (platform === 'win') return { platform, target: 'nsis', unpacked: 'release/win-unpacked', installer: `release/Sotto Setup ${version}.exe`, config: { extraMetadata: { version } } }
  if (platform === 'mac') return { platform, target: 'dmg', unpacked: 'release/mac-arm64', installer: `release/Sotto-${version}-arm64.dmg`, config: { extraMetadata: { version }, npmRebuild: true } }
  throw new Error('Stable release packaging supports win or mac.')
}
