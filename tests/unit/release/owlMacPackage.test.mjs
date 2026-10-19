// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkOwlMacUpdateManifest, compareAppTrees, owlMacPackagePlan, owlMacReceipt, owlPublishConfig, updateFileInfo, verifyOwlMacArchive,
} from '../../../scripts/owl-mac-package.mjs'

const version = '0.1.38-owl.20261013.1'
let temporary
beforeEach(async () => { temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-mac-test-')) })
afterEach(async () => { await rm(temporary, { recursive: true, force: true }) })

async function app(root, overrides = {}) {
  const files = { 'Contents/Info.plist': 'plist', 'Contents/MacOS/Sotto': 'binary', 'Contents/Resources/app.asar': 'asar', ...overrides }
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

describe('Mac Owl package plan', () => {
  it('names the disk image and zip without spaces and publishes on the Owl channel', () => {
    const root = resolve(temporary)
    const plan = owlMacPackagePlan(root, version)
    expect(plan.dmg).toBe(resolve(root, 'release', `Sotto-Owl-${version}-arm64.dmg`))
    expect(plan.zip).toBe(resolve(root, 'release', `Sotto-Owl-${version}-arm64-mac.zip`))
    expect(plan.dmgBlockmap).toBe(`${plan.dmg}.blockmap`)
    expect(plan.zipBlockmap).toBe(`${plan.zip}.blockmap`)
    expect(plan.updateManifest).toBe(resolve(root, 'release', 'owl-mac.yml'))
    expect(plan.receipt).toBe(resolve(root, 'release', 'owl-mac-package.json'))
    expect(plan.unpacked).toBe(resolve(root, 'release', 'mac-arm64'))
    expect(plan.config).toEqual({
      extraMetadata: { version },
      npmRebuild: true,
      dmg: { artifactName: 'Sotto-Owl-${version}-${arch}.${ext}' },
      mac: { artifactName: 'Sotto-Owl-${version}-${arch}-mac.${ext}' },
      publish: { provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl', releaseType: 'prerelease' },
      generateUpdatesFilesForAllChannels: false,
    })
    expect(owlPublishConfig()).not.toBe(owlPublishConfig())
  })
  it('leaves the ad-hoc identity to electron-builder.yml until signing is supplied', () => {
    expect(owlMacPackagePlan(temporary, version).config.mac).not.toHaveProperty('identity')
    const signed = owlMacPackagePlan(temporary, version, { signing: { identity: 'Developer ID Application: Example', notarize: true, hardenedRuntime: true } })
    expect(signed.config.mac).toEqual({ artifactName: 'Sotto-Owl-${version}-${arch}-mac.${ext}', identity: 'Developer ID Application: Example', notarize: true, hardenedRuntime: true })
  })
})

describe('Mac Owl update manifest', () => {
  const zip = { url: `Sotto-Owl-${version}-arm64-mac.zip`, sha512: 'zip-sha', size: 10 }
  const dmg = { url: `Sotto-Owl-${version}-arm64.dmg`, sha512: 'dmg-sha', size: 20 }
  const manifest = (overrides = {}) => ({ version, files: [{ ...zip }, { ...dmg }], path: zip.url, sha512: zip.sha512, releaseDate: '2026-10-13T00:00:00Z', ...overrides })
  it('accepts the zip first, the disk image after it and the legacy fields on the zip', () => {
    expect(() => checkOwlMacUpdateManifest(manifest(), version, { zip, dmg })).not.toThrow()
    expect(() => checkOwlMacUpdateManifest(manifest({ files: [{ ...zip }], path: undefined, sha512: undefined }), version, { zip, dmg })).not.toThrow()
  })
  it.each([
    ['another version', manifest({ version: '0.1.38-owl.20261013.2' })],
    ['the disk image first', manifest({ files: [{ ...dmg }, { ...zip }] })],
    ['no files', manifest({ files: [] })],
    ['a changed zip', manifest({ files: [{ ...zip, sha512: 'other' }, { ...dmg }] })],
    ['a resized zip', manifest({ files: [{ ...zip, size: 11 }, { ...dmg }] })],
    ['a changed disk image', manifest({ files: [{ ...zip }, { ...dmg, sha512: 'other' }] })],
    ['an unknown file', manifest({ files: [{ ...zip }, { url: 'other.zip', sha512: 'x', size: 1 }] })],
    ['a repeated file', manifest({ files: [{ ...zip }, { ...zip }] })],
    ['a legacy path on the disk image', manifest({ path: dmg.url })],
    ['a legacy hash of another file', manifest({ sha512: dmg.sha512 })],
  ])('refuses %s', (_, candidate) => {
    expect(() => checkOwlMacUpdateManifest(candidate, version, { zip, dmg })).toThrow('does not match the verified zip')
  })
  it('records the file name, SHA-512 in base64 and size the way electron-builder does', async () => {
    const path = join(temporary, 'Sotto-Owl.zip')
    await writeFile(path, 'zip bytes')
    expect(await updateFileInfo(path)).toEqual({ url: 'Sotto-Owl.zip', sha512: createHash('sha512').update('zip bytes').digest('base64'), size: 9 })
  })
})

describe('Mac Owl zip check', () => {
  it('accepts an identical app and counts what it compared', async () => {
    const expected = await app(join(temporary, 'expected'))
    const actual = await app(join(temporary, 'actual'))
    expect(await compareAppTrees(expected, actual)).toEqual({ files: 3, directories: 3, symlinks: 0 })
  })
  it.each([
    ['a changed file', { 'Contents/Resources/app.asar': 'other' }, 'differs Contents/Resources/app.asar'],
    ['a missing file', { 'Contents/Info.plist': null }, 'missing Contents/Info.plist'],
    ['an extra file', { 'Contents/Resources/extra.txt': 'extra' }, 'extra Contents/Resources/extra.txt'],
  ])('refuses %s', async (_, overrides, problem) => {
    const expected = await app(join(temporary, 'expected'))
    const actual = await app(join(temporary, 'actual'), overrides)
    await expect(compareAppTrees(expected, actual)).rejects.toThrow(problem)
  })
  it.skipIf(process.platform === 'win32')('compares symlink targets, as a framework bundle has them', async () => {
    const expected = await app(join(temporary, 'expected'))
    const actual = await app(join(temporary, 'actual'))
    await symlink('MacOS', join(expected, 'Contents', 'Current'))
    await symlink('MacOS', join(actual, 'Contents', 'Current'))
    expect(await compareAppTrees(expected, actual)).toEqual({ files: 3, directories: 3, symlinks: 1 })
    await rm(join(actual, 'Contents', 'Current'))
    await symlink('Resources', join(actual, 'Contents', 'Current'))
    await expect(compareAppTrees(expected, actual)).rejects.toThrow('differs Contents/Current')
  })
  it('unpacks into its own folder, requires only Sotto.app and removes the folder', async () => {
    const unpacked = join(temporary, 'mac-arm64')
    await app(join(unpacked, 'Sotto.app'))
    let into
    const extract = async (archive, folder) => { into = folder; expect(archive).toBe('owl.zip'); await cp(join(unpacked, 'Sotto.app'), join(folder, 'Sotto.app'), { recursive: true }) }
    expect(await verifyOwlMacArchive('owl.zip', unpacked, { extract })).toEqual({ files: 3, directories: 3, symlinks: 0 })
    await expect(lstat(into)).rejects.toThrow('ENOENT')
    const extra = async (archive, folder) => { await extract(archive, folder); await writeFile(join(folder, 'README'), 'x') }
    await expect(verifyOwlMacArchive('owl.zip', unpacked, { extract: extra })).rejects.toThrow('only Sotto.app')
    const changed = async (archive, folder) => { await extract(archive, folder); await writeFile(join(folder, 'Sotto.app', 'Contents', 'MacOS', 'Sotto'), 'other') }
    await expect(verifyOwlMacArchive('owl.zip', unpacked, { extract: changed })).rejects.toThrow('differs Contents/MacOS/Sotto')
  })
})

describe('Mac Owl receipt', () => {
  const provenance = { version: 2, sourceCommit: 'c'.repeat(40), buildInputsRevision: 'd'.repeat(64), buildSha256: 'e'.repeat(64), artifacts: [] }
  const entry = (filename, content) => ({ filename, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') })
  async function outputs({ blockmaps }) {
    const plan = owlMacPackagePlan(temporary, version)
    await mkdir(resolve(temporary, 'release'), { recursive: true })
    const contents = { dmg: 'disk image', zip: 'zip', updateManifest: 'version: x\n', ...(blockmaps ? { dmgBlockmap: 'dmg map', zipBlockmap: 'zip map' } : {}) }
    for (const [key, content] of Object.entries(contents)) await writeFile(plan[key], content)
    return { plan, contents }
  }
  it('records the source, build inputs and every produced file with its size and SHA-256', async () => {
    const { plan, contents } = await outputs({ blockmaps: true })
    const receipt = await owlMacReceipt({ version, provenance, plan })
    expect(receipt).toEqual({
      kind: 'sotto-owl-mac-package', schemaVersion: 1, version, track: 'owl', platform: 'darwin', arch: 'arm64',
      sourceCommit: provenance.sourceCommit, buildInputsRevision: provenance.buildInputsRevision,
      files: {
        dmg: entry(`Sotto-Owl-${version}-arm64.dmg`, contents.dmg),
        dmgBlockmap: entry(`Sotto-Owl-${version}-arm64.dmg.blockmap`, contents.dmgBlockmap),
        zip: entry(`Sotto-Owl-${version}-arm64-mac.zip`, contents.zip),
        zipBlockmap: entry(`Sotto-Owl-${version}-arm64-mac.zip.blockmap`, contents.zipBlockmap),
        updateManifest: entry('owl-mac.yml', contents.updateManifest),
      },
    })
  })
  it('leaves out blockmaps that were not produced', async () => {
    const { plan } = await outputs({ blockmaps: false })
    expect(Object.keys((await owlMacReceipt({ version, provenance, plan })).files)).toEqual(['dmg', 'zip', 'updateManifest'])
  })
  it('refuses a missing artifact or an incomplete provenance', async () => {
    const { plan } = await outputs({ blockmaps: false })
    await expect(owlMacReceipt({ version, provenance: { ...provenance, sourceCommit: 'abc' }, plan })).rejects.toThrow('full source commit')
    await expect(owlMacReceipt({ version, provenance: { ...provenance, buildInputsRevision: undefined }, plan })).rejects.toThrow('build-input revision')
    await rm(plan.zip)
    await expect(owlMacReceipt({ version, provenance, plan })).rejects.toThrow()
  })
})
