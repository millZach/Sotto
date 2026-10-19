// Verifies the Mac Owl files downloaded from the "Sotto Owl for Mac" workflow before release:owl attaches them.
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { readAsarText } from './asar-entries.mjs'
import { checkedOwlHostVersion } from './owl-host-artifacts.mjs'
import { sha256 } from './verify-host-archive.mjs'

const execFileAsync = promisify(execFile)
export const OWL_MAC_RECEIPT = 'owl-mac-package.json'
export const OWL_MAC_FILE_LIMIT = 2 * 1024 * 1024 * 1024
const APP_ASAR = 'Sotto.app/Contents/Resources/app.asar'

/** The file each receipt role must name for this Owl version; blockmaps are optional, the rest required. */
export function owlMacFileNames(version) {
  const dmg = `Sotto-Owl-${version}-arm64.dmg`, zip = `Sotto-Owl-${version}-arm64-mac.zip`
  return { dmg, dmgBlockmap: `${dmg}.blockmap`, zip, zipBlockmap: `${zip}.blockmap`, updateManifest: 'owl-mac.yml' }
}
const requiredRoles = ['dmg', 'zip', 'updateManifest']

/** Check a packaging receipt's shape and claims. It says what to expect; the bytes are checked separately. */
export function checkedOwlMacReceipt(receipt, { version, sourceCommit }) {
  const fail = message => { throw new Error(`The Mac Owl receipt ${message}. Download the artifact again from the workflow run for this Owl.`) }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('is not a packaging receipt')
  if (receipt.kind !== 'sotto-owl-mac-package' || receipt.schemaVersion !== 1 || receipt.track !== 'owl' ||
    receipt.platform !== 'darwin' || receipt.arch !== 'arm64') fail('is not for an Apple silicon Owl')
  if (receipt.version !== version) fail(`is for ${String(receipt.version)}, not the Windows Owl ${version}`)
  if (receipt.sourceCommit !== sourceCommit) fail('names a different source commit from the Windows Owl')
  if (!/^[a-f0-9]{64}$/u.test(receipt.buildInputsRevision ?? '')) fail('has no build-input revision')
  const names = owlMacFileNames(version), files = receipt.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('lists no files')
  for (const role of requiredRoles) if (!(role in files)) fail(`does not list the ${role === 'updateManifest' ? 'update manifest' : role}`)
  const checked = []
  for (const [role, file] of Object.entries(files)) {
    if (!Object.hasOwn(names, role)) fail(`lists an unexpected file (${role})`)
    if (file?.filename !== names[role] || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > OWL_MAC_FILE_LIMIT ||
      !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')) fail(`has an invalid entry for ${names[role]}`)
    checked.push({ role, filename: file.filename, size: file.size, sha256: file.sha256 })
  }
  return { buildInputsRevision: receipt.buildInputsRevision, files: checked }
}

/** A tar that reads zip files: libarchive's bsdtar, which Windows 10 and later and macOS ship. */
export function zipReadingTar(platform = process.platform, environment = process.env) {
  if (platform === 'win32') return join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return platform === 'darwin' ? '/usr/bin/tar' : 'bsdtar'
}

/**
 * Extract only Sotto.app's app.asar from the zip, after listing it: the zip must hold Sotto.app and nothing beside
 * it, with exactly one app.asar. Extracting one named file creates none of the bundle's symbolic links.
 */
export async function extractMacAppAsar(zip, into, { tar = zipReadingTar() } = {}) {
  const options = { cwd: dirname(zip), windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
  const { stdout } = await execFileAsync(tar, ['-tf', basename(zip)], options)
  const entries = stdout.split(/\r?\n/u).filter(Boolean)
  if (entries.length === 0 || entries.some(entry => entry !== 'Sotto.app' && !entry.startsWith('Sotto.app/'))) throw new Error('The Mac Owl zip must hold only Sotto.app.')
  if (entries.filter(entry => entry === APP_ASAR).length !== 1) throw new Error('The Mac Owl zip must carry exactly one Sotto.app app.asar.')
  await execFileAsync(tar, ['-xf', basename(zip), '-C', into, APP_ASAR], options)
}

async function regularFile(path, limit) {
  const info = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error })
  if (!info?.isFile() || info.size < 1 || info.size > limit) throw new Error(`${basename(path)} is missing from the Mac Owl folder or is not a bounded regular file.`)
  return info
}

/**
 * Verify the folder downloaded from the "Sotto Owl for Mac" run against the Windows Owl it joins: the receipt names
 * the same version and source, every file it lists is there with its size and SHA-256 and nothing else is, and the
 * zip's packaged app records the same source and version. The disk image cannot be opened here, so its bytes are
 * held to the receipt's digest and to the build attestation the release lead verifies before publishing.
 */
export async function verifyOwlMacArtifacts(directory, { version, sourceCommit } = {}, { extractAsar = extractMacAppAsar } = {}) {
  checkedOwlHostVersion(version)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) throw new Error('Supply a full lower-case source commit')
  const folder = resolve(directory), info = await lstat(folder).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error('Supply the folder downloaded from the Sotto Owl for Mac workflow run with --mac-artifacts.')
  await regularFile(join(folder, OWL_MAC_RECEIPT), 64 * 1024)
  let receipt
  try { receipt = JSON.parse(await readFile(join(folder, OWL_MAC_RECEIPT), 'utf8')) } catch { throw new Error('The Mac Owl receipt is not valid JSON. Download the artifact again.') }
  const checked = checkedOwlMacReceipt(receipt, { version, sourceCommit })
  const present = (await readdir(folder)).sort()
  const expected = [OWL_MAC_RECEIPT, ...checked.files.map(file => file.filename)].sort()
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error('The Mac Owl folder must hold only the files its receipt lists. Download the artifact into an empty folder.')
  const files = []
  let zipBytes
  for (const file of checked.files) {
    const path = join(folder, file.filename), size = (await regularFile(path, OWL_MAC_FILE_LIMIT)).size
    const bytes = await readFile(path), digest = sha256(bytes)
    if (size !== file.size || bytes.length !== file.size || digest !== file.sha256) throw new Error(`${file.filename} does not match the Mac Owl receipt. Download the artifact again.`)
    if (file.role === 'zip') zipBytes = bytes
    // macOS's updater refuses an update that is not signed by the same developer as the running app, so the Mac
    // update feed waits for Developer ID signing (Stage 2). Until then owl-mac.yml is checked but never attached.
    files.push({ path, filename: file.filename, role: file.role, sha256: digest, attach: file.role !== 'updateManifest' })
  }
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-mac-verify-'))
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-mac-verify-')) throw new Error('Unexpected Mac Owl verification directory')
  try {
    // Read the exact zip bytes hashed above, so a replacement after hashing cannot change what is checked.
    const zip = join(temporary, 'sotto-owl-mac.zip'), unpacked = join(temporary, 'unpacked')
    await writeFile(zip, zipBytes); await mkdir(unpacked)
    await extractAsar(zip, unpacked)
    const asar = join(unpacked, ...APP_ASAR.split('/'))
    await regularFile(asar, OWL_MAC_FILE_LIMIT)
    let provenance, packagedVersion
    try {
      provenance = JSON.parse(readAsarText(asar, 'out/build-provenance.json'))
      packagedVersion = JSON.parse(readAsarText(asar, 'package.json')).version
    } catch { throw new Error('The Mac Owl zip\'s Sotto.app carries no readable build provenance.') }
    if (provenance?.sourceCommit !== sourceCommit) throw new Error('The Mac Owl app was built from a different source commit from the Windows Owl.')
    if (provenance.buildInputsRevision !== checked.buildInputsRevision) throw new Error('The Mac Owl app\'s build inputs differ from its receipt.')
    if (packagedVersion !== version) throw new Error(`The Mac Owl app is version ${String(packagedVersion)}, not ${version}.`)
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  return { directory: folder, version, sourceCommit, buildInputsRevision: checked.buildInputsRevision, files }
}
