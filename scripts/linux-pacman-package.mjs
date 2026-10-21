// Builds sotto-bin from the Omarchy recipe and checks the package, for stable on forge (release-linux.mjs) and for
// a Sotto Owl in the Sotto Owl for Linux workflow (package-owl-linux-pacman.mjs). Never installs or publishes.
import assert from 'node:assert/strict'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { readAsarText } from './asar-entries.mjs'

/** What every sotto-bin must carry: the app, its launcher, desktop entry, icons, licence and the Omarchy setup pieces. */
export const LINUX_PACKAGE_REQUIRED_FILES = Object.freeze([
  'opt/sotto/sotto', 'opt/sotto/bin/sotto', 'opt/sotto/resources/app.asar', 'usr/bin/sotto',
  'usr/share/applications/sotto.desktop', 'usr/share/licenses/sotto-bin/LICENSE.md',
  ...[48, 128, 256].map(size => `usr/share/icons/hicolor/${size}x${size}/apps/sotto.png`),
  ...['opt/sotto/resources/omarchy', 'usr/share/sotto'].flatMap(directory => [
    `${directory}/bindings.lua`, `${directory}/sotto.json.tpl`,
    `${directory}/shell-plugin/sotto.dictation/manifest.json`,
    `${directory}/install-theme.sh`, `${directory}/install-shell-plugin.sh`,
  ]),
])

/**
 * Write the recipe and its local sources into an owned stage folder, record .SRCINFO with the public download URL,
 * and build from the verified local tarball with makepkg, which needs no root. `run` runs a command in the stage.
 */
export async function makeLinuxPacmanPackage({ stage, recipe, sources, sourceDirectory, tarball, packageName, run }) {
  await writeFile(join(stage, 'PKGBUILD'), recipe)
  for (const name of sources) await copyFile(join(sourceDirectory, name), join(stage, name))
  const environment = { ...process.env, LC_ALL: 'C', PKGDEST: stage, SRCDEST: stage, BUILDDIR: stage, SRCPKGDEST: stage }
  delete environment.SOTTO_TARBALL
  const srcinfo = run('makepkg', ['--printsrcinfo'], { env: environment, capture: true })
  await writeFile(join(stage, '.SRCINFO'), srcinfo)
  run('makepkg', ['--cleanbuild', '--force'], { env: { ...environment, SOTTO_TARBALL: tarball } })
  const builtPackages = run('makepkg', ['--packagelist'], { env: environment, capture: true }).trim().split('\n')
  const packagePath = join(stage, packageName)
  assert.deepEqual(builtPackages, [packagePath], 'makepkg must produce exactly the expected x64 pacman package')
  return packagePath
}

/** The version line pacman records for a package, `pkgver-pkgrel`, read from its .PKGINFO text. */
export function pkginfoVersion(pkginfo) {
  const lines = String(pkginfo).split('\n').filter(line => line.startsWith('pkgver = '))
  return lines.length === 1 ? lines[0].slice('pkgver = '.length).trim() : undefined
}

/**
 * Check a built package: every required file, chrome-sandbox root:root 4755, and the extracted app.asar's version and
 * source. Given `pkgver`, also that pacman will record that version with pkgrel 1. Returns the sandbox line and the
 * extracted /opt/sotto.
 */
export async function checkLinuxPacmanPackage({ packagePath, stage, version, sourceCommit, pkgver, run }) {
  const listing = run('bsdtar', ['-tf', packagePath], { capture: true }).split('\n')
  for (const name of LINUX_PACKAGE_REQUIRED_FILES) assert.ok(listing.includes(name), `Pacman package is missing ${name}`)
  if (pkgver !== undefined) {
    const recorded = pkginfoVersion(run('bsdtar', ['-xOf', packagePath, '.PKGINFO'], { capture: true }))
    assert.equal(recorded, `${pkgver}-1`, `The pacman package must record version ${pkgver}-1`)
  }
  const sandbox = run('bsdtar', ['-tvf', packagePath, 'opt/sotto/chrome-sandbox'], { capture: true }).trim()
  assert.match(sandbox, /^-rwsr-xr-x\s+\d+\s+root\s+root\s/u, 'chrome-sandbox must be root:root with mode 4755')
  const extracted = join(stage, 'extracted')
  await mkdir(extracted)
  run('bsdtar', ['--no-same-owner', '-xf', packagePath, '-C', extracted])
  const app = join(extracted, 'opt/sotto')
  const asar = join(app, 'resources/app.asar')
  assert.equal(JSON.parse(readAsarText(asar, 'package.json')).version, version)
  assert.equal(JSON.parse(readAsarText(asar, 'out/build-provenance.json')).sourceCommit, sourceCommit)
  return { sandbox, app }
}
