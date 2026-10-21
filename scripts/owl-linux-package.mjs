// The Linux half of npm run package:owl, and the names and version the Owl's pacman package carries (ADR-0099).
import { lstat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { checkedFullOwlVersion, digestFile, owlPublishConfig } from './owl-release.mjs'

const versionMessages = {
  form: 'Supply a full Sotto Owl version, such as 0.1.38-owl.20261021.1',
  date: 'Supply a Sotto Owl version whose build date is a real UTC day',
}

/**
 * The pacman version of an Owl: its version without the hyphen, so 0.1.38-owl.20261021.1 is 0.1.38owl.20261021.1.
 * pacman cannot hold a hyphen in pkgver, and its version comparison has no pre-release marker: a separator such as
 * a tilde or a dot after the patch would sort the Owl after stable 0.1.38. Letters straight after the patch number
 * sort before the bare number (as 1.0rc sorts before 1.0), so the Owl falls after 0.1.37 and before 0.1.38.
 */
export function owlLinuxPkgver(version) {
  checkedFullOwlVersion(version, versionMessages)
  return version.replace('-owl.', 'owl.')
}

/** The Owl version a pacman version names, or undefined when it is not an Owl's. */
export function owlVersionFromPkgver(pkgver) {
  if (typeof pkgver !== 'string' || !/^\d+\.\d+\.\d+owl\.\d{8}\.\d+$/u.test(pkgver)) return undefined
  const version = pkgver.replace('owl.', '-owl.')
  try { checkedFullOwlVersion(version, versionMessages) } catch { return undefined }
  return version
}

/** Every file an Owl's Linux half names. The pacman file name is the one makepkg writes for pkgrel 1. */
export function owlLinuxFileNames(version) {
  const pkgver = owlLinuxPkgver(version)
  return {
    pkgver,
    tarball: `Sotto-Owl-${version}-linux-x64.tar.gz`,
    // electron-builder roots a tar archive in a folder named after it, without .tar.gz.
    tarballFolder: `Sotto-Owl-${version}-linux-x64`,
    pacman: `sotto-bin-${pkgver}-1-x86_64.pkg.tar.zst`,
    pkgbuild: 'PKGBUILD',
    srcinfo: '.SRCINFO',
    packageReceipt: 'owl-linux-package.json',
    pacmanReceipt: 'owl-linux-pacman.json',
  }
}

/**
 * Every path and the electron-builder override for one Linux Owl: an x64 tarball named for Owl, the same version,
 * publisher and identity overrides the Windows and Mac Owls use, and the native rebuild the stable Linux plan turns
 * on. Only the linux section's artifact name changes; no shared top-level key does (ADR-0062).
 */
export function owlLinuxPackagePlan(root, version) {
  const names = owlLinuxFileNames(version)
  const release = resolve(root, 'release')
  return {
    unpacked: resolve(release, 'linux-unpacked'),
    tarball: resolve(release, names.tarball),
    receipt: resolve(release, names.packageReceipt),
    config: {
      extraMetadata: { version },
      // node-pty and the speech engine are rebuilt for Electron on linux-x64, as package:linux:stable does.
      npmRebuild: true,
      linux: { artifactName: 'Sotto-Owl-${version}-linux-${arch}.${ext}' },
      // The API merges an object override into the first publisher from YAML. Linux has no updater; this only keeps
      // the packaged app's publisher the same as the other Owls'.
      publish: owlPublishConfig(),
      generateUpdatesFilesForAllChannels: false,
    },
  }
}

export async function receiptFile(path) {
  const { digest, size } = await digestFile(path)
  return { filename: basename(path), size, sha256: digest }
}

function checkedProvenance(provenance) {
  if (!/^[a-f0-9]{40}$/u.test(provenance?.sourceCommit ?? '') || !/^[a-f0-9]{64}$/u.test(provenance?.buildInputsRevision ?? '')) {
    throw new Error('The build provenance needs a full source commit and build-input revision.')
  }
  return provenance
}

/** What the pacman job and release:owl check the tarball against. Written last, after every check passed. */
export async function owlLinuxReceipt({ version, provenance, plan }) {
  checkedProvenance(provenance)
  const info = await lstat(plan.tarball)
  if (!info.isFile()) throw new Error('The Linux Owl tarball is missing.')
  return { kind: 'sotto-owl-linux-package', schemaVersion: 1, version, track: 'owl', platform: 'linux', arch: 'x64',
    sourceCommit: provenance.sourceCommit, buildInputsRevision: provenance.buildInputsRevision,
    files: { tarball: await receiptFile(plan.tarball) } }
}

const sha256Pattern = /^[a-f0-9]{64}$/u
export const OWL_LINUX_FILE_LIMIT = 2 * 1024 * 1024 * 1024

function checkedFileEntry(file, filename, fail) {
  if (file?.filename !== filename || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > OWL_LINUX_FILE_LIMIT ||
    !sha256Pattern.test(file.sha256 ?? '')) fail(`has an invalid entry for ${filename}`)
  return { filename: file.filename, size: file.size, sha256: file.sha256 }
}

function checkedObject(value, fail, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message)
  return value
}

/** Check the tarball receipt's shape and claims against the Windows Owl it joins. The bytes are checked separately. */
export function checkedOwlLinuxReceipt(receipt, { version, sourceCommit }) {
  const fail = message => { throw new Error(`The Linux Owl packaging receipt ${message}. Download the artifact again from the workflow run for this Owl.`) }
  checkedObject(receipt, fail, 'is not a packaging receipt')
  if (receipt.kind !== 'sotto-owl-linux-package' || receipt.schemaVersion !== 1 || receipt.track !== 'owl' || receipt.platform !== 'linux' || receipt.arch !== 'x64') {
    fail('is not for an x64 Linux Owl')
  }
  if (receipt.version !== version) fail(`is for ${String(receipt.version)}, not the Windows Owl ${version}`)
  if (receipt.sourceCommit !== sourceCommit) fail('names a different source commit from the Windows Owl')
  if (!sha256Pattern.test(receipt.buildInputsRevision ?? '')) fail('has no build-input revision')
  const files = checkedObject(receipt.files, fail, 'lists no files')
  if (JSON.stringify(Object.keys(files)) !== '["tarball"]') fail('must list the tarball and nothing else')
  return { buildInputsRevision: receipt.buildInputsRevision, tarball: checkedFileEntry(files.tarball, owlLinuxFileNames(version).tarball, fail) }
}

/** What the Linux Owl workflow's pacman job writes last, once the package passed every check. */
export async function owlLinuxPacmanReceipt({ version, sourceCommit, tarball, paths }) {
  const names = owlLinuxFileNames(version)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '') || !sha256Pattern.test(tarball?.sha256 ?? '') || tarball.filename !== names.tarball) {
    throw new Error('The pacman receipt needs the full source commit and the checked tarball.')
  }
  const files = {}
  for (const role of ['pacman', 'pkgbuild', 'srcinfo']) {
    files[role] = await receiptFile(paths[role])
    if (files[role].filename !== names[role]) throw new Error(`The pacman package file ${files[role].filename} is not ${names[role]}.`)
  }
  return { kind: 'sotto-owl-linux-pacman', schemaVersion: 1, version, pkgver: names.pkgver, pkgrel: 1, track: 'owl', platform: 'linux', arch: 'x64',
    sourceCommit, tarball: { filename: tarball.filename, sha256: tarball.sha256 }, files }
}

/** Check the pacman receipt against the Windows Owl and the tarball receipt it was built from. */
export function checkedOwlLinuxPacmanReceipt(receipt, { version, sourceCommit, tarball }) {
  const fail = message => { throw new Error(`The Linux Owl pacman receipt ${message}. Download the artifact again from the workflow run for this Owl.`) }
  const names = owlLinuxFileNames(version)
  checkedObject(receipt, fail, 'is not a pacman receipt')
  if (receipt.kind !== 'sotto-owl-linux-pacman' || receipt.schemaVersion !== 1 || receipt.track !== 'owl' || receipt.platform !== 'linux' || receipt.arch !== 'x64') {
    fail('is not for an x64 Linux Owl')
  }
  if (receipt.version !== version) fail(`is for ${String(receipt.version)}, not the Windows Owl ${version}`)
  if (receipt.pkgver !== names.pkgver || receipt.pkgrel !== 1) fail(`does not name the pacman version ${names.pkgver}-1`)
  if (receipt.sourceCommit !== sourceCommit) fail('names a different source commit from the Windows Owl')
  if (receipt.tarball?.filename !== tarball.filename || receipt.tarball?.sha256 !== tarball.sha256) fail('was built from a different tarball')
  const files = checkedObject(receipt.files, fail, 'lists no files')
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(['pacman', 'pkgbuild', 'srcinfo'])) fail('must list the pacman package, PKGBUILD and .SRCINFO and nothing else')
  return ['pacman', 'pkgbuild', 'srcinfo'].map(role => ({ role, ...checkedFileEntry(files[role], names[role], fail) }))
}

function nextDay(day) {
  const date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * Pairs of pacman versions that must sort lower then higher for this Owl to replace stable and be replaced by it as
 * the Windows Owl does: after the stable before it, before the stable it previews, after an earlier build that day
 * (numbers compared as numbers) and an earlier day, and before the next base's Owl. The workflow runs each through
 * pacman's own vercmp.
 */
export function owlPkgverOrderingCases(version) {
  const pkgver = owlLinuxPkgver(version)
  const [, major, minor, patch, day, number] = /^(\d+)\.(\d+)\.(\d+)-owl\.(\d{8})\.(\d+)$/u.exec(version)
  const base = `${major}.${minor}.${patch}`
  const owl = (dayValue, numberValue, patchValue = patch) => `${major}.${minor}.${patchValue}owl.${dayValue}.${numberValue}`
  const cases = []
  if (Number(patch) > 0) cases.push({ name: 'after the stable release before it', lower: `${major}.${minor}.${Number(patch) - 1}`, higher: pkgver })
  cases.push(
    { name: 'before the stable release it previews', lower: pkgver, higher: base },
    { name: 'before the next build that day', lower: pkgver, higher: owl(day, Number(number) + 1) },
    { name: 'build 10 after build 9', lower: owl(day, 9), higher: owl(day, 10) },
    { name: 'before the next day\'s build', lower: pkgver, higher: owl(nextDay(day), 1) },
    { name: 'stable before the next base\'s Owl', lower: base, higher: owl(day, 1, Number(patch) + 1) },
  )
  return cases
}
