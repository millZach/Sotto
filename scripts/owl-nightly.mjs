// The nightly Owl (ADR-0072, November 1, 2026). Two commands, both run by the Sotto Owl nightly workflow:
//   node scripts/owl-nightly.mjs decide
//     whether tonight's run builds, from which main commit and as which Owl version, written to the run's outputs
//   node scripts/owl-nightly.mjs assemble --root <source checkout> --out <folder> <release:owl options>
//     verifies every platform's files as release:owl does, against a clean checkout of the source commit with the
//     Windows build in it, and gathers them with the notes and checksums in one folder under that checkout
import { execFileSync } from 'node:child_process'
import { appendFile, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolveOwlVersion } from './owl-release.mjs'
// release-owl.mjs reads asars and YAML through installed packages, so only assemble loads it: the decide job runs
// before any npm ci, on Node's own modules.
import { newestOwlRelease, owlReleaseSource, publishedCheckRuns, publishedReleases, RELEASE_REPOSITORY } from './stable-promotion.mjs'

const root = resolve(import.meta.dirname, '..')

/** The checks main's ruleset requires before a merge; a nightly builds only a commit on which all three passed. */
export const OWL_NIGHTLY_REQUIRED_CHECKS = Object.freeze(['Gates (Windows)', 'Package result', 'Desktop result'])

/** The next build number for a UTC day: one past the highest Owl of that day, whatever its base, or 1. */
export function nextOwlNumber(tags, date) {
  if (!/^[1-9]\d{7}$/u.test(date)) throw new Error('Use a UTC build date in YYYYMMDD form.')
  const pattern = new RegExp(`^v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-owl\\.${date}\\.([1-9]\\d*)$`, 'u')
  let highest = 0
  for (const tag of tags) {
    const match = pattern.exec(tag)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** Where each required check stands on one commit: the newest run of each name GitHub Actions made. */
export function requiredCheckStates(checkRuns, sourceCommit, names = OWL_NIGHTLY_REQUIRED_CHECKS) {
  return names.map(name => {
    const check = checkRuns.filter(run => run?.name === name && run.app?.slug === 'github-actions' && run.head_sha === sourceCommit)
      .sort((left, right) => right.id - left.id)[0]
    if (!check) return { name, state: 'missing' }
    if (check.status !== 'completed') return { name, state: 'running' }
    return { name, state: check.conclusion === 'success' ? 'passed' : 'failed', conclusion: check.conclusion }
  })
}

const checkWords = { missing: 'has not started', running: 'is still running', failed: 'did not pass' }

/**
 * Tonight's decision. A run that publishes builds only when main has moved since the newest Owl and every required
 * check passed on it. A dry run builds whatever the rules say, so the whole path can be proved, and reports what a
 * publishing run would have done.
 */
export function decideOwlNightly({ sourceCommit, sourceVersion, releases, tags, checkRuns, date, publish }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) throw new Error('The nightly needs main\'s full source commit.')
  const newest = newestOwlRelease(releases)
  const previous = newest ? { tag: newest.tag_name, ...owlReleaseSource(newest) } : null
  const checks = requiredCheckStates(checkRuns, sourceCommit)
  const skips = []
  if (previous?.sourceCommit === sourceCommit) skips.push(`Main has not changed since ${previous.tag}, which was built from ${sourceCommit.slice(0, 12)}.`)
  for (const check of checks) {
    if (check.state !== 'passed') skips.push(`Required CI check "${check.name}" ${checkWords[check.state]} on ${sourceCommit.slice(0, 12)}${check.conclusion ? ` (${check.conclusion})` : ''}.`)
  }
  const allTags = [...new Set([...tags, ...releases.map(release => release.tag_name).filter(Boolean)])]
  const version = resolveOwlVersion(sourceVersion, date, nextOwlNumber(allTags, date))
  return { build: !publish || skips.length === 0, publish, version, sourceCommit, previous, checks, skips }
}

/** The run summary's account of the decision, in plain words. */
export function decisionSummary(decision) {
  const lines = ['## Sotto Owl nightly', '']
  if (!decision.publish) lines.push('**Dry run.** It builds and checks every platform and publishes nothing.', '')
  if (decision.build) lines.push(`Building **${decision.version}** from \`${decision.sourceCommit}\`.`)
  else lines.push(`**No Owl tonight.** Nothing was built or published.`)
  lines.push('', `- Newest Owl: ${decision.previous ? `${decision.previous.tag}, from \`${decision.previous.sourceCommit.slice(0, 12)}\`` : 'none published'}`)
  for (const check of decision.checks) lines.push(`- ${check.name}: ${check.state}`)
  if (decision.skips.length > 0) {
    lines.push('', decision.publish ? 'Skipped because:' : 'A publishing run would have skipped because:')
    for (const skip of decision.skips) lines.push(`- ${skip}`)
  }
  return `${lines.join('\n')}\n`
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

/** Tags on the release repository, read without credentials; a tag without a release still holds its version. */
function releaseTags() {
  return git(['ls-remote', '--tags', '--refs', `https://github.com/${RELEASE_REPOSITORY}.git`]).split('\n')
    .map(line => line.split('\t')[1]?.replace(/^refs\/tags\//u, '')).filter(Boolean)
}

async function decide() {
  const publish = process.env.PUBLISH === 'true'
  if (publish && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('A nightly publishes only from main. From another branch, start it as a dry run, with publish off.')
  // On main this is the run's own commit. From another branch it is the newest main commit that branch holds, so a
  // dry run builds something main has and the build jobs' history check passes.
  const sourceCommit = git(['merge-base', 'origin/main', process.env.GITHUB_SHA])
  const sourceVersion = JSON.parse(git(['show', `${sourceCommit}:package.json`])).version
  const decision = decideOwlNightly({
    sourceCommit, sourceVersion, publish,
    releases: await publishedReleases(), tags: releaseTags(), checkRuns: await publishedCheckRuns(sourceCommit),
    date: new Date().toISOString().slice(0, 10).replaceAll('-', ''),
  })
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, decisionSummary(decision))
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, [`build=${decision.build}`, `publish=${decision.publish}`, `version=${decision.version}`, `source=${decision.sourceCommit}`, ''].join('\n'))
  }
  process.stdout.write(decisionSummary(decision))
}

/** Verify as release:owl does, then gather every asset, the notes and the checksums in one folder for publishing. */
export async function assembleOwlRelease({ out, args, prepare, rootDirectory = root }) {
  const prepareRelease = prepare ?? (await import('./release-owl.mjs')).prepareOwlRelease
  const { publication, files } = await prepareRelease({ rootDirectory, args })
  const folder = resolve(rootDirectory, out)
  await mkdir(folder, { recursive: true })
  const assets = files.map(path => basename(path))
  for (const path of files) await copyFile(resolve(rootDirectory, path), resolve(folder, basename(path)))
  // release:owl wrote these two beside the Windows build; the checksums list every asset and upload last.
  await copyFile(resolve(rootDirectory, 'release/owl-notes.md'), resolve(folder, 'owl-notes.md'))
  await copyFile(resolve(rootDirectory, 'release/SHA256SUMS.txt'), resolve(folder, 'SHA256SUMS.txt'))
  const manifest = { tag: publication.tag, title: publication.title, assets }
  await writeFile(resolve(folder, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...rest] = process.argv.slice(2)
    if (command === 'decide' && rest.length === 0) await decide()
    else if (command === 'assemble' && rest[0] === '--root' && rest[1] && rest[2] === '--out' && rest[3]) {
      const manifest = await assembleOwlRelease({ rootDirectory: resolve(rest[1]), out: rest[3], args: rest.slice(4) })
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${manifest.title}\n\nEvery platform's files verified. Assets:\n\n${manifest.assets.map(name => `- ${name}`).join('\n')}\n`)
      }
    } else throw new Error('Usage: node scripts/owl-nightly.mjs decide, or node scripts/owl-nightly.mjs assemble --root <source checkout> --out <folder> <release:owl options>')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
