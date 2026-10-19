// Windows x64 or Apple silicon macOS: npm run package:owl -- --date 20261009 --number 1
// Another platform builds the same Owl: npm run package:owl -- --version 0.1.38-owl.20261009.1 --source <full SHA>
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { Arch, build, Platform } from 'electron-builder'
import { parse } from 'yaml'
import { checkedOwlVersion, checkOwlSource, owlBuildArguments, owlCheckout, owlPublishConfig } from './owl-release.mjs'
import { checkOwlMacUpdateManifest, owlMacPackagePlan, owlMacReceipt, updateFileInfo, verifyOwlMacArchive } from './owl-mac-package.mjs'

const mac = process.platform === 'darwin'
if (!mac && process.platform !== 'win32') throw new Error('Sotto Owl packaging runs on Windows and Apple silicon macOS only.')
if (mac && process.arch !== 'arm64') throw new Error('Build the Mac Sotto Owl on Apple silicon.')
const root = resolve(import.meta.dirname, '..')
const packagePath = resolve(root, 'package.json')
const originalManifest = await readFile(packagePath)
const args = owlBuildArguments(process.argv.slice(2))
const version = checkedOwlVersion(JSON.parse(originalManifest).version, args)

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${basename(script)} failed (${result.status ?? result.signal}).`)
}

// A pinned build (--version with --source) is checked before building, after building and before it reports success.
function checkPin() {
  if (args.sourceCommit !== undefined) checkOwlSource(args.sourceCommit, owlCheckout(root))
}

async function readProvenance() {
  const provenance = JSON.parse(await readFile(resolve(root, 'out/build-provenance.json'), 'utf8'))
  if (args.sourceCommit !== undefined && provenance.sourceCommit !== args.sourceCommit) {
    throw new Error('The build provenance does not name the requested Owl source commit. Nothing was published.')
  }
  return provenance
}

async function packageWindows() {
  const installer = resolve(root, 'release', `Sotto Owl Setup ${version}.exe`)
  const safeInstaller = resolve(root, 'release', `Sotto-Owl-Setup-${version}.exe`)
  await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      extraMetadata: { version },
      nsis: { artifactName: 'Sotto Owl Setup ${version}.${ext}' },
      // The API merges an object override into the first publisher from YAML.
      publish: owlPublishConfig(),
      generateUpdatesFilesForAllChannels: false,
    },
  })
  run(resolve(root, 'scripts/verify-packaged-resources.mjs'), [resolve(root, 'release/win-unpacked'), '--installer', installer])
  run(resolve(root, 'scripts/verify-owl-features-package.mjs'), [resolve(root, 'release/win-unpacked'), 'owl'])
  // GitHub's provider resolves spaces as dashes. Attach these exact manifest names.
  await copyFile(installer, safeInstaller)
  await copyFile(`${installer}.blockmap`, `${safeInstaller}.blockmap`)
  const manifest = parse(await readFile(resolve(root, 'release/owl.yml'), 'utf8'))
  const installerBytes = await readFile(safeInstaller)
  if (manifest.version !== version || manifest.files?.[0]?.url !== basename(safeInstaller) ||
      manifest.files[0].sha512 !== createHash('sha512').update(installerBytes).digest('base64') ||
      manifest.files[0].size !== (await stat(safeInstaller)).size) {
    throw new Error('The Owl update manifest does not match the verified installer.')
  }
  return async () => ({ version, track: 'owl', installer, uploadInstaller: safeInstaller, manifest: resolve(root, 'release/owl.yml'), blockmap: `${safeInstaller}.blockmap` })
}

async function packageMac() {
  const plan = owlMacPackagePlan(root, version)
  // Every file the receipt names is made by this run, so a leftover from an earlier one is never vouched for.
  for (const path of [plan.receipt, plan.dmg, plan.dmgBlockmap, plan.zip, plan.zipBlockmap, plan.updateManifest]) await rm(path, { force: true })
  await build({ projectDir: root, targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64), publish: 'never', config: plan.config })
  run(resolve(root, 'scripts/verify-packaged-resources.mjs'), [plan.unpacked, '--installer', plan.dmg])
  const zipApp = await verifyOwlMacArchive(plan.zip, plan.unpacked)
  run(resolve(root, 'scripts/verify-owl-features-package.mjs'), [plan.unpacked, 'owl'])
  const manifest = parse(await readFile(plan.updateManifest, 'utf8'))
  checkOwlMacUpdateManifest(manifest, version, { zip: await updateFileInfo(plan.zip), dmg: await updateFileInfo(plan.dmg) })
  return async provenance => {
    const receipt = await owlMacReceipt({ version, provenance, plan })
    await writeFile(plan.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
    const blockmaps = [receipt.files.dmgBlockmap, receipt.files.zipBlockmap].filter(Boolean).map(file => resolve(root, 'release', file.filename))
    return { version, track: 'owl', installer: plan.dmg, updateArchive: plan.zip, manifest: plan.updateManifest, blockmaps, receipt: plan.receipt, zipApp }
  }
}

checkPin()
run(process.env.npm_execpath, ['run', 'assets:verify'])
run(process.env.npm_execpath, ['run', 'build'])
run(resolve(root, 'scripts/write-build-provenance.mjs'))
await readProvenance()
checkPin()
const finish = mac ? await packageMac() : await packageWindows()
if (!(await readFile(packagePath)).equals(originalManifest)) throw new Error('The source package manifest changed during packaging.')
// The launch check reads the platform's unpacked app: release/win-unpacked or release/mac-arm64.
run(resolve(root, 'tools/verify-owl-package.mjs'), [version])
checkPin()
// The Mac receipt is written last, so it exists only for a build that passed every check.
const summary = await finish(await readProvenance())
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
