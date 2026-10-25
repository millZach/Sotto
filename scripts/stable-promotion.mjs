import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

export const RELEASE_REPOSITORY = 'millZach/Sotto-releases'
export const SOURCE_REPOSITORY = 'millZach/Sotto'
export const REQUIRED_RELEASE_CHECKS = ['Gates (Windows)', 'Package result']
const owlVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-owl\.[1-9]\d{7}\.[1-9]\d*$/u
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const fullCommit = /^[a-f0-9]{40}$/u

export function stableVersionParts(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('Use a plain stable version in X.Y.Z form.')
  const parts = version.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Use a plain stable version in X.Y.Z form.')
  return parts
}

export function nextStablePatch(version) {
  const [major, minor, patch] = stableVersionParts(version)
  if (!Number.isSafeInteger(patch + 1)) throw new Error('The next stable patch is too large. Choose a version explicitly.')
  return `${major}.${minor}.${patch + 1}`
}

export function compareStableVersions(left, right) {
  const a = stableVersionParts(left), b = stableVersionParts(right)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}

/** Older stable releases may be marked prerelease when superseded; their plain version tags still count. */
export function newestStableRelease(releases) {
  return releases.filter(release => !release.draft && release.published_at && stableVersion.test((release.tag_name ?? '').slice(1)) && release.tag_name.startsWith('v'))
    .sort((left, right) => compareStableVersions(right.tag_name.slice(1), left.tag_name.slice(1)))[0]
}

/** Published time decides the newest Owl for the daily preview comparison only. */
export function newestOwlRelease(releases) {
  return releases.filter(release => !release.draft && release.published_at && /^v.*-owl\./u.test(release.tag_name ?? ''))
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at) || (right.id ?? 0) - (left.id ?? 0))[0]
}

export function owlReleaseSource(release) {
  if (!release) throw new Error('No published Sotto Owl build was found.')
  const version = release.tag_name.slice(1)
  if (!owlVersion.test(version)) throw new Error(`The Owl release, ${release.tag_name}, has an invalid Owl version.`)
  const sourceLines = (release.body ?? '').split(/\r?\n/u).filter(line => /^Source commit:/u.test(line))
  const sourceCommit = sourceLines.length === 1 ? sourceLines[0].slice('Source commit:'.length).trim().toLowerCase() : ''
  if (!fullCommit.test(sourceCommit)) throw new Error(`Sotto Owl ${version} names no single full source commit. Add "Source commit: <full sha>" to its release body.`)
  return { owlVersion: version, stableVersion: version.split('-owl.')[0], sourceCommit }
}

export function requireStableCheckout(checkout) {
  if (!checkout.clean) throw new Error('This checkout has uncommitted changes. Save them in a commit, then check out a clean commit on origin/main before making a stable release.')
  if (!fullCommit.test(checkout.sourceCommit) || !checkout.onMain || !fullCommit.test(checkout.mainCommit)) {
    throw new Error(`This checkout, ${checkout.sourceCommit}, is not on origin/main. Check out a clean commit on origin/main before making a stable release.`)
  }
}

export function successfulReleaseChecks(checkRuns, sourceCommit) {
  if (!Array.isArray(checkRuns) || checkRuns.some(run => !run || typeof run !== 'object')) {
    throw new Error('The CI check records are unreadable. Run release:check again.')
  }
  return REQUIRED_RELEASE_CHECKS.map(name => {
    const check = checkRuns.filter(run => run.name === name && run.app?.slug === 'github-actions')
      .sort((left, right) => right.id - left.id)[0]
    if (!check || !Number.isSafeInteger(check.id) || check.id < 1 || check.head_sha !== sourceCommit) throw new Error(`Required CI check "${name}" is missing for ${sourceCommit}. Wait for CI on this main commit and run release:check again.`)
    if (check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error(`Required CI check "${name}" has not succeeded for ${sourceCommit} (${check.status}, ${check.conclusion ?? 'no result'}). Wait for successful CI and run release:check again.`)
    }
    return { id: check.id, name, head_sha: check.head_sha, status: check.status, conclusion: check.conclusion, app: { slug: 'github-actions' } }
  })
}

export function decideStablePromotion(releases, checkout, checkRuns, version) {
  requireStableCheckout(checkout)
  const checks = successfulReleaseChecks(checkRuns, checkout.sourceCommit)
  stableVersionParts(checkout.sourceVersion)
  const selected = version ?? nextStablePatch(checkout.sourceVersion)
  stableVersionParts(selected)
  const latestStableVersion = newestStableRelease(releases)?.tag_name.slice(1) ?? null
  if (latestStableVersion && compareStableVersions(selected, latestStableVersion) <= 0) {
    throw new Error(`Stable version ${selected} is not newer than the newest published stable, ${latestStableVersion}. Choose a newer version with --version X.Y.Z.`)
  }
  return { schemaVersion: 2, sourceCommit: checkout.sourceCommit, mainCommit: checkout.mainCommit,
    sourceVersion: checkout.sourceVersion, stableVersion: selected, explicitVersion: version !== undefined, latestStableVersion, checks }
}

export function releaseCheckout(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  const sourceCommit = git(['rev-parse', 'HEAD'])
  let mainCommit = null, onMain = false
  const ref = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (ref.status === 0) {
    mainCommit = ref.stdout.trim()
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', sourceCommit, mainCommit], { cwd: root, windowsHide: true })
    if (ancestry.error || ![0, 1].includes(ancestry.status)) throw new Error('Could not check whether this commit is on origin/main. Fetch origin/main and run release:check again.')
    onMain = ancestry.status === 0
  }
  return { sourceCommit, clean: git(['status', '--porcelain', '--untracked-files=all']) === '', mainCommit, onMain,
    sourceVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version }
}

async function publicGitHubJson(url, description, fetchFeed) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Sotto-release-check', 'X-GitHub-Api-Version': '2022-11-28' }
  // A hosted runner shares its address with other jobs, so the stable Mac workflow passes its read-only job token
  // here to stay clear of the public rate limit. The hand path sets nothing and reads the same public data.
  const token = process.env.SOTTO_RELEASE_CHECK_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchFeed(url, { headers,
      signal: globalThis.AbortSignal.timeout(20_000) })
  } catch { throw new Error(`Could not read ${description}. Check your connection and run release:check again.`) }
  if (!response.ok) {
    if ([403, 429].includes(response.status)) throw new Error(`Could not read ${description} (HTTP ${response.status}). GitHub refused the request or its public rate limit was reached. Wait and run release:check again.`)
    throw new Error(`Could not read ${description} (HTTP ${response.status}). Try release:check again when GitHub is available.`)
  }
  try { return await response.json() }
  catch { throw new Error(`GitHub returned unreadable ${description}. Run release:check again when GitHub is available.`) }
}

/** Public GitHub release feed only. No gh credentials; a token only when SOTTO_RELEASE_CHECK_TOKEN is set. */
export async function publishedReleases(fetchFeed = globalThis.fetch) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const batch = await publicGitHubJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`, 'the public Sotto releases', fetchFeed)
    if (!Array.isArray(batch)) throw new Error('GitHub did not return a release list. Run release:check again when GitHub is available.')
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

/** Public check-runs API, paginated so required summary checks are never lost. */
export async function publishedCheckRuns(sourceCommit, fetchFeed = globalThis.fetch) {
  if (!fullCommit.test(sourceCommit)) throw new Error('CI verification needs a full source commit.')
  const checks = []
  for (let page = 1; ; page += 1) {
    const batch = await publicGitHubJson(`https://api.github.com/repos/${SOURCE_REPOSITORY}/commits/${sourceCommit}/check-runs?filter=latest&per_page=100&page=${page}`, 'the public Sotto CI checks', fetchFeed)
    if (!Array.isArray(batch?.check_runs)) throw new Error('GitHub did not return CI checks. Run release:check again when GitHub is available.')
    checks.push(...batch.check_runs)
    if (batch.check_runs.length < 100) return checks
  }
}
