// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_EXTERNAL_IMPORTS } from '../../../scripts/release-external-dependencies.mjs'
import { checkedOwlHostVersion, safeHostTarInventory, verifyOwlHostArtifact } from '../../../scripts/owl-host-artifacts.mjs'
import { owlHostArguments, packageOwlHost } from '../../../scripts/package-owl-host.mjs'
import { owlPublicationArguments, prepareOwlRelease } from '../../../scripts/release-owl.mjs'
import { hostArchiveUsageExpected } from '../../../scripts/smoke-host-archive.mjs'
import { sha256 } from '../../../scripts/verify-host-archive.mjs'
import { tarGz } from '../../fixtures/hostArchive'

const roots = [], sourceCommit = 'a'.repeat(40), version = '0.1.38-owl.20261012.10'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-owl-host-test-')); roots.push(root); return root }
function contents({ source = sourceCommit, dirty = false, packagedVersion = version, platform = process.platform, arch = process.arch, runtimeVersion = packagedVersion } = {}) {
  const dependencies = { zod: '4.4.3' }
  const files = {
    'package.json': JSON.stringify({ version: packagedVersion, type: 'commonjs', main: 'host/index.js', engines: { node: '>=24 <25' }, dependencies }),
    'runtime-manifest.json': JSON.stringify({ version: 1, kind: 'sotto-host', sottoVersion: runtimeVersion, node: '>=24 <25', dependencies, platform, arch }),
    'host/index.js': '/* deterministic fixture only */',
    'host/external-dependencies.json': JSON.stringify({ version: 1, scope: 'host', imports: HOST_EXTERNAL_IMPORTS, dynamicImports: [] }),
    'host/bundled-dependencies.json': JSON.stringify({ version: 1, packages: [] }),
    'node_modules/zod/package.json': JSON.stringify({ version: '4.4.3' }), 'node_modules/zod/LICENSE': 'MIT test fixture',
    'LICENSE.md': 'Sotto fixture', 'THIRD_PARTY_NOTICES.md': 'zod fixture',
  }
  const artifacts = Object.entries(files).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha256(value) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  files['build-provenance.json'] = JSON.stringify({ version: 1, sourceCommit: source, sourceDirty: dirty, buildInputsRevision: 'b'.repeat(64), builder: { platform, arch }, artifacts, buildSha256: sha256(JSON.stringify(artifacts)) })
  return files
}
async function archive(root, options = {}) {
  const name = `Sotto-host-${version}-${process.platform}-${process.arch}.tar.gz`, path = join(root, name)
  const bytes = tarGz(contents(options))
  await writeFile(path, bytes); await writeFile(path + '.sha256', `${sha256(bytes)}  ${name}\n`)
  return path
}

describe('explicit native Owl host package', () => {
  it('requires the full version and source and leaves stable commands intact', async () => {
    expect(owlHostArguments(['--version', version, '--source', sourceCommit])).toEqual({ version, sourceCommit })
    for (const value of ['1.0.0', '0.1.38-beta.1', '0.1.38-owl.20260229.1', '0.1.38-owl.20261012.0', '0.1.38-owl.20261012.01', '../' + version]) expect(() => checkedOwlHostVersion(value)).toThrow()
    expect(() => owlHostArguments(['--version', version])).toThrow('Usage')
    const { scripts } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(scripts['package:host:owl']).toBe('node scripts/package-owl-host.mjs')
    expect(scripts['package:host']).toBe('node scripts/package-host.mjs')
    expect(scripts['package:host:release']).toBe('node scripts/package-stable-host.mjs')
  })
  it('checks the clean source before and after packaging and records verified native bytes', async () => {
    const root = await directory(), checkout = vi.fn(() => ({ sourceCommit, clean: true }))
    const packageArchive = vi.fn(async () => archive(root)), writeReceipt = vi.fn(async () => undefined)
    const result = await packageOwlHost({ version, sourceCommit, checkout, packageArchive, releaseDir: root, writeReceipt })
    expect(packageArchive).toHaveBeenCalledExactlyOnceWith({ version, releaseDir: root })
    expect(checkout).toHaveBeenCalledTimes(3)
    expect(result.receipt).toMatchObject({ kind: 'sotto-owl-host', sottoVersion: version, sourceCommit, platform: process.platform, arch: process.arch })
    expect(writeReceipt).toHaveBeenCalledWith(result.archive + '.owl-receipt.json', result.receipt)
  })
  it.each([{ clean: false, sourceCommit }, { clean: true, sourceCommit: 'b'.repeat(40) }])('refuses an unreviewed checkout before packaging: %j', async checkoutState => {
    const root = await directory(), packageArchive = vi.fn()
    await expect(packageOwlHost({ version, sourceCommit, checkout: () => checkoutState, packageArchive, releaseDir: root })).rejects.toThrow('clean full source')
    expect(packageArchive).not.toHaveBeenCalled()
  })
  it('rejects source changes during packaging before issuing a receipt', async () => {
    const root = await directory(), writeReceipt = vi.fn()
    const checkout = vi.fn().mockReturnValueOnce({ sourceCommit, clean: true }).mockReturnValue({ sourceCommit: 'b'.repeat(40), clean: true })
    await expect(packageOwlHost({ version, sourceCommit, checkout, packageArchive: async () => archive(root), releaseDir: root, writeReceipt })).rejects.toThrow('clean full source')
    expect(writeReceipt).not.toHaveBeenCalled()
  })
  it('never replaces an existing versioned artifact', async () => {
    const root = await directory(); await archive(root)
    const packageArchive = vi.fn()
    await expect(packageOwlHost({ version, sourceCommit, checkout: () => ({ sourceCommit, clean: true }), packageArchive, releaseDir: root })).rejects.toThrow('already has an artifact')
    expect(packageArchive).not.toHaveBeenCalled()
  })
})

describe('host bytes accepted for the same Owl publication', () => {
  it('extracts and verifies bytes independently of any receipt, without comparing desktop and host input hashes', async () => {
    const path = await archive(await directory())
    expect(await verifyOwlHostArtifact(path, { version, sourceCommit })).toMatchObject({ version, sourceCommit, platform: process.platform, arch: process.arch })
  })
  it('accepts the native tar tool\'s directory and long-path metadata after safe inspection', async () => {
    const root = await directory(), stage = join(root, 'stage'); await mkdir(stage)
    const files = contents(); files[`node_modules/zod/${'long-path-'.repeat(16)}.js`] = 'long tar path fixture'
    const provenance = JSON.parse(files['build-provenance.json'])
    const artifacts = Object.entries(files).filter(([path]) => path !== 'build-provenance.json').map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha256(value) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
    files['build-provenance.json'] = JSON.stringify({ ...provenance, artifacts, buildSha256: sha256(JSON.stringify(artifacts)) })
    for (const [path, body] of Object.entries(files)) { await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), body) }
    const name = `Sotto-host-${version}-${process.platform}-${process.arch}.tar.gz`, path = join(root, name)
    execFileSync('tar', ['-czf', name, '-C', stage, '.'], { cwd: root, windowsHide: true })
    const bytes = await readFile(path); await writeFile(path + '.sha256', `${sha256(bytes)}  ${name}\n`)
    expect(await verifyOwlHostArtifact(path, { version, sourceCommit })).toMatchObject({ version, sourceCommit })
  })
  it.each([
    [{ source: 'b'.repeat(40) }, 'source does not match'], [{ dirty: true }, 'clean source'],
    [{ packagedVersion: '1.0.0' }, 'version does not match'], [{ runtimeVersion: '1.0.0' }, 'runtime manifest'],
    [{ platform: process.platform === 'linux' ? 'win32' : 'linux' }, 'platform does not match'],
  ])('refuses mismatched verified archive metadata: %j', async (options, message) => {
    const path = await archive(await directory(), options)
    await writeFile(path + '.owl-receipt.json', JSON.stringify({ sourceCommit, sottoVersion: version }))
    await expect(verifyOwlHostArtifact(path, { version, sourceCommit })).rejects.toThrow(message)
  })
  it('rejects a sidecar mismatch and a changed file even when the sidecar was regenerated', async () => {
    const root = await directory(), path = await archive(root)
    await writeFile(path + '.sha256', `${'b'.repeat(64)}  ${basename(path)}\n`)
    await expect(verifyOwlHostArtifact(path, { version, sourceCommit })).rejects.toThrow('sidecar')
    const files = contents(); files['host/index.js'] = 'changed after sealing'
    const bytes = tarGz(files)
    await writeFile(path, bytes); await writeFile(path + '.sha256', `${sha256(bytes)}  ${basename(path)}\n`)
    await expect(verifyOwlHostArtifact(path, { version, sourceCommit })).rejects.toThrow('hashes do not match')
  })
  it('rejects tar traversal, absolute paths, links and malformed checksums before extraction', () => {
    for (const path of ['../escape', '/absolute', 'C:/drive', 'host/../../escape', 'host\\escape']) expect(() => safeHostTarInventory(tarGz({ [path]: 'unsafe' }))).toThrow('unsafe path')
    const linked = gunzipSync(tarGz({ file: 'body' })); linked[156] = '2'.charCodeAt(0)
    linked.fill(32, 148, 156)
    const checksum = linked.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
    linked.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    expect(() => safeHostTarInventory(gzipSync(linked))).toThrow('regular files')
    const invalid = gunzipSync(tarGz({ file: 'body' })); invalid[0] ^= 1
    expect(() => safeHostTarInventory(gzipSync(invalid))).toThrow('checksum')
  })
})

describe('print-only Owl publication preparation', () => {
  async function fixture() {
    const root = await directory(); await mkdir(join(root, 'release'))
    for (const [path, body] of [[`Sotto-Owl-Setup-${version}.exe`, 'installer'], [`Sotto-Owl-Setup-${version}.exe.blockmap`, 'blockmap'], ['owl.yml', 'owl feed']]) await writeFile(join(root, 'release', path), body)
    // Real desktop provenance records sourceCommit and inputs, without the headless archive's sourceDirty field.
    const provenance = { sourceCommit, buildInputsRevision: 'desktop-inventory' }
    return { root, desktop: async () => ({ version, provenance, packagedProvenance: provenance }), checkout: () => ({ sourceCommit, clean: true }), inputsRevision: async () => 'desktop-inventory' }
  }
  it('preserves default preparation without hosts and accepts repeatable explicitly supplied archive paths', async () => {
    expect(owlPublicationArguments(['--host-archive', 'one', '--notes-file', 'notes', '--host-archive', 'two'])).toEqual({ notesFile: 'notes', hostArchives: ['one', 'two'] })
    const setup = await fixture(), result = await prepareOwlRelease({ rootDirectory: setup.root, ...setup })
    expect(result.files).toHaveLength(3); expect(result.sums).toHaveLength(3)
    expect(result.commands[0]).toContain('--prerelease --latest=false')
    expect(result.commands[0]).not.toContain('latest.yml')
    expect(result.commands[1]).toContain('SHA256SUMS.txt')
  })
  it('includes native archives and their exact sidecars on the same prerelease, hashes every asset and uploads sums last', async () => {
    const setup = await fixture(), path = await archive(join(setup.root, 'release'))
    const result = await prepareOwlRelease({ rootDirectory: setup.root, ...setup, args: ['--host-archive', path] })
    expect(result.files).toHaveLength(5); expect(result.sums).toHaveLength(5)
    expect(result.commands[0]).toContain(path); expect(result.commands[0]).toContain(path + '.sha256')
    expect(result.commands[0]).not.toContain('SHA256SUMS.txt')
    expect(result.commands[1]).toContain('release upload'); expect(result.commands[1]).toContain('SHA256SUMS.txt')
    expect(await readFile(join(setup.root, 'release', 'owl-notes.md'), 'utf8')).toContain(`Source commit: ${sourceCommit}`)
    expect((await readFile(join(setup.root, 'release', 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')).toEqual(result.sums)
    expect(await readFile(join(setup.root, 'release', 'owl.yml'), 'utf8')).toBe('owl feed')
  })
  it('rejects a receipt claiming matching source when archive bytes differ, before writing publication files', async () => {
    const setup = await fixture(), path = await archive(join(setup.root, 'release'), { source: 'b'.repeat(40) })
    await writeFile(path + '.owl-receipt.json', JSON.stringify({ sourceCommit, sottoVersion: version }))
    await expect(prepareOwlRelease({ rootDirectory: setup.root, ...setup, args: ['--host-archive', path] })).rejects.toThrow('source does not match')
    await expect(readFile(join(setup.root, 'release', 'owl-notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses duplicate assets and checkout changes during host verification', async () => {
    const setup = await fixture(), path = await archive(join(setup.root, 'release'))
    await expect(prepareOwlRelease({ rootDirectory: setup.root, ...setup, args: ['--host-archive', path, '--host-archive', path] })).rejects.toThrow('unique filename')
    const checkout = vi.fn().mockReturnValueOnce({ sourceCommit, clean: true }).mockReturnValue({ sourceCommit, clean: false })
    await expect(prepareOwlRelease({ rootDirectory: setup.root, ...setup, checkout, args: ['--host-archive', path] })).rejects.toThrow('clean source commit')
  })
  it('uses the one feature list so graduation changes stable smoke expectations too', async () => {
    const source = await readFile(new URL('../../../src/shared/owlFeatures.ts', import.meta.url), 'utf8')
    const held = source.replace(/(id: 'usage'[^\n]*sentToStable:) (?:false|true)/u, '$1 false')
    expect(await hostArchiveUsageExpected(version, held)).toBe(true)
    expect(await hostArchiveUsageExpected('0.1.38', held)).toBe(false)
    const graduated = held.replace(/(id: 'usage'[^\n]*sentToStable:) false/u, '$1 true')
    expect(await hostArchiveUsageExpected('0.1.38', graduated)).toBe(true)
  })
})
