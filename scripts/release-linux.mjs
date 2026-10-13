// Finish a verified Linux desktop package on forge. Usage: node scripts/release-linux.mjs [--rehearse X.Y.Z]
// Builds and checks artifacts only: never installs, uploads or publishes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { releaseCheckout } from './stable-promotion.mjs'
import { fileSha256 } from './release-provenance.mjs'
import { readAsarText } from './asar-entries.mjs'
import { verifyLinuxArchiveContents } from './verify-linux-tarball.mjs'
import { checkedLinuxPackage, linuxChecksumLines, linuxPackageSources, linuxReleaseArguments, REHEARSAL_WARNING, rewriteLinuxPkgbuild } from './linux-release.mjs'
import { clearLinuxFinishOutputs, readLinuxPackageInputs, readLinuxPromotion } from './linux-release-files.mjs'

export async function releaseLinux(args = [], root = resolve(import.meta.dirname, '..')) {
  const release = join(root, 'release')
  const options = linuxReleaseArguments(args)
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Finish the Linux release on x64 forge.')
  if (options.rehearsal) process.stderr.write(`${REHEARSAL_WARNING}\n`)
  await clearLinuxFinishOutputs(release)
  const promotion = options.rehearsal ? null : await readLinuxPromotion(release, releaseCheckout(root))
  const version = promotion?.stableVersion ?? options.version
  const tarballName = `Sotto-${version}-linux-x64.tar.gz`
  const { receipt, tarball, archiveHash } = await readLinuxPackageInputs(release, version)
  checkedLinuxPackage(receipt, { checkout: releaseCheckout(root), version, rehearsal: options.rehearsal, sha256: archiveHash.sha256 })
  const recipe = await readFile(join(root, 'apps/omarchy/PKGBUILD'), 'utf8')
  const sources = linuxPackageSources(recipe)
  const sourceHashes = await Promise.all(sources.map(name => fileSha256(join(root, 'apps/omarchy', name))))
  const updatedRecipe = rewriteLinuxPkgbuild(recipe, version, [archiveHash.sha256, ...sourceHashes.map(hash => hash.sha256)])
  const cache = join(root, '.cache/linux-release')
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(cache, 'package-'))

  function run(command, args, { cwd = stage, env = process.env, capture = false } = {}) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status ?? result.signal}). ${capture ? result.stderr : ''}`)
    return result.stdout
  }

  try {
    await writeFile(join(stage, 'PKGBUILD'), updatedRecipe)
    for (const name of sources) await copyFile(join(root, 'apps/omarchy', name), join(stage, name))
    const environment = { ...process.env, LC_ALL: 'C', PKGDEST: stage, SRCDEST: stage, BUILDDIR: stage, SRCPKGDEST: stage }
    delete environment.SOTTO_TARBALL
    const srcinfo = run('makepkg', ['--printsrcinfo'], { env: environment, capture: true })
    await writeFile(join(stage, '.SRCINFO'), srcinfo)
    run('makepkg', ['--cleanbuild', '--force'], { env: { ...environment, SOTTO_TARBALL: tarball } })
    const packageName = `sotto-bin-${version}-1-x86_64.pkg.tar.zst`
    const builtPackages = run('makepkg', ['--packagelist'], { env: environment, capture: true }).trim().split('\n')
    const packagePath = join(stage, packageName)
    assert.deepEqual(builtPackages, [packagePath], 'makepkg must produce exactly the expected x64 pacman package')
    const fileList = run('pacman', ['-Qlp', packagePath], { capture: true })
    await writeFile(join(cache, 'pacman-file-list.txt'), fileList)
    process.stdout.write(`Checked pacman file list (${fileList.trim().split('\n').length} entries); saved .cache/linux-release/pacman-file-list.txt.\n`)
    const listing = run('bsdtar', ['-tf', packagePath], { capture: true }).split('\n')
    const required = [
      'opt/sotto/sotto', 'opt/sotto/bin/sotto', 'opt/sotto/resources/app.asar', 'usr/bin/sotto',
      'usr/share/applications/sotto.desktop', 'usr/share/licenses/sotto-bin/LICENSE.md',
      ...[48, 128, 256].map(size => `usr/share/icons/hicolor/${size}x${size}/apps/sotto.png`),
      ...['opt/sotto/resources/omarchy', 'usr/share/sotto'].flatMap(directory => [
        `${directory}/bindings.lua`, `${directory}/sotto.json.tpl`,
        `${directory}/shell-plugin/sotto.dictation/manifest.json`,
        `${directory}/install-theme.sh`, `${directory}/install-shell-plugin.sh`,
      ]),
    ]
    for (const name of required) assert.ok(listing.includes(name), `Pacman package is missing ${name}`)
    const sandbox = run('bsdtar', ['-tvf', packagePath, 'opt/sotto/chrome-sandbox'], { capture: true }).trim()
    assert.match(sandbox, /^-rwsr-xr-x\s+\d+\s+root\s+root\s/u, 'chrome-sandbox must be root:root with mode 4755')
    const extracted = join(stage, 'extracted')
    await mkdir(extracted)
    run('bsdtar', ['--no-same-owner', '-xf', packagePath, '-C', extracted])
    const app = join(extracted, 'opt/sotto')
    const asar = join(app, 'resources/app.asar')
    assert.equal(JSON.parse(readAsarText(asar, 'package.json')).version, version)
    assert.equal(JSON.parse(readAsarText(asar, 'out/build-provenance.json')).sourceCommit, receipt.sourceCommit)
    const setup = await verifyLinuxArchiveContents(join(root, 'release/linux-unpacked/resources/omarchy'), join(app, 'resources/omarchy'))
    run(process.execPath, [join(root, 'scripts/with-nested-hyprland.mjs'), join(cache, 'extracted-nested'), process.execPath,
      join(root, 'scripts/verify-linux-package.mjs'), join(app, 'bin/sotto'), join(stage, 'profile'), '--dictation'],
    // Reserve the probe's private Unix socket under the tool checkout's short cache path.
    { cwd: resolve(import.meta.dirname, '..') })
    // Recheck after the GUI proof; a source edit or replaced tarball cannot become a finished release.
    if (promotion) await readLinuxPromotion(release, releaseCheckout(root), promotion)
    checkedLinuxPackage(receipt, { checkout: releaseCheckout(root), version, rehearsal: options.rehearsal, sha256: (await fileSha256(tarball)).sha256 })
    const packageHash = await fileSha256(packagePath)
    await writeFile(join(stage, 'SHA256SUMS.txt'), linuxChecksumLines([
      { name: tarballName, sha256: archiveHash.sha256 }, { name: packageName, sha256: packageHash.sha256 },
    ]))
    await writeFile(join(stage, 'linux-release-verification.json'), JSON.stringify({ version, sourceCommit: receipt.sourceCommit,
      rehearsal: options.rehearsal, publishable: !options.rehearsal, packageName, sandbox, required, setup,
      launch: JSON.parse(await readFile(join(stage, 'profile/result.json'), 'utf8')) }, null, 2) + '\n')
    // The completion record arrives last; failure removes any partially moved bundle.
    for (const name of [packageName, 'PKGBUILD', '.SRCINFO', 'SHA256SUMS.txt', 'linux-release-verification.json']) {
      await rename(join(stage, name), join(release, name))
    }
    process.stdout.write(`${options.rehearsal ? `${REHEARSAL_WARNING}\n` : ''}Linux artifacts checked in release/: ${tarballName}, ${packageName}, PKGBUILD, .SRCINFO and SHA256SUMS.txt.\n`)
  } catch (error) {
    await clearLinuxFinishOutputs(release)
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await releaseLinux(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
