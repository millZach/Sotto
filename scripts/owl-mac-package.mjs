// The Mac half of npm run package:owl: names, signing, the update manifest check, the zip check and the receipt.
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { digestFile, owlPublishConfig } from './owl-release.mjs'

const execFileAsync = promisify(execFile)

/**
 * What the Sotto Owl for Mac workflow hands package:owl to sign with (ADR-0093): its temporary keychain, the SHA-1 of
 * the Developer ID Application identity in it, and the App Store Connect key electron-builder notarizes with.
 */
export const OWL_MAC_SIGNING_ENVIRONMENT = Object.freeze(['CSC_KEYCHAIN', 'SOTTO_OWL_MAC_IDENTITY', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])

/**
 * The Owl-only signing override for electron-builder's mac section: Sotto's Developer ID, the hardened runtime with
 * the entitlements ADR-0001 wrote for it, and notarization. A Mac Owl is never built without it, so a run missing a
 * credential stops here rather than shipping an app that cannot take a signed update.
 */
export function owlMacSigning(environment = process.env) {
  const missing = OWL_MAC_SIGNING_ENVIRONMENT.filter(name => !environment[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`The Mac Owl is signed with Sotto's Developer ID and notarized, and this run has no ${missing.join(', ')}. ` +
      'Build it with the Sotto Owl for Mac workflow, whose owl-mac environment holds the credentials (docs/release/macos-owl-signing.md). Nothing was packaged.')
  }
  if (!/^[A-F0-9]{40}$/u.test(environment.SOTTO_OWL_MAC_IDENTITY)) {
    throw new Error('SOTTO_OWL_MAC_IDENTITY must be the 40-character SHA-1 of the Developer ID Application identity in the signing keychain. Nothing was packaged.')
  }
  // Each of these would make electron-builder sign or notarize with something other than the workflow's keychain and key.
  for (const name of ['CSC_LINK', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN_PROFILE']) {
    if (environment[name]) throw new Error(`Unset ${name}: the Mac Owl signs only with the workflow's keychain and notarizes only with its App Store Connect key. Nothing was packaged.`)
  }
  return {
    identity: environment.SOTTO_OWL_MAC_IDENTITY,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    notarize: true,
  }
}

/**
 * Every path and the electron-builder override for one Mac Owl. Names carry no spaces, so GitHub keeps them.
 * `signing` (from owlMacSigning) is merged into the mac section. Code signing is forced, so electron-builder fails
 * the build when it cannot find the identity instead of leaving the app unsigned.
 */
export function owlMacPackagePlan(root, version, { signing = {} } = {}) {
  const release = resolve(root, 'release')
  const dmg = resolve(release, `Sotto-Owl-${version}-arm64.dmg`)
  const zip = resolve(release, `Sotto-Owl-${version}-arm64-mac.zip`)
  const updateManifest = resolve(release, 'owl-mac.yml')
  const receipt = resolve(release, 'owl-mac-package.json')
  return {
    unpacked: resolve(release, 'mac-arm64'),
    app: resolve(release, 'mac-arm64', 'Sotto.app'),
    dmg, dmgBlockmap: `${dmg}.blockmap`, zip, zipBlockmap: `${zip}.blockmap`, updateManifest, receipt,
    config: {
      extraMetadata: { version },
      // The native modules must be rebuilt for the Mac's Electron, as for the stable Mac build.
      npmRebuild: true,
      forceCodeSigning: true,
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

async function runSigningTool(file, args) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
    return `${stdout}\n${stderr}`
  } catch (error) {
    const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim().split('\n').slice(-6).join(' ')
    throw new Error(`${basename(file)} ${args[0]} refused the Mac Owl: ${output || error?.message}. Nothing was published.`, { cause: error })
  }
}

/**
 * Check the built app the way a Mac will: its signature holds, deeply and strictly; it is signed by a Developer ID
 * Application identity with the hardened runtime; Gatekeeper accepts it as a notarized Developer ID app; and the
 * notarization ticket is stapled to it. Returns what the receipt records. Runs only on a Mac; `run` is the seam tests use.
 */
export async function verifyOwlMacSignature(app, { run = runSigningTool } = {}) {
  const fail = message => { throw new Error(`The Mac Owl ${message}. Nothing was published.`) }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const details = await run('/usr/bin/codesign', ['--display', '--verbose=4', app])
  const authority = /^Authority=Developer ID Application: (.+)$/mu.exec(details)?.[1]?.trim()
  if (!authority) fail('is not signed by a Developer ID Application identity')
  const teamId = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(details)?.[1]
  if (!teamId || !authority.endsWith(`(${teamId})`)) fail("signature names no team, or a team other than its signer's")
  if (!/^CodeDirectory\b.*\bflags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/mu.test(details)) fail('is signed without the hardened runtime')
  const assessment = await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vvv', app])
  if (!/: accepted$/mu.test(assessment) || !/^source=Notarized Developer ID$/mu.test(assessment)) fail('is not accepted by Gatekeeper as a notarized Developer ID app')
  const stapled = await run('/usr/bin/xcrun', ['stapler', 'validate', app])
  if (!/The validate action worked!/u.test(stapled)) fail('has no notarization ticket stapled to it')
  return { identity: 'Developer ID Application', teamId, hardenedRuntime: true, notarized: true, stapled: true }
}

/** Whether a receipt's signing record says Developer ID, hardened runtime, notarized and stapled. */
export function isSignedAndNotarized(signing) {
  return signing?.identity === 'Developer ID Application' && /^[A-Z0-9]{10}$/u.test(signing.teamId ?? '') &&
    signing.hardenedRuntime === true && signing.notarized === true && signing.stapled === true
}

async function receiptFile(path) {
  return { filename: basename(path), size: (await lstat(path)).size, sha256: await hashFile(path, 'sha256', 'hex') }
}

async function exists(path) {
  return lstat(path).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error })
}

/**
 * What a later release step checks downloaded Mac files against. Blockmaps are listed only when produced;
 * the provenance is the one the build wrote and the verified app.asar carries, and `signing` is what
 * verifyOwlMacSignature found.
 */
export async function owlMacReceipt({ version, provenance, plan, signing }) {
  if (!/^[a-f0-9]{40}$/u.test(provenance?.sourceCommit ?? '') || !/^[a-f0-9]{64}$/u.test(provenance?.buildInputsRevision ?? '')) {
    throw new Error('The build provenance needs a full source commit and build-input revision.')
  }
  if (!isSignedAndNotarized(signing)) throw new Error('The Mac Owl receipt is written only for a build that is signed, notarized and stapled.')
  const files = { dmg: await receiptFile(plan.dmg) }
  if (await exists(plan.dmgBlockmap)) files.dmgBlockmap = await receiptFile(plan.dmgBlockmap)
  files.zip = await receiptFile(plan.zip)
  if (await exists(plan.zipBlockmap)) files.zipBlockmap = await receiptFile(plan.zipBlockmap)
  files.updateManifest = await receiptFile(plan.updateManifest)
  return { kind: 'sotto-owl-mac-package', schemaVersion: 2, version, track: 'owl', platform: 'darwin', arch: 'arm64',
    sourceCommit: provenance.sourceCommit, buildInputsRevision: provenance.buildInputsRevision,
    signing: { identity: signing.identity, teamId: signing.teamId, hardenedRuntime: true, notarized: true, stapled: true }, files }
}
