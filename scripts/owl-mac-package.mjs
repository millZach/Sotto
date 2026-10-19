// The Mac half of npm run package:owl: names, the update manifest check, the zip check and the receipt.
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { digestFile, owlPublishConfig } from './owl-release.mjs'

const execFileAsync = promisify(execFile)

/**
 * Every path and the electron-builder override for one Mac Owl. Names carry no spaces, so GitHub keeps them.
 * `signing` is merged into the mac section: until it carries an identity (and notarize), electron-builder.yml's
 * ad-hoc identity applies, the same signature the stable Mac build has.
 */
export function owlMacPackagePlan(root, version, { signing = {} } = {}) {
  const release = resolve(root, 'release')
  const dmg = resolve(release, `Sotto-Owl-${version}-arm64.dmg`)
  const zip = resolve(release, `Sotto-Owl-${version}-arm64-mac.zip`)
  const updateManifest = resolve(release, 'owl-mac.yml')
  const receipt = resolve(release, 'owl-mac-package.json')
  return {
    unpacked: resolve(release, 'mac-arm64'),
    dmg, dmgBlockmap: `${dmg}.blockmap`, zip, zipBlockmap: `${zip}.blockmap`, updateManifest, receipt,
    config: {
      extraMetadata: { version },
      // The native modules must be rebuilt for the Mac's Electron, as for the stable Mac build.
      npmRebuild: true,
      dmg: { artifactName: 'Sotto-Owl-${version}-${arch}.${ext}' },
      // The zip target has no section of its own; it takes the platform's artifact name.
      mac: { artifactName: 'Sotto-Owl-${version}-${arch}-mac.${ext}', ...signing },
      // The API merges an object override into the first publisher from YAML.
      publish: owlPublishConfig(),
      generateUpdatesFilesForAllChannels: false,
    },
  }
}

const hashFile = async (path, algorithm, encoding) => (await digestFile(path, { algorithm, encoding })).digest

/** What an update manifest records about a file. */
export async function updateFileInfo(path) {
  return { url: basename(path), sha512: await hashFile(path, 'sha512', 'base64'), size: (await lstat(path)).size }
}

/**
 * electron-updater on a Mac downloads the zip, so the zip must be the first file and the legacy path.
 * Any other listed file must be the disk image, with its own bytes.
 */
export function checkOwlMacUpdateManifest(manifest, version, { zip, dmg }) {
  const fail = () => { throw new Error('The Mac Owl update manifest does not match the verified zip and disk image.') }
  const files = manifest?.files
  if (manifest?.version !== version || !Array.isArray(files) || files.length === 0 || files[0]?.url !== zip.url) fail()
  const known = new Map([[zip.url, zip], [dmg.url, dmg]])
  const seen = new Set()
  for (const entry of files) {
    const expected = known.get(entry?.url)
    if (!expected || seen.has(entry.url) || entry.sha512 !== expected.sha512 || entry.size !== expected.size) fail()
    seen.add(entry.url)
  }
  if ((manifest.path !== undefined && manifest.path !== zip.url) || (manifest.sha512 !== undefined && manifest.sha512 !== zip.sha512)) fail()
}

async function describeTree(root) {
  const entries = new Map()
  async function walk(directory, prefix) {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry)
      const relative = prefix ? `${prefix}/${entry}` : entry
      const info = await lstat(path)
      if (info.isSymbolicLink()) entries.set(relative, `link ${await readlink(path)}`)
      else if (info.isDirectory()) { entries.set(relative, 'directory'); await walk(path, relative) }
      else if (info.isFile()) entries.set(relative, `file ${info.size} ${(info.mode & 0o111) === 0 ? '-' : 'x'} ${await hashFile(path, 'sha256', 'hex')}`)
      else entries.set(relative, 'other')
    }
  }
  await walk(root, '')
  return entries
}

/** Compare two app bundles path by path: kind, symlink target, size, executable bit and SHA-256. */
export async function compareAppTrees(expectedRoot, actualRoot) {
  const [expected, actual] = await Promise.all([describeTree(expectedRoot), describeTree(actualRoot)])
  const differences = []
  for (const [path, description] of expected) {
    if (!actual.has(path)) differences.push(`missing ${path}`)
    else if (actual.get(path) !== description) differences.push(`differs ${path}`)
  }
  for (const path of actual.keys()) if (!expected.has(path)) differences.push(`extra ${path}`)
  if (differences.length > 0) {
    throw new Error(`The Mac Owl zip's Sotto.app differs from the verified app (${differences.length}): ${differences.slice(0, 10).join(', ')}`)
  }
  const counts = { files: 0, directories: 0, symlinks: 0 }
  for (const description of expected.values()) {
    if (description.startsWith('file ')) counts.files += 1
    else if (description === 'directory') counts.directories += 1
    else if (description.startsWith('link ')) counts.symlinks += 1
  }
  return counts
}

/**
 * Unpack the update zip the way the Mac updater does (ditto) into an owned folder and compare its Sotto.app
 * with the verified one in release/mac-arm64. Only runs on a Mac.
 */
export async function verifyOwlMacArchive(zip, unpacked, { extract = (archive, into) => execFileAsync('/usr/bin/ditto', ['-x', '-k', archive, into]) } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-mac-zip-'))
  try {
    if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-mac-zip-')) throw new Error('Unexpected zip check directory.')
    await extract(zip, temporary)
    const top = (await readdir(temporary)).sort()
    if (top.length !== 1 || top[0] !== 'Sotto.app') throw new Error(`The Mac Owl zip must hold only Sotto.app, not ${top.join(', ') || 'nothing'}.`)
    return await compareAppTrees(join(unpacked, 'Sotto.app'), join(temporary, 'Sotto.app'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function receiptFile(path) {
  return { filename: basename(path), size: (await lstat(path)).size, sha256: await hashFile(path, 'sha256', 'hex') }
}

async function exists(path) {
  return lstat(path).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error })
}

/**
 * What a later release step checks downloaded Mac files against. Blockmaps are listed only when produced;
 * the provenance is the one the build wrote and the verified app.asar carries.
 */
export async function owlMacReceipt({ version, provenance, plan }) {
  if (!/^[a-f0-9]{40}$/u.test(provenance?.sourceCommit ?? '') || !/^[a-f0-9]{64}$/u.test(provenance?.buildInputsRevision ?? '')) {
    throw new Error('The build provenance needs a full source commit and build-input revision.')
  }
  const files = { dmg: await receiptFile(plan.dmg) }
  if (await exists(plan.dmgBlockmap)) files.dmgBlockmap = await receiptFile(plan.dmgBlockmap)
  files.zip = await receiptFile(plan.zip)
  if (await exists(plan.zipBlockmap)) files.zipBlockmap = await receiptFile(plan.zipBlockmap)
  files.updateManifest = await receiptFile(plan.updateManifest)
  return { kind: 'sotto-owl-mac-package', schemaVersion: 1, version, track: 'owl', platform: 'darwin', arch: 'arm64',
    sourceCommit: provenance.sourceCommit, buildInputsRevision: provenance.buildInputsRevision, files }
}
