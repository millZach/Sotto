// Build and check a Sotto Owl's sotto-bin pacman package from the tarball package:owl made (ADR-0099). Runs in the
// Sotto Owl for Linux workflow's Arch Linux job as a user other than root, because makepkg refuses root.
// node scripts/package-owl-linux-pacman.mjs --version <Owl version> --source <full SHA> --tarball <folder> --out <folder>
// The tarball folder holds the package job's artifact: the tarball and owl-linux-package.json. The out folder must be
// new or empty; it receives both, the package, PKGBUILD and .SRCINFO, and owl-linux-pacman.json last. Never installs
// or publishes. The Hyprland launch check stays a stable-release step on forge.
import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { fileSha256 } from './release-provenance.mjs'
import { checkedFullOwlVersion, digestFile } from './owl-release.mjs'
import { linuxPackageSources, rewriteOwlLinuxPkgbuild } from './linux-release.mjs'
import { checkLinuxPacmanPackage, makeLinuxPacmanPackage } from './linux-pacman-package.mjs'
import { verifyLinuxArchiveContents } from './verify-linux-tarball.mjs'
import {
  checkedOwlLinuxReceipt, OWL_LINUX_FILE_LIMIT, owlLinuxFileNames, owlLinuxPacmanReceipt, owlPkgverOrderingCases,
} from './owl-linux-package.mjs'

const USAGE = 'Usage: node scripts/package-owl-linux-pacman.mjs --version <Owl version> --source <full SHA> --tarball <folder> --out <folder>'

export function owlLinuxPacmanArguments(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--version', '--source', '--tarball', '--out'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(USAGE)
    values.set(key, value)
  }
  if (values.size !== 4) throw new Error(USAGE)
  const version = checkedFullOwlVersion(values.get('--version'), {
    form: 'Supply the full Sotto Owl version with --version, such as 0.1.38-owl.20261021.1',
    date: 'Supply a Sotto Owl version whose build date is a real UTC day',
  })
  const sourceCommit = values.get('--source')
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Supply the full lower-case source commit with --source.')
  return { version, sourceCommit, tarballFolder: values.get('--tarball'), out: values.get('--out') }
}

/**
 * Run every ordering case through pacman's own comparison, so a version scheme pacman sorts wrongly fails here, in
 * plain words, before anything is built. `compare` returns vercmp's answer: -1, 0 or 1.
 */
export function checkOwlPkgverOrdering(version, compare) {
  for (const { name, lower, higher } of owlPkgverOrderingCases(version)) {
    const answer = compare(lower, higher)
    if (answer !== -1) {
      throw new Error(`pacman does not sort the Owl's version as Sotto needs: ${lower} must come before ${higher} (${name}), and vercmp answered ${answer}. ` +
        'The Owl cannot replace stable and be replaced by it under this version. Nothing was packaged.')
    }
  }
}

async function regularFile(path) {
  const info = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error })
  if (!info?.isFile() || info.size < 1 || info.size > OWL_LINUX_FILE_LIMIT) throw new Error(`${basename(path)} is missing from the tarball folder or is not a bounded regular file.`)
  return info
}

export async function packageOwlLinuxPacman(args, root = resolve(import.meta.dirname, '..')) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the Linux Owl pacman package on x64 Arch Linux.')
  const { version, sourceCommit, tarballFolder, out } = owlLinuxPacmanArguments(args)
  const names = owlLinuxFileNames(version)

  function run(command, commandArgs, { cwd = root, env = process.env, capture = false } = {}) {
    const result = spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status ?? result.signal}). ${capture ? result.stderr : ''}`)
    return result.stdout
  }

  checkOwlPkgverOrdering(version, (lower, higher) => Number(run('vercmp', [lower, higher], { capture: true }).trim()))
  process.stdout.write(`pacman sorts ${names.pkgver} after the stable release before it and before the one it previews.\n`)

  const folder = resolve(tarballFolder)
  const present = (await readdir(folder)).sort()
  if (JSON.stringify(present) !== JSON.stringify([names.tarball, names.packageReceipt].sort())) {
    throw new Error(`The tarball folder must hold only ${names.tarball} and ${names.packageReceipt}. Nothing was packaged.`)
  }
  await regularFile(join(folder, names.packageReceipt))
  const checked = checkedOwlLinuxReceipt(JSON.parse(await readFile(join(folder, names.packageReceipt), 'utf8')), { version, sourceCommit })
  const destination = resolve(out)
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length > 0) throw new Error('The out folder must be new or empty. Nothing was packaged.')

  const cache = join(root, '.cache/owl-linux-pacman')
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(cache, 'package-'))
  try {
    // The tarball is copied into the owned stage before it is hashed, and makepkg reads the copy, so a replacement in
    // the downloaded folder after hashing cannot change what is packaged.
    const tarball = join(stage, names.tarball)
    await regularFile(join(folder, names.tarball))
    await copyFile(join(folder, names.tarball), tarball)
    const hashed = await digestFile(tarball)
    if (hashed.size !== checked.tarball.size || hashed.digest !== checked.tarball.sha256) throw new Error(`${names.tarball} does not match its packaging receipt. Nothing was packaged.`)

    const recipe = await readFile(join(root, 'apps/omarchy/PKGBUILD'), 'utf8')
    const sources = linuxPackageSources(recipe)
    const sourceHashes = await Promise.all(sources.map(name => fileSha256(join(root, 'apps/omarchy', name))))
    const updatedRecipe = rewriteOwlLinuxPkgbuild(recipe, version, [hashed.digest, ...sourceHashes.map(hash => hash.sha256)])
    const build = join(stage, 'build')
    await mkdir(build)
    const stageRun = (command, commandArgs, options = {}) => run(command, commandArgs, { cwd: build, ...options })
    const packagePath = await makeLinuxPacmanPackage({ stage: build, recipe: updatedRecipe, sources, sourceDirectory: join(root, 'apps/omarchy'),
      tarball, packageName: names.pacman, run: stageRun })
    const fileList = stageRun('pacman', ['-Qlp', packagePath], { capture: true })
    process.stdout.write(`Checked pacman file list (${fileList.trim().split('\n').length} entries).\n`)
    const { sandbox, app } = await checkLinuxPacmanPackage({ packagePath, stage: build, version, sourceCommit, pkgver: names.pkgver, run: stageRun })

    // The package must carry the tarball's app and setup pieces unchanged. package:owl already compared the tarball
    // with the verified unpacked app, file by file.
    const unpacked = join(stage, 'tarball')
    await mkdir(unpacked)
    run('tar', ['-xzpf', names.tarball, '-C', unpacked], { cwd: stage })
    const tarballApp = join(unpacked, names.tarballFolder)
    const setup = await verifyLinuxArchiveContents(join(tarballApp, 'resources/omarchy'), join(app, 'resources/omarchy'))
    const [packagedAsar, tarballAsar] = await Promise.all([fileSha256(join(app, 'resources/app.asar')), fileSha256(join(tarballApp, 'resources/app.asar'))])
    if (packagedAsar.sha256 !== tarballAsar.sha256) throw new Error('The pacman package\'s app.asar differs from the tarball\'s. Nothing was packaged.')

    for (const name of ['PKGBUILD', '.SRCINFO', names.pacman]) await rename(join(build, name), join(destination, name))
    await copyFile(tarball, join(destination, names.tarball))
    await copyFile(join(folder, names.packageReceipt), join(destination, names.packageReceipt))
    const receipt = await owlLinuxPacmanReceipt({ version, sourceCommit, tarball: checked.tarball,
      paths: { pacman: join(destination, names.pacman), pkgbuild: join(destination, 'PKGBUILD'), srcinfo: join(destination, '.SRCINFO') } })
    // Written last, so it exists only for a package that passed every check.
    await writeFile(join(destination, names.pacmanReceipt), `${JSON.stringify(receipt, null, 2)}\n`)
    process.stdout.write(`Linux Owl files checked in ${destination}: ${names.tarball}, ${names.pacman}, PKGBUILD and .SRCINFO. ` +
      `chrome-sandbox: ${sandbox}. Setup pieces compared: ${setup.filesChecked}.\n`)
    return { version, pkgver: names.pkgver, destination, receipt }
  } catch (error) {
    // Nothing half-made is left for the upload step to find.
    await rm(destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await packageOwlLinuxPacman(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
