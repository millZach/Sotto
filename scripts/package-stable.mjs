// Stable desktop packaging checks main, CI and version first; Linux alone supports --rehearse X.Y.Z.
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { checkRelease, stableReleaseArguments } from './check-release.mjs'
import { Arch, build, Platform } from 'electron-builder'
import { stableMacReceipt, stablePackagePlan, checkedPromotion, withStableManifestGuard } from './stable-package.mjs'
import { releaseCheckout } from './stable-promotion.mjs'
import { fileSha256 } from './release-provenance.mjs'
import { linuxReleaseArguments, REHEARSAL_WARNING, requireCleanLinuxCheckout } from './linux-release.mjs'
import { clearLinuxFinishOutputs } from './linux-release-files.mjs'

export async function packageStable(platform, args = [], root = resolve(import.meta.dirname, '..')) {
  const options = args[0] === '--rehearse' ? linuxReleaseArguments(args) : { rehearsal: false, ...stableReleaseArguments(args) }
  if (options.rehearsal && platform !== 'linux') throw new Error('Release rehearsal is available only for Linux.')
  if (platform === 'linux') {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the Linux release on x64 forge.')
    await clearLinuxFinishOutputs(resolve(root, 'release'))
    await rm(resolve(root, 'release/linux-desktop-package.json'), { force: true })
  }
  if (platform === 'mac' && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('Build the Mac release on an Apple silicon Mac.')
  if (options.rehearsal) process.stderr.write(`${REHEARSAL_WARNING}\n`)
  else await checkRelease({ root, version: options.version })
  const checkout = releaseCheckout(root)
  const promotion = options.rehearsal ? null : checkedPromotion(JSON.parse(await readFile(resolve(root, 'release/stable-promotion.json'), 'utf8')), checkout)
  if (options.rehearsal) requireCleanLinuxCheckout(checkout)
  const version = promotion?.stableVersion ?? options.version
  const plan = stablePackagePlan(platform, version)
  const manifestPath = resolve(root, 'package.json')
  const originalManifest = await readFile(manifestPath)
  const originalLock = await readFile(resolve(root, 'package-lock.json'))
  const receiptPath = resolve(root, 'release/linux-desktop-package.json')
  const npm = process.env.npm_execpath ?? resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  function run(script, args = []) {
    const probe = platform === 'linux' && ['verify-packaged-resources.mjs', 'verify-owl-features-package.mjs'].includes(basename(script))
    const command = probe ? [resolve(root, 'scripts/with-nested-hyprland.mjs'), resolve(root, '.cache/linux-release', basename(script, '.mjs')), process.execPath, script, ...args] : [script, ...args]
    const result = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${basename(script)} failed (${result.status ?? result.signal}).`)
  }
  function recheck() {
    if (promotion) checkedPromotion(promotion, releaseCheckout(root))
    else requireCleanLinuxCheckout(releaseCheckout(root), checkout.sourceCommit)
  }
  async function verifySourceManifests() {
    if (!(await readFile(manifestPath)).equals(originalManifest) || !(await readFile(resolve(root, 'package-lock.json'))).equals(originalLock)) {
      throw new Error('The source package manifests changed during packaging.')
    }
  }
  if (platform === 'mac') {
    // The receipt vouches only for files this run made, so leftovers of the same version go first.
    for (const path of [plan.receipt, plan.installer, plan.blockmap]) await rm(resolve(root, path), { force: true })
  }
  await withStableManifestGuard(async () => {
    run(npm, ['run', 'assets:verify'])
    run(npm, ['run', 'build'])
    if (platform === 'mac') run(resolve(root, 'scripts/build-key-listener.mjs'))
    run(resolve(root, 'scripts/write-build-provenance.mjs'))
    recheck()
    const targets = { win: [Platform.WINDOWS, Arch.x64], mac: [Platform.MAC, Arch.arm64], linux: [Platform.LINUX, Arch.x64] }
    const [builderPlatform, arch] = targets[platform]
    await build({ projectDir: root, targets: builderPlatform.createTarget([plan.target], arch),
      publish: 'never', config: plan.config })
    run(resolve(root, 'scripts/verify-packaged-resources.mjs'), [resolve(root, plan.unpacked), '--installer', resolve(root, plan.installer)])
    run(resolve(root, 'scripts/verify-owl-features-package.mjs'), [resolve(root, plan.unpacked), 'stable'])
    recheck()
  }, verifySourceManifests)
  if (platform === 'linux') {
    const { sha256 } = await fileSha256(resolve(root, plan.installer))
    await writeFile(receiptPath, JSON.stringify({ version, sourceCommit: checkout.sourceCommit, rehearsal: options.rehearsal, tarball: plan.installer, sha256 }, null, 2) + '\n')
  }
  if (platform === 'mac') {
    // Written last, so it exists only for a build that passed every check.
    const provenance = JSON.parse(await readFile(resolve(root, 'out/build-provenance.json'), 'utf8'))
    if (provenance.sourceCommit !== checkout.sourceCommit) throw new Error('The build provenance does not name the checked source commit.')
    const receipt = await stableMacReceipt({ version, provenance, dmg: resolve(root, plan.installer), blockmap: resolve(root, plan.blockmap) })
    await writeFile(resolve(root, plan.receipt), JSON.stringify(receipt, null, 2) + '\n')
  }
  process.stdout.write(options.rehearsal ? `${REHEARSAL_WARNING}\nPackaged rehearsal Sotto ${version} from ${checkout.sourceCommit}.\n` :
    `Packaged Sotto ${version} from ${promotion.sourceCommit}, checked on origin/main.\n`)
  return { version, sourceCommit: checkout.sourceCommit, installer: resolve(root, plan.installer) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await packageStable(process.argv[2], process.argv.slice(3)) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
