// Verifies the Linux Owl files downloaded from the "Sotto Owl for Linux" workflow before release:owl attaches them.
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readAsarText } from './asar-entries.mjs'
import { pkginfoVersion } from './linux-pacman-package.mjs'
import { checkedOwlLinuxPacmanReceipt, checkedOwlLinuxReceipt, OWL_LINUX_FILE_LIMIT, owlLinuxFileNames } from './owl-linux-package.mjs'
import { zipReadingTar } from './owl-mac-artifacts.mjs'
import { checkedFullOwlVersion, digestFile } from './owl-release.mjs'

const execFileAsync = promisify(execFile)
const tarOptions = cwd => ({ cwd, windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024 })

/**
 * Extract only the packaged app's app.asar from the tarball, after listing it: everything must sit in the one folder
 * electron-builder roots the tarball in, with exactly one resources/app.asar. libarchive's tar reads it on Windows,
 * macOS and Linux; extracting one named file creates none of the tarball's links.
 */
export async function extractLinuxAppAsar(tarball, into, { folder, tar = zipReadingTar() } = {}) {
  const asar = `${folder}/resources/app.asar`
  const { stdout } = await execFileAsync(tar, ['-tzf', basename(tarball)], tarOptions(dirname(tarball)))
  const entries = stdout.split(/\r?\n/u).filter(Boolean).map(entry => entry.replace(/^\.\//u, ''))
  if (entries.length === 0 || entries.some(entry => entry !== folder && entry !== `${folder}/` && !entry.startsWith(`${folder}/`))) {
    throw new Error(`The Linux Owl tarball must hold only ${folder}.`)
  }
  if (entries.filter(entry => entry === asar).length !== 1) throw new Error('The Linux Owl tarball must carry exactly one resources/app.asar.')
  await execFileAsync(tar, ['-xzf', basename(tarball), '-C', into, asar], tarOptions(dirname(tarball)))
  return join(into, ...asar.split('/'))
}

/** Read the .PKGINFO pacman records in a package. libarchive's tar reads zstd on Windows 11, macOS and Linux. */
export async function readPacmanPkginfo(packagePath, { tar = zipReadingTar() } = {}) {
  const { stdout } = await execFileAsync(tar, ['-xOf', basename(packagePath), '.PKGINFO'], tarOptions(dirname(packagePath)))
  return stdout
}

async function regularFile(path) {
  const info = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error })
  if (!info?.isFile() || info.size < 1 || info.size > OWL_LINUX_FILE_LIMIT) throw new Error(`${basename(path)} is missing from the Linux Owl folder or is not a bounded regular file.`)
  return info
}

async function readReceipt(path, label) {
  await regularFile(path)
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error(`The Linux Owl ${label} is not valid JSON. Download the artifact again.`) }
}

function singleLine(text, pattern) {
  const matches = String(text).split(/\r?\n/u).filter(line => pattern.test(line))
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Verify the folder downloaded from the "Sotto Owl for Linux" run against the Windows Owl it joins: both receipts name
 * the same version and source, the pacman package was built from that tarball, every file is there with its size and
 * SHA-256 and nothing else is, the tarball's packaged app records the same source and version, and the pacman package
 * records the Owl's pacman version. Returns the tarball and package, the two files the release attaches.
 */
export async function verifyOwlLinuxArtifacts(directory, { version, sourceCommit } = {}, { extractAsar = extractLinuxAppAsar, readPkginfo = readPacmanPkginfo } = {}) {
  checkedFullOwlVersion(version, {
    form: 'Supply the full Sotto Owl version the Linux files join, such as 0.1.38-owl.20261021.1',
    date: 'Supply a Sotto Owl version whose build date is a real UTC day',
  })
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) throw new Error('Supply a full lower-case source commit')
  const folder = resolve(directory), info = await lstat(folder).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error('Supply the folder downloaded from the Sotto Owl for Linux workflow run with --linux-artifacts.')
  const names = owlLinuxFileNames(version)
  const expected = [names.tarball, names.pacman, names.pkgbuild, names.srcinfo, names.packageReceipt, names.pacmanReceipt].sort()
  const present = (await readdir(folder)).sort()
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    throw new Error(`The Linux Owl folder must hold only ${expected.join(', ')}. Download the artifact for this Owl into an empty folder.`)
  }
  const packageReceipt = checkedOwlLinuxReceipt(await readReceipt(join(folder, names.packageReceipt), 'packaging receipt'), { version, sourceCommit })
  const pacmanFiles = checkedOwlLinuxPacmanReceipt(await readReceipt(join(folder, names.pacmanReceipt), 'pacman receipt'), { version, sourceCommit, tarball: packageReceipt.tarball })
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-linux-verify-'))
  const files = []
  try {
    if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-linux-verify-')) throw new Error('Unexpected Linux Owl verification directory')
    // The tarball and package are copied into this owned folder before they are hashed, and the copies are what get
    // read, so a replacement in the downloaded folder after hashing cannot change what is checked.
    const copies = {}
    for (const file of [{ role: 'tarball', ...packageReceipt.tarball }, ...pacmanFiles]) {
      const path = join(folder, file.filename), size = (await regularFile(path)).size
      const copy = join(temporary, file.filename)
      await copyFile(path, copy)
      copies[file.role] = copy
      const hashed = await digestFile(copy)
      if (size !== file.size || hashed.size !== file.size || hashed.digest !== file.sha256) throw new Error(`${file.filename} does not match its Linux Owl receipt. Download the artifact again.`)
      files.push({ path, filename: file.filename, role: file.role, sha256: hashed.digest })
    }
    const unpacked = join(temporary, 'unpacked')
    await mkdir(unpacked)
    const asar = await extractAsar(copies.tarball, unpacked, { folder: names.tarballFolder })
    let provenance, packagedVersion
    try {
      provenance = JSON.parse(readAsarText(asar, 'out/build-provenance.json'))
      packagedVersion = JSON.parse(readAsarText(asar, 'package.json')).version
    } catch { throw new Error('The Linux Owl tarball\'s app carries no readable build provenance.') }
    if (provenance?.sourceCommit !== sourceCommit) throw new Error('The Linux Owl app was built from a different source commit from the Windows Owl.')
    if (provenance.buildInputsRevision !== packageReceipt.buildInputsRevision) throw new Error('The Linux Owl app\'s build inputs differ from its receipt.')
    if (packagedVersion !== version) throw new Error(`The Linux Owl app is version ${String(packagedVersion)}, not ${version}.`)
    // pacman installs by what .PKGINFO says, not by the file name, so that is what must be the Owl's pacman version.
    const pkginfo = await readPkginfo(copies.pacman)
    if (singleLine(pkginfo, /^pkgname = /u) !== 'pkgname = sotto-bin' || pkginfoVersion(pkginfo) !== `${names.pkgver}-1`) {
      throw new Error(`The Linux Owl pacman package is not sotto-bin ${names.pkgver}-1. Download the artifact again.`)
    }
    const recipe = await readFile(copies.pkgbuild, 'utf8'), srcinfo = await readFile(copies.srcinfo, 'utf8')
    if (singleLine(recipe, /^pkgver=/u) !== `pkgver=${names.pkgver}` || singleLine(recipe, /^_version=/u) !== `_version="${version}"` ||
      singleLine(srcinfo, /^\s*pkgver = /u)?.trim() !== `pkgver = ${names.pkgver}`) {
      throw new Error('The Linux Owl PKGBUILD or .SRCINFO does not name this Owl. Download the artifact again.')
    }
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  return { directory: folder, version, sourceCommit, pkgver: names.pkgver, buildInputsRevision: packageReceipt.buildInputsRevision,
    files: files.filter(file => file.role === 'tarball' || file.role === 'pacman') }
}
