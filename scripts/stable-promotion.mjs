import { execFileSync } from 'node:child_process'

export const RELEASE_REPOSITORY = 'millZach/Sotto-releases'
const owlVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u
const fullCommit = /^[a-f0-9]{40}$/u

/** Published time decides the newest Owl; a missing source never falls back to an older build. */
export function newestOwlRelease(releases) {
  return releases.filter(release => !release.draft && release.published_at && /^v.*-owl\./u.test(release.tag_name ?? ''))
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at) || (right.id ?? 0) - (left.id ?? 0))[0]
}

export function owlReleaseSource(release) {
  if (!release) throw new Error('No published Sotto Owl build was found. Publish an Owl build of this commit before making a stable release.')
  const version = release.tag_name.slice(1)
  if (!owlVersion.test(version)) throw new Error(`The newest Owl release, ${release.tag_name}, has an invalid Owl version. Publish a correctly named Owl build first.`)
  const sourceLines = (release.body ?? '').split(/\r?\n/u).filter(line => /^Source commit:/u.test(line))
  const sourceCommit = sourceLines.length === 1 ? sourceLines[0].slice('Source commit:'.length).trim().toLowerCase() : ''
  if (!fullCommit.test(sourceCommit)) {
    throw new Error(`The newest Owl release, Sotto Owl ${version}, names no single full source commit. Publish an Owl build with "Source commit: <full sha>" in its release body before making a stable release.`)
  }
  return { owlVersion: version, stableVersion: version.split('-owl.')[0], sourceCommit }
}

export function decideStablePromotion(releases, checkout) {
  const promotion = owlReleaseSource(newestOwlRelease(releases))
  if (checkout.sourceCommit !== promotion.sourceCommit) {
    throw new Error(`This checkout is ${checkout.sourceCommit}. Check out ${promotion.sourceCommit}, the commit Sotto Owl ${promotion.owlVersion} carried, or publish an Owl build of this commit first.`)
  }
  if (!checkout.clean) {
    throw new Error(`This checkout has uncommitted changes. Save them in a commit, then check out the clean ${promotion.sourceCommit} that Sotto Owl ${promotion.owlVersion} carried, or publish an Owl build of the new commit first.`)
  }
  return promotion
}

export function releaseCheckout(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  return { sourceCommit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=all']) === '' }
}

/** Public GitHub release feed only. No token, gh credentials, or private repository access. */
export async function publishedReleases(fetchFeed = globalThis.fetch) {
  const releases = []
  for (let page = 1; ; page += 1) {
    let response
    try {
      response = await fetchFeed(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sotto-release-check' }, signal: globalThis.AbortSignal.timeout(20_000),
      })
    } catch { throw new Error('Could not read the public Sotto Owl releases. Check your connection and run release:check again.') }
    if (!response.ok) throw new Error(`Could not read the public Sotto Owl releases (HTTP ${response.status}). Try release:check again when GitHub is available.`)
    const batch = await response.json()
    if (!Array.isArray(batch)) throw new Error('GitHub did not return a release list. Run release:check again when GitHub is available.')
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}
