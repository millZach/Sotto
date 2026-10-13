import { stablePackagePlan } from './stable-package.mjs'

export const REHEARSAL_WARNING = 'REHEARSAL ONLY — NOT PUBLISHABLE. Main, CI and stable version were not checked. Do not install, upload or publish these artifacts.'

/** Both Linux commands must choose the same explicit rehearsal version. */
export function linuxReleaseArguments(args) {
  if (args.length === 0) return { rehearsal: false }
  if (args.length !== 2 || args[0] !== '--rehearse') throw new Error('Expected no arguments for stable, or --rehearse X.Y.Z for a rehearsal.')
  stablePackagePlan('linux', args[1])
  return { rehearsal: true, version: args[1] }
}

export function requireCleanLinuxCheckout(checkout, sourceCommit = checkout.sourceCommit) {
  if (!checkout.clean) throw new Error('Linux packaging needs a clean commit. Save the changes in a commit before trying again.')
  if (checkout.sourceCommit !== sourceCommit) throw new Error('The checkout changed since Linux packaging started. Run both Linux commands again.')
}

/** Refuse a stale tarball or a rehearsal passed to the stable finishing command. */
export function checkedLinuxPackage(receipt, { checkout, version, rehearsal, sha256 }) {
  requireCleanLinuxCheckout(checkout, receipt.sourceCommit)
  const plan = stablePackagePlan('linux', version)
  if (receipt.version !== version || receipt.rehearsal !== rehearsal || receipt.tarball !== plan.installer || receipt.sha256 !== sha256) {
    throw new Error('The Linux tarball does not match this source, version or release mode. Run the matching Linux packaging command again.')
  }
  return plan
}

/** The first source is the versioned archive; every other source is a local recipe file. */
export function linuxPackageSources(recipe) {
  const block = recipe.match(/^source=\(([\s\S]*?)\)\s*$/mu)?.[1]
  const tokens = block?.match(/"[^"]*"|'[^']*'/gu) ?? []
  if (tokens[0] !== '"${_archive}::${_source_url}"' || block.replace(/"[^"]*"|'[^']*'/gu, '').trim() !== '') {
    throw new Error('The Linux recipe source list changed. Check its archive and local files before releasing.')
  }
  const sources = tokens.slice(1).map(token => token.slice(1, -1))
  if (sources.length === 0 || sources.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name))) {
    throw new Error('Linux package sources must be local filenames.')
  }
  return sources
}

export function rewriteLinuxPkgbuild(recipe, version, hashes) {
  stablePackagePlan('linux', version)
  if (hashes.length !== linuxPackageSources(recipe).length + 1 || hashes.some(hash => !/^[a-f0-9]{64}$/u.test(hash))) {
    throw new Error('Every Linux package source needs a lower-case SHA-256 checksum.')
  }
  const replacements = [
    [/^pkgver=.*$/gmu, `pkgver=${version}`],
    [/^pkgrel=.*$/gmu, 'pkgrel=1'],
    [/^sha256sums=\([\s\S]*?\)\s*$/gmu, `sha256sums=(${hashes.map(hash => `'${hash}'`).join('\n            ')})\n`],
  ]
  for (const [pattern, replacement] of replacements) {
    if ([...recipe.matchAll(pattern)].length !== 1) throw new Error('The Linux recipe must have one pkgver, pkgrel and sha256sums list.')
    recipe = recipe.replace(pattern, replacement)
  }
  return recipe
}

export function linuxChecksumLines(artifacts) {
  return artifacts.map(({ name, sha256 }) => {
    if (!/^[a-fA-F0-9]{64}$/u.test(sha256) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) {
      throw new Error('Checksum lines need a SHA-256 hash and a plain artifact filename.')
    }
    return `${sha256.toLowerCase()}  ${name}\n`
  }).join('')
}
