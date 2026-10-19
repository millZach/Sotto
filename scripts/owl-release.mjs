import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Resolve a local Owl build without rewriting the source package manifest. */
export function resolveOwlVersion(stableVersion, date, buildNumber) {
  const core = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(stableVersion)
  if (!core || !core.slice(1).every(part => Number.isSafeInteger(Number(part))) || !Number.isSafeInteger(Number(core[3]) + 1)) {
    throw new Error('Owl needs a plain stable package version.')
  }
  const dateMatch = /^([1-9]\d{3})(\d{2})(\d{2})$/u.exec(date)
  const parsed = dateMatch && new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`)
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll('-', '') !== date) {
    throw new Error('Use a real UTC build date in YYYYMMDD form.')
  }
  if (!/^[1-9]\d*$/u.test(String(buildNumber)) || !Number.isSafeInteger(Number(buildNumber))) {
    throw new Error('Choose a positive daily build number with --number (1, 2, and so on).')
  }
  return `${core[1]}.${core[2]}.${Number(core[3]) + 1}-owl.${date}.${buildNumber}`
}

/**
 * The publisher electron-builder embeds in an Owl and names its update manifest after (owl.yml, owl-mac.yml).
 * Both the Windows and the Mac Owl use it, so a change here changes both.
 */
export function owlPublishConfig() {
  return { provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl', releaseType: 'prerelease' }
}

const fullOwlVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-owl\.([1-9]\d{7})\.[1-9]\d*$/u

/**
 * A full Owl version such as 0.1.38-owl.20261013.1, on a day that exists. `messages.form` and `messages.date` say,
 * in the caller's words, what to supply when the shape or the day is wrong.
 */
export function checkedFullOwlVersion(version, messages) {
  const match = typeof version === 'string' && fullOwlVersion.exec(version)
  if (!match) throw new Error(messages.form)
  const day = match[1], date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll('-', '') !== day) throw new Error(messages.date)
  return version
}

/** Hash a file by streaming it, so a release file of any size is never held in memory; also counts what was hashed. */
export async function digestFile(path, { algorithm = 'sha256', encoding = 'hex' } = {}) {
  const hash = createHash(algorithm)
  let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  return { digest: hash.digest(encoding), size }
}

const USAGE = 'Usage: npm run package:owl -- --number 1 [--date YYYYMMDD], or npm run package:owl -- --version <full Owl version> --source <full SHA>'

/**
 * Either a daily build (--number, optional --date) or a pinned build (--version and --source together).
 * A pinned build is how a second platform builds the same Owl as the first: same version, same commit.
 */
export function owlBuildArguments(args, today = new Date().toISOString().slice(0, 10).replaceAll('-', '')) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--date', '--number', '--version', '--source'].includes(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error(USAGE)
    }
    values.set(key, value)
  }
  if (!values.has('--version') && !values.has('--source')) return { date: values.get('--date') ?? today, number: values.get('--number') }
  if (!values.has('--version') || !values.has('--source') || values.has('--date') || values.has('--number')) throw new Error(USAGE)
  const version = values.get('--version')
  const parts = /^\d+\.\d+\.\d+-owl\.(\d{8})\.(\d+)$/u.exec(version)
  if (!parts) throw new Error('Supply a full Owl version with --version, such as 0.1.38-owl.20261013.1.')
  const sourceCommit = values.get('--source')
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Supply the full lower-case source commit with --source.')
  return { date: parts[1], number: parts[2], version, sourceCommit }
}

/** The Owl version to build; a pinned version must be exactly the next Owl of this checkout's manifest. */
export function checkedOwlVersion(stableVersion, args) {
  const version = resolveOwlVersion(stableVersion, args.date, args.number)
  if (args.version !== undefined && args.version !== version) {
    throw new Error(`Owl ${args.version} is not a build of this checkout, whose next Owl for that day and number is ${version}. Check out the requested source commit and try again.`)
  }
  return version
}

/** Refuse a pinned build unless the clean checkout is the requested commit. A daily build is not pinned. */
export function checkOwlSource(sourceCommit, checkout) {
  if (sourceCommit === undefined) return
  if (!checkout.clean) throw new Error('A pinned Owl builds only from a clean checkout. Commit or remove the local changes and try again. Nothing was packaged.')
  if (checkout.sourceCommit !== sourceCommit) {
    throw new Error(`This checkout is at ${checkout.sourceCommit}, not the requested Owl source ${sourceCommit}. Check out that commit and try again.`)
  }
}

/** HEAD and whether the working tree is clean, without the origin/main reads a stable release needs. */
export function owlCheckout(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  return { sourceCommit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=all']) === '' }
}
