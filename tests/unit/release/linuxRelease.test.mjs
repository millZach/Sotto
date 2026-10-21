// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkedLinuxPackage, linuxChecksumLines, linuxPackageSources, linuxReleaseArguments, requireCleanLinuxCheckout, rewriteLinuxPkgbuild } from '../../../scripts/linux-release.mjs'

const recipe = await readFile(new URL('../../../apps/omarchy/PKGBUILD', import.meta.url), 'utf8')
const sources = ['sotto', 'sotto.desktop', 'install.sh', 'sotto-48.png', 'sotto-128.png', 'sotto-256.png']
const hashes = ['a', 'b', 'c', 'd', 'e', 'f', '0'].map(character => character.repeat(64))
const sourceCommit = 'a'.repeat(40)
const checkout = { sourceCommit, clean: true }
const receipt = { sourceCommit, version: '0.1.38', rehearsal: true, tarball: 'release/Sotto-0.1.38-linux-x64.tar.gz', sha256: hashes[0] }
const check = { checkout, version: '0.1.38', rehearsal: true, sha256: hashes[0] }

describe('Linux release mode and source', () => {
  it('keeps stable as the default and requires an explicit base version for rehearsal', () => {
    expect(linuxReleaseArguments([])).toEqual({ rehearsal: false })
    expect(linuxReleaseArguments(['--rehearse', '0.1.38'])).toEqual({ rehearsal: true, version: '0.1.38' })
    for (const args of [['--rehearse'], ['0.1.38'], ['--rehearse', '0.1.38', 'extra'], ['--rehearse', '0.1.38-owl.20261013.1'], ['--rehearse', '../../outside']]) {
      expect(() => linuxReleaseArguments(args)).toThrow()
    }
  })
  it('accepts only the same clean source, version, mode and verified tarball', () => {
    expect(checkedLinuxPackage(receipt, check).target).toBe('tar.gz')
    expect(() => checkedLinuxPackage(receipt, { ...check, checkout: { ...checkout, clean: false } })).toThrow('clean commit')
    expect(() => checkedLinuxPackage(receipt, { ...check, checkout: { ...checkout, sourceCommit: 'b'.repeat(40) } })).toThrow('checkout changed')
    for (const change of [{ version: '0.1.39' }, { rehearsal: false }, { sha256: hashes[1] }]) {
      expect(() => checkedLinuxPackage(receipt, { ...check, ...change })).toThrow('does not match')
    }
    expect(() => checkedLinuxPackage({ ...receipt, tarball: '../other.tar.gz' }, check)).toThrow('does not match')
    expect(() => requireCleanLinuxCheckout({ ...checkout, clean: false })).toThrow('clean commit')
  })
})

describe('Linux recipe and checksums', () => {
  it('updates the stable version, resets pkgrel and refreshes every source hash without editing package()', () => {
    expect(linuxPackageSources(recipe)).toEqual(sources)
    const updated = rewriteLinuxPkgbuild(recipe.replace('pkgrel=1', 'pkgrel=4'), '0.1.38', hashes)
    expect(updated).toContain('pkgver=0.1.38\npkgrel=1\n')
    expect(updated.match(/'[a-f0-9]{64}'/gu)).toEqual(hashes.map(hash => `'${hash}'`))
    expect(updated.slice(updated.indexOf('package()'))).toBe(recipe.slice(recipe.indexOf('package()')))
    // Stable's release version is pkgver; only a Sotto Owl build sets it apart (owlLinuxPackage.test.mjs).
    expect(updated).toContain('_version="${pkgver}"\n_archive_name="Sotto-${_version}-linux-x64"\n_archive="${_archive_name}.tar.gz"\n')
    expect(updated).toContain('https://github.com/millZach/Sotto-releases/releases/download/v${_version}/${_archive}')
  })
  it('refuses missing fields, unchecked hashes and source expressions it cannot hash', () => {
    expect(() => rewriteLinuxPkgbuild(recipe, '0.1.38', hashes.slice(1))).toThrow('Every Linux package source')
    expect(() => rewriteLinuxPkgbuild(recipe, '0.1.38', ['SKIP', ...hashes.slice(1)])).toThrow('Every Linux package source')
    expect(() => rewriteLinuxPkgbuild(recipe.replace(/^pkgver=.*\n/mu, ''), '0.1.38', hashes)).toThrow('one pkgver')
    expect(() => rewriteLinuxPkgbuild(`${recipe}\npkgrel=2\n`, '0.1.38', hashes)).toThrow('one pkgver')
    expect(() => linuxPackageSources(recipe.replace("'sotto.desktop'", "'../sotto.desktop'"))).toThrow('local filenames')
    expect(() => linuxPackageSources(recipe.replace("'sotto.desktop'", '${extra_sources[@]}'))).toThrow('source list changed')
  })
  it('writes the two distributable lines with lower-case hex, two spaces and final newlines', () => {
    expect(linuxChecksumLines([
      { name: 'Sotto-0.1.38-linux-x64.tar.gz', sha256: 'A'.repeat(64) },
      { name: 'sotto-bin-0.1.38-1-x86_64.pkg.tar.zst', sha256: hashes[1] },
    ])).toBe(`${hashes[0]}  Sotto-0.1.38-linux-x64.tar.gz\n${hashes[1]}  sotto-bin-0.1.38-1-x86_64.pkg.tar.zst\n`)
    for (const entry of [{ name: '../archive', sha256: hashes[0] }, { name: 'archive\nother', sha256: hashes[0] }, { name: 'archive', sha256: 'SKIP' }]) {
      expect(() => linuxChecksumLines([entry])).toThrow('Checksum lines')
    }
  })
})
