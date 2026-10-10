// Windows only: npm run package:owl -- --date 20261009 --number 1
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { Arch, build, Platform } from 'electron-builder'
import { parse } from 'yaml'
import { owlBuildArguments, resolveOwlVersion } from './owl-release.mjs'

if (process.platform !== 'win32') throw new Error('Sotto Owl packaging currently runs on Windows only.')
const root = resolve(import.meta.dirname, '..')
const packagePath = resolve(root, 'package.json')
const originalManifest = await readFile(packagePath)
const args = owlBuildArguments(process.argv.slice(2))
const version = resolveOwlVersion(JSON.parse(originalManifest).version, args.date, args.number)
const installer = resolve(root, 'release', `Sotto Owl Setup ${version}.exe`)
const safeInstaller = resolve(root, 'release', `Sotto-Owl-Setup-${version}.exe`)

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${basename(script)} failed (${result.status ?? result.signal}).`)
}

run(process.env.npm_execpath, ['run', 'assets:verify'])
run(process.env.npm_execpath, ['run', 'build'])
run(resolve(root, 'scripts/write-build-provenance.mjs'))
await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    extraMetadata: { version },
    nsis: { artifactName: 'Sotto Owl Setup ${version}.${ext}' },
    // The API merges an object override into the first publisher from YAML.
    publish: { provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl', releaseType: 'prerelease' },
    generateUpdatesFilesForAllChannels: false,
  },
})
run(resolve(root, 'scripts/verify-packaged-resources.mjs'), [resolve(root, 'release/win-unpacked'), '--installer', installer])
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
if (!(await readFile(packagePath)).equals(originalManifest)) throw new Error('The source package manifest changed during packaging.')
run(resolve(root, 'tools/verify-owl-package.mjs'), [version])
process.stdout.write(`${JSON.stringify({ version, track: 'owl', installer, uploadInstaller: safeInstaller, manifest: resolve(root, 'release/owl.yml'), blockmap: `${safeInstaller}.blockmap` }, null, 2)}\n`)
