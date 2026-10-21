// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pacmanVercmp } from '../../fixtures/pacmanVercmp.mjs'
import { pkginfoVersion } from '../../../scripts/linux-pacman-package.mjs'
import { rewriteLinuxPkgbuild, rewriteOwlLinuxPkgbuild } from '../../../scripts/linux-release.mjs'
import { clearLinuxFinishOutputs, LINUX_PACMAN_PACKAGE } from '../../../scripts/linux-release-files.mjs'
import {
  checkedOwlLinuxPacmanReceipt, checkedOwlLinuxReceipt, owlLinuxFileNames, owlLinuxPackagePlan, owlLinuxPacmanReceipt, owlLinuxPkgver,
  owlLinuxReceipt, owlPkgverOrderingCases, owlVersionFromPkgver,
} from '../../../scripts/owl-linux-package.mjs'
import { checkOwlPkgverOrdering, owlLinuxPacmanArguments } from '../../../scripts/package-owl-linux-pacman.mjs'
import { owlPublishConfig } from '../../../scripts/owl-release.mjs'

const version = '0.1.38-owl.20261021.1', sourceCommit = 'a'.repeat(40), inputs = 'c'.repeat(64)
const recipe = await readFile(new URL('../../../apps/omarchy/PKGBUILD', import.meta.url), 'utf8')
const hashes = ['a', 'b', 'c', 'd', 'e', 'f', '0'].map(character => character.repeat(64))
const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-owl-linux-package-test-')); roots.push(root); return root }

/** What makepkg would make of the recipe's names: the top-level assignments before the local-tarball branch, expanded. */
function expandRecipe(text) {
  const values = {}
  const expand = value => value.replace(/\$\{(\w+)\}/gu, (_, name) => values[name])
  for (const line of text.split('\n')) {
    if (line.startsWith('if ')) break
    const match = /^(\w+)=(?:"(.*)"|([^('"\s]*))$/u.exec(line)
    if (match) values[match[1]] = expand(match[2] ?? match[3])
  }
  return { ...values, folder: expand(/cp -a "\$\{srcdir\}\/(.+?)\/\." /u.exec(text)[1]) }
}
const changedLines = (before, after) => {
  const a = before.split('\n'), b = after.split('\n')
  return b.filter((line, index) => line !== a[index])
}

describe('the Owl\'s pacman version', () => {
  it('drops the hyphen pacman cannot hold and maps back', () => {
    expect(owlLinuxPkgver(version)).toBe('0.1.38owl.20261021.1')
    expect(owlVersionFromPkgver('0.1.38owl.20261021.1')).toBe(version)
    for (const wrong of ['0.1.38', '0.1.38~owl.20261021.1', '0.1.38owl.20260230.1', '0.1.38owl.20261021.1-1']) expect(owlVersionFromPkgver(wrong)).toBeUndefined()
    for (const wrong of ['0.1.38', '0.1.38-owl.20260230.1', '0.1.38-owl.20261021.0']) expect(() => owlLinuxPkgver(wrong)).toThrow()
  })
  it('the vercmp port agrees with pacman\'s own documented order, tilde included', () => {
    const order = ['1.0a', '1.0b', '1.0beta', '1.0p', '1.0pre', '1.0rc', '1.0', '1.0.a', '1.0.1']
    for (let index = 1; index < order.length; index++) expect(pacmanVercmp(order[index - 1], order[index])).toBe(-1)
    expect(pacmanVercmp('1.0', '1.0')).toBe(0)
    // pacman has no pre-release marker, which is why the Owl's version cannot use a tilde.
    expect(pacmanVercmp('0.1.38~owl.20261021.1', '0.1.38')).toBe(1)
  })
  it.each(['0.1.38-owl.20261021.1', '0.1.38-owl.20261031.9', '1.0.0-owl.20261231.1', '2.10.1-owl.20270228.12'])('sorts %s where Owl and stable replace each other', owl => {
    const cases = owlPkgverOrderingCases(owl)
    expect(cases.length).toBeGreaterThanOrEqual(5)
    for (const { lower, higher } of cases) expect(pacmanVercmp(lower, higher)).toBe(-1)
    expect(() => checkOwlPkgverOrdering(owl, pacmanVercmp)).not.toThrow()
  })
  it('names each ordering the brief needs, with real next days', () => {
    const cases = Object.fromEntries(owlPkgverOrderingCases('0.1.38-owl.20261231.9').map(({ name, lower, higher }) => [name, [lower, higher]]))
    expect(cases).toEqual({
      'after the stable release before it': ['0.1.37', '0.1.38owl.20261231.9'],
      'before the stable release it previews': ['0.1.38owl.20261231.9', '0.1.38'],
      'before the next build that day': ['0.1.38owl.20261231.9', '0.1.38owl.20261231.10'],
      'build 10 after build 9': ['0.1.38owl.20261231.9', '0.1.38owl.20261231.10'],
      'before the next day\'s build': ['0.1.38owl.20261231.9', '0.1.38owl.20270101.1'],
      'stable before the next base\'s Owl': ['0.1.38', '0.1.39owl.20261231.1'],
    })
    expect(owlPkgverOrderingCases('1.0.0-owl.20261021.1').map(({ name }) => name)).not.toContain('after the stable release before it')
  })
  it('fails plainly, building nothing, when pacman sorts the version wrongly', () => {
    const tildeLike = (lower, higher) => pacmanVercmp(lower.replace('owl.', '~owl.'), higher.replace('owl.', '~owl.'))
    expect(() => checkOwlPkgverOrdering(version, tildeLike)).toThrow(/must come before 0\.1\.38 \(before the stable release it previews\).*Nothing was packaged/u)
  })
})

describe('Linux Owl package plan and receipts', () => {
  it('names an x64 Owl tarball, rebuilds natives and publishes on the Owl channel without touching shared keys', () => {
    const root = resolve('/sotto')
    const plan = owlLinuxPackagePlan(root, version)
    expect(plan.unpacked).toBe(resolve(root, 'release', 'linux-unpacked'))
    expect(plan.tarball).toBe(resolve(root, 'release', `Sotto-Owl-${version}-linux-x64.tar.gz`))
    expect(plan.receipt).toBe(resolve(root, 'release', 'owl-linux-package.json'))
    expect(plan.config).toEqual({
      extraMetadata: { version }, npmRebuild: true,
      linux: { artifactName: 'Sotto-Owl-${version}-linux-${arch}.${ext}' },
      publish: owlPublishConfig(), generateUpdatesFilesForAllChannels: false,
    })
    for (const shared of ['asarUnpack', 'files', 'extraResources', 'appId', 'productName', 'directories']) expect(plan.config).not.toHaveProperty(shared)
    expect(owlLinuxFileNames(version)).toMatchObject({
      tarballFolder: `Sotto-Owl-${version}-linux-x64`, pacman: 'sotto-bin-0.1.38owl.20261021.1-1-x86_64.pkg.tar.zst',
    })
  })
  it('writes a tarball receipt the pacman job and release:owl accept, and refuses one for another Owl', async () => {
    const root = await directory(), plan = owlLinuxPackagePlan(root, version)
    await mkdir(join(root, 'release')); await writeFile(plan.tarball, 'tarball bytes')
    const receipt = JSON.parse(JSON.stringify(await owlLinuxReceipt({ version, provenance: { sourceCommit, buildInputsRevision: inputs }, plan })))
    expect(receipt).toMatchObject({ kind: 'sotto-owl-linux-package', schemaVersion: 1, version, track: 'owl', platform: 'linux', arch: 'x64', sourceCommit, buildInputsRevision: inputs })
    expect(checkedOwlLinuxReceipt(receipt, { version, sourceCommit }).tarball).toMatchObject({ filename: owlLinuxFileNames(version).tarball, size: 13 })
    expect(() => checkedOwlLinuxReceipt({ ...receipt, version: '0.1.38-owl.20261021.2' }, { version, sourceCommit })).toThrow('not the Windows Owl')
    expect(() => checkedOwlLinuxReceipt({ ...receipt, sourceCommit: 'b'.repeat(40) }, { version, sourceCommit })).toThrow('different source commit')
    expect(() => checkedOwlLinuxReceipt({ ...receipt, arch: 'arm64' }, { version, sourceCommit })).toThrow('x64 Linux Owl')
    expect(() => checkedOwlLinuxReceipt({ ...receipt, files: { ...receipt.files, extra: receipt.files.tarball } }, { version, sourceCommit })).toThrow('nothing else')
    await expect(owlLinuxReceipt({ version, provenance: { sourceCommit: 'short', buildInputsRevision: inputs }, plan })).rejects.toThrow('full source commit')
  })
  it('writes a pacman receipt tied to the tarball it was built from', async () => {
    const root = await directory(), names = owlLinuxFileNames(version)
    const paths = { pacman: join(root, names.pacman), pkgbuild: join(root, 'PKGBUILD'), srcinfo: join(root, '.SRCINFO') }
    for (const path of Object.values(paths)) await writeFile(path, path)
    const tarball = { filename: names.tarball, size: 5, sha256: 'd'.repeat(64) }
    const receipt = await owlLinuxPacmanReceipt({ version, sourceCommit, tarball, paths })
    expect(receipt).toMatchObject({ kind: 'sotto-owl-linux-pacman', version, pkgver: names.pkgver, pkgrel: 1, sourceCommit, tarball: { filename: names.tarball, sha256: tarball.sha256 } })
    expect(checkedOwlLinuxPacmanReceipt(receipt, { version, sourceCommit, tarball }).map(file => file.role)).toEqual(['pacman', 'pkgbuild', 'srcinfo'])
    expect(() => checkedOwlLinuxPacmanReceipt(receipt, { version, sourceCommit, tarball: { ...tarball, sha256: 'e'.repeat(64) } })).toThrow('different tarball')
    expect(() => checkedOwlLinuxPacmanReceipt({ ...receipt, pkgver: '0.1.38~owl.20261021.1' }, { version, sourceCommit, tarball })).toThrow('pacman version')
    await writeFile(join(root, 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst'), 'stable')
    await expect(owlLinuxPacmanReceipt({ version, sourceCommit, tarball, paths: { ...paths, pacman: join(root, 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst') } })).rejects.toThrow('is not sotto-bin-0.1.38owl')
  })
  it('reads the version pacman records', () => {
    expect(pkginfoVersion('# Generated by makepkg\npkgname = sotto-bin\npkgver = 0.1.38owl.20261021.1-1\narch = x86_64\n')).toBe('0.1.38owl.20261021.1-1')
    expect(pkginfoVersion('pkgname = sotto-bin\n')).toBeUndefined()
    expect(pkginfoVersion('pkgver = 1-1\npkgver = 2-1\n')).toBeUndefined()
  })
  it('takes exactly the four arguments the workflow passes', () => {
    const args = ['--version', version, '--source', sourceCommit, '--tarball', 'owl-linux-tarball', '--out', 'owl-linux']
    expect(owlLinuxPacmanArguments(args)).toEqual({ version, sourceCommit, tarballFolder: 'owl-linux-tarball', out: 'owl-linux' })
    expect(() => owlLinuxPacmanArguments(args.slice(0, 6))).toThrow('Usage')
    expect(() => owlLinuxPacmanArguments([...args, '--extra', 'x'])).toThrow('Usage')
    expect(() => owlLinuxPacmanArguments(args.with(1, '0.1.38'))).toThrow('full Sotto Owl version')
    expect(() => owlLinuxPacmanArguments(args.with(3, 'abc'))).toThrow('full lower-case source commit')
  })
})

describe('the sotto-bin recipe for stable and for Owl', () => {
  it('still names stable\'s archive, download and folder after pkgver, exactly as before', () => {
    const stable = rewriteLinuxPkgbuild(recipe, '0.1.38', hashes)
    expect(expandRecipe(stable)).toMatchObject({
      pkgver: '0.1.38', _archive: 'Sotto-0.1.38-linux-x64.tar.gz', folder: 'Sotto-0.1.38-linux-x64',
      _source_url: 'https://github.com/millZach/Sotto-releases/releases/download/v0.1.38/Sotto-0.1.38-linux-x64.tar.gz',
    })
    // A stable rewrite changes only the version, release and checksums.
    expect(changedLines(recipe, stable).every(line => /^(pkgver=|pkgrel=|sha256sums=\(|\s+'[a-f0-9]{64}'\)?$)/u.test(line))).toBe(true)
  })
  it('names the Owl prerelease\'s tarball, download and folder, with the Owl\'s pacman version', () => {
    const owl = rewriteOwlLinuxPkgbuild(recipe, version, hashes)
    expect(expandRecipe(owl)).toMatchObject({
      pkgver: '0.1.38owl.20261021.1', _version: version,
      _archive: `Sotto-Owl-${version}-linux-x64.tar.gz`, folder: `Sotto-Owl-${version}-linux-x64`,
      _source_url: `https://github.com/millZach/Sotto-releases/releases/download/v${version}/Sotto-Owl-${version}-linux-x64.tar.gz`,
    })
    // Owl differs from stable only in the version lines; package() and the checksums are the same recipe.
    expect(changedLines(rewriteLinuxPkgbuild(recipe, '0.1.38', hashes), owl)).toEqual(['pkgver=0.1.38owl.20261021.1', `_version="${version}"`, `_archive_name="Sotto-Owl-${version}-linux-x64"`])
    expect(owl.slice(owl.indexOf('package()'))).toBe(recipe.slice(recipe.indexOf('package()')))
  })
  it('refuses a recipe whose names it cannot set, and versions for the other track', () => {
    expect(() => rewriteOwlLinuxPkgbuild(recipe.replace('_version="${pkgver}"', '_version="0.1.37"'), version, hashes)).toThrow('release version from pkgver')
    expect(() => rewriteOwlLinuxPkgbuild(`${recipe}\n_archive_name="Sotto-\${_version}-linux-x64"\n`, version, hashes)).toThrow('once each')
    expect(() => rewriteOwlLinuxPkgbuild(recipe, '0.1.38', hashes)).toThrow('full Sotto Owl version')
    expect(() => rewriteLinuxPkgbuild(recipe, version, hashes)).toThrow()
    expect(() => rewriteOwlLinuxPkgbuild(recipe, version, hashes.slice(1))).toThrow('Every Linux package source')
  })
})

describe('pacman package names', () => {
  it('matches stable and Owl packages and nothing else', () => {
    for (const name of ['sotto-bin-0.1.38-1-x86_64.pkg.tar.zst', 'sotto-bin-0.1.37-2-x86_64.pkg.tar.zst', 'sotto-bin-0.1.38owl.20261021.1-1-x86_64.pkg.tar.zst']) {
      expect(LINUX_PACMAN_PACKAGE.test(name)).toBe(true)
    }
    for (const name of ['sotto-bin-0.1.38~owl.20261021.1-1-x86_64.pkg.tar.zst', 'sotto-bin-0.1.38owl.2026.1-1-x86_64.pkg.tar.zst', 'other-0.1.38-1-x86_64.pkg.tar.zst', 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst.sig']) {
      expect(LINUX_PACMAN_PACKAGE.test(name)).toBe(false)
    }
    expect(LINUX_PACMAN_PACKAGE.test(owlLinuxFileNames(version).pacman)).toBe(true)
  })
  it('clears a leftover Owl package with stable finishing outputs, and keeps the Owl tarball', async () => {
    const root = await directory(), names = owlLinuxFileNames(version)
    for (const name of [names.pacman, names.tarball, 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst']) await writeFile(join(root, name), name)
    await clearLinuxFinishOutputs(root)
    await expect(readFile(join(root, names.pacman))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, names.tarball), 'utf8')).toBe(names.tarball)
  })
})
