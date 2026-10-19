// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { checkedOwlMacReceipt, extractMacAppAsar, owlMacFileNames, verifyOwlMacArtifacts, zipReadingTar } from '../../../scripts/owl-mac-artifacts.mjs'
import { owlMacPackagePlan, owlMacReceipt } from '../../../scripts/owl-mac-package.mjs'
import { defaultOwlNotes } from '../../../scripts/owl-publication.mjs'
import { owlPublicationArguments, prepareOwlRelease } from '../../../scripts/release-owl.mjs'
import { sha256 } from '../../../scripts/verify-host-archive.mjs'

const roots = [], sourceCommit = 'a'.repeat(40), version = '0.1.38-owl.20261019.1', macInputs = 'c'.repeat(64)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'sotto-owl-mac-test-')); roots.push(root); return root }

/**
 * An app.asar carrying the provenance and manifest a packaged Mac Owl would, written in one call. @electron/asar's
 * createPackage resolves before its stream finishes writing, so a fixture built with it can be read half-written.
 */
async function appAsar(destination, { source = sourceCommit, packagedVersion = version, inputs = macInputs } = {}) {
  const provenance = Buffer.from(JSON.stringify({ version: 2, sourceCommit: source, buildInputsRevision: inputs, buildSha256: 'd'.repeat(64), artifacts: [] }))
  const manifest = Buffer.from(JSON.stringify({ name: 'sotto', version: packagedVersion }))
  const header = Buffer.from(JSON.stringify({ files: {
    out: { files: { 'build-provenance.json': { size: provenance.length, offset: '0' } } },
    'package.json': { size: manifest.length, offset: String(provenance.length) },
  } }))
  // Two Chromium pickles: the first holds the second's size, the second the header string padded to four bytes.
  const headerPickle = Buffer.alloc(8 + Math.ceil(header.length / 4) * 4)
  headerPickle.writeUInt32LE(headerPickle.length - 4, 0); headerPickle.writeUInt32LE(header.length, 4); header.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.concat([sizePickle, headerPickle, provenance, manifest]))
}
const asarAt = into => join(into, 'Sotto.app', 'Contents', 'Resources', 'app.asar')
/** Stands in for bsdtar on runners whose tar cannot read zip files. */
const fakeExtract = options => async (_zip, into) => appAsar(asarAt(into), options)

/** The folder `gh run download` leaves: the receipt and every file it lists. */
async function macFolder({ receipt: change = receipt => receipt, blockmaps = true, zipBytes = 'zip bytes' } = {}) {
  const root = await directory(), folder = join(root, 'mac'); await mkdir(folder)
  const names = owlMacFileNames(version)
  const bodies = { dmg: 'disk image bytes', zip: zipBytes, updateManifest: `version: ${version}\n` }
  if (blockmaps) Object.assign(bodies, { dmgBlockmap: 'dmg blockmap', zipBlockmap: 'zip blockmap' })
  const files = {}
  for (const [role, body] of Object.entries(bodies)) {
    await writeFile(join(folder, names[role]), body)
    const bytes = await readFile(join(folder, names[role]))
    files[role] = { filename: names[role], size: bytes.length, sha256: sha256(bytes) }
  }
  const receipt = change({ kind: 'sotto-owl-mac-package', schemaVersion: 1, version, track: 'owl', platform: 'darwin', arch: 'arm64', sourceCommit, buildInputsRevision: macInputs, files })
  await writeFile(join(folder, 'owl-mac-package.json'), JSON.stringify(receipt))
  return { root, folder, names }
}

describe('Mac Owl files from the workflow run', () => {
  it('accepts the receipt\'s files when their bytes and the zip\'s app match, attaching all but the update manifest', async () => {
    const { folder, names } = await macFolder()
    const result = await verifyOwlMacArtifacts(folder, { version, sourceCommit }, { extractAsar: fakeExtract() })
    expect(result).toMatchObject({ version, sourceCommit, buildInputsRevision: macInputs })
    expect(result.files.filter(file => file.attach).map(file => file.filename).sort()).toEqual([names.dmg, names.dmgBlockmap, names.zip, names.zipBlockmap].sort())
    expect(result.files.find(file => file.filename === 'owl-mac.yml')).toMatchObject({ attach: false })
    const blockmapless = await macFolder({ blockmaps: false })
    expect((await verifyOwlMacArtifacts(blockmapless.folder, { version, sourceCommit }, { extractAsar: fakeExtract() })).files).toHaveLength(3)
  })
  it.each([
    [receipt => ({ ...receipt, version: '0.1.38-owl.20261019.2' }), 'not the Windows Owl'],
    [receipt => ({ ...receipt, sourceCommit: 'b'.repeat(40) }), 'different source commit'],
    [receipt => ({ ...receipt, arch: 'x64' }), 'Apple silicon'],
    [receipt => ({ ...receipt, files: { ...receipt.files, extra: receipt.files.dmg } }), 'unexpected file'],
    [receipt => { const files = { ...receipt.files }; delete files.zip; return { ...receipt, files } }, 'does not list the zip'],
    [receipt => ({ ...receipt, files: { ...receipt.files, dmg: { ...receipt.files.dmg, filename: '../escape.dmg' } } }), 'invalid entry'],
  ])('refuses a receipt that does not describe this Owl (%#)', async (change, message) => {
    const { folder } = await macFolder({ receipt: change })
    await expect(verifyOwlMacArtifacts(folder, { version, sourceCommit }, { extractAsar: fakeExtract() })).rejects.toThrow(message)
  })
  it('refuses bytes that differ from the receipt and files the receipt does not list', async () => {
    const changed = await macFolder()
    await writeFile(join(changed.folder, changed.names.dmg), 'disk image byteZ')
    await expect(verifyOwlMacArtifacts(changed.folder, { version, sourceCommit }, { extractAsar: fakeExtract() })).rejects.toThrow('does not match the Mac Owl receipt')
    const extra = await macFolder()
    await writeFile(join(extra.folder, 'notes.txt'), 'stray')
    await expect(verifyOwlMacArtifacts(extra.folder, { version, sourceCommit }, { extractAsar: fakeExtract() })).rejects.toThrow('only the files its receipt lists')
  })
  it.each([
    [{ source: 'b'.repeat(40) }, 'different source commit'],
    [{ packagedVersion: '0.1.38' }, 'not 0.1.38-owl'],
    [{ inputs: 'e'.repeat(64) }, 'build inputs differ'],
  ])('refuses a zip whose packaged app disagrees: %j', async (options, message) => {
    const { folder } = await macFolder()
    await expect(verifyOwlMacArtifacts(folder, { version, sourceCommit }, { extractAsar: fakeExtract(options) })).rejects.toThrow(message)
  })
  it('names the Owl version, not a host version, when the version it joins is not a full Owl version', async () => {
    const { folder } = await macFolder()
    for (const wrong of ['0.1.38', '0.1.38-owl.20260229.1']) {
      const failure = await verifyOwlMacArtifacts(folder, { version: wrong, sourceCommit }, { extractAsar: fakeExtract() }).catch(error => error)
      expect(failure.message).toMatch(/^Supply (the full|a) Sotto Owl version/u)
      expect(failure.message).not.toContain('host')
    }
  })
  it('hashes and extracts its own copy of the zip, in a folder it removes', async () => {
    const { folder, names } = await macFolder()
    let copy
    const extractAsar = async (zip, into) => {
      copy = zip
      expect(dirname(dirname(zip))).toBe(resolve(tmpdir())); expect(basename(dirname(zip))).toMatch(/^sotto-owl-mac-verify-/u)
      expect(await readFile(zip, 'utf8')).toBe('zip bytes')
      // A replacement in the downloaded folder now cannot reach what is checked.
      await writeFile(join(folder, names.zip), 'replaced during the check')
      await appAsar(asarAt(into))
    }
    const result = await verifyOwlMacArtifacts(folder, { version, sourceCommit }, { extractAsar })
    expect(result.files.find(file => file.role === 'zip').sha256).toBe(sha256('zip bytes'))
    await expect(lstat(dirname(copy))).rejects.toMatchObject({ code: 'ENOENT' })
    const failing = await macFolder()
    await expect(verifyOwlMacArtifacts(failing.folder, { version, sourceCommit }, { extractAsar: async zip => { copy = zip; throw new Error('tar failed') } })).rejects.toThrow('tar failed')
    await expect(lstat(dirname(copy))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks the receipt on its own terms', () => {
    const files = Object.fromEntries(['dmg', 'zip', 'updateManifest'].map(role => [role, { filename: owlMacFileNames(version)[role], size: 1, sha256: 'f'.repeat(64) }]))
    const receipt = { kind: 'sotto-owl-mac-package', schemaVersion: 1, version, track: 'owl', platform: 'darwin', arch: 'arm64', sourceCommit, buildInputsRevision: macInputs, files }
    expect(checkedOwlMacReceipt(receipt, { version, sourceCommit }).files.map(file => file.role)).toEqual(['dmg', 'zip', 'updateManifest'])
    expect(() => checkedOwlMacReceipt({ ...receipt, track: 'stable' }, { version, sourceCommit })).toThrow('Apple silicon Owl')
    expect(() => checkedOwlMacReceipt({ ...receipt, files: { ...files, zip: { ...files.zip, size: 0 } } }, { version, sourceCommit })).toThrow('invalid entry')
  })
  it('reads the receipt package:owl writes on the Mac', async () => {
    const root = await directory(), plan = owlMacPackagePlan(root, version)
    await mkdir(join(root, 'release'))
    for (const path of [plan.dmg, plan.zip, plan.zipBlockmap, plan.updateManifest]) await writeFile(path, basename(path))
    const receipt = await owlMacReceipt({ version, provenance: { sourceCommit, buildInputsRevision: macInputs }, plan })
    expect(checkedOwlMacReceipt(JSON.parse(JSON.stringify(receipt)), { version, sourceCommit }).files.map(file => file.role).sort()).toEqual(['dmg', 'updateManifest', 'zip', 'zipBlockmap'])
  })
  it('names libarchive\'s tar, which reads zip files, on Windows and macOS', () => {
    expect(zipReadingTar('win32', { SystemRoot: 'D:\\Windows' })).toBe(join('D:\\Windows', 'System32', 'tar.exe'))
    expect(zipReadingTar('darwin', {})).toBe('/usr/bin/tar')
  })
  // Linux runners carry GNU tar, which cannot read zip files; there the extractor is injected above.
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('extracts only app.asar from a real zip and refuses anything beside Sotto.app', async () => {
    const tar = zipReadingTar(), root = await directory(), stage = join(root, 'stage')
    await appAsar(asarAt(stage))
    await writeFile(join(stage, 'Sotto.app', 'Contents', 'Info.plist'), '<plist/>')
    execFileSync(tar, ['-a', '-cf', 'app.zip', '-C', 'stage', 'Sotto.app'], { cwd: root, windowsHide: true })
    const zipBytes = await readFile(join(root, 'app.zip'))
    const { folder } = await macFolder({ zipBytes })
    expect(await verifyOwlMacArtifacts(folder, { version, sourceCommit })).toMatchObject({ version, sourceCommit })
    const into = join(root, 'into'); await mkdir(into)
    await extractMacAppAsar(join(root, 'app.zip'), into)
    expect(await readdir(join(into, 'Sotto.app', 'Contents'), { recursive: true })).toEqual(['Resources', join('Resources', 'app.asar')])
    await writeFile(join(stage, 'stray.txt'), 'beside the app')
    execFileSync(tar, ['-a', '-cf', 'stray.zip', '-C', 'stage', 'Sotto.app', 'stray.txt'], { cwd: root, windowsHide: true })
    await expect(extractMacAppAsar(join(root, 'stray.zip'), into)).rejects.toThrow('only Sotto.app')
  })
})

describe('Owl publication with the Mac files', () => {
  async function fixture() {
    const mac = await macFolder(), release = join(mac.root, 'release'); await mkdir(release)
    for (const [path, body] of [[`Sotto-Owl-Setup-${version}.exe`, 'installer'], [`Sotto-Owl-Setup-${version}.exe.blockmap`, 'blockmap'], ['owl.yml', 'owl feed']]) await writeFile(join(release, path), body)
    // The Windows checkout's build-input revision differs from the Mac runner's; only source and version must agree.
    const provenance = { sourceCommit, buildInputsRevision: 'windows-inventory' }
    return { ...mac, rootDirectory: mac.root, desktop: async () => ({ version, provenance, packagedProvenance: provenance }), checkout: () => ({ sourceCommit, clean: true }),
      inputsRevision: async () => 'windows-inventory', verifyMac: (folder, expected) => verifyOwlMacArtifacts(folder, expected, { extractAsar: fakeExtract() }) }
  }
  it('takes the downloaded folder once', () => {
    expect(owlPublicationArguments(['--mac-artifacts', 'mac', '--host-archive', 'one'])).toEqual({ notesFile: undefined, hostArchives: ['one'], macArtifacts: 'mac' })
    expect(() => owlPublicationArguments(['--mac-artifacts', 'one', '--mac-artifacts', 'two'])).toThrow('Usage')
    expect(() => owlPublicationArguments(['--mac-artifacts'])).toThrow('Supply a path')
  })
  it('attaches the disk image, zip and blockmaps to the same prerelease, never the Mac update feed, after printing attestation checks', async () => {
    const setup = await fixture(), result = await prepareOwlRelease({ ...setup, args: ['--mac-artifacts', 'mac'] })
    const attached = [setup.names.dmg, setup.names.dmgBlockmap, setup.names.zip, setup.names.zipBlockmap]
    for (const name of attached) expect(result.files.some(file => file.endsWith(name))).toBe(true)
    expect(result.files.some(file => file.endsWith('owl-mac.yml'))).toBe(false)
    expect(result.files).toHaveLength(7); expect(result.sums).toHaveLength(7)
    expect(result.sums.some(line => line.endsWith('  owl-mac.yml'))).toBe(false)
    expect((await readFile(join(setup.root, 'release', 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')).toEqual(result.sums)
    // Windows PowerShell carries on after a failed native command, so each check stops the pasted commands itself.
    const stop = "; if ($LASTEXITCODE -ne 0) { throw 'The Mac Owl build attestation did not verify. Nothing was published.' }"
    expect(result.commands[0]).toBe(`gh attestation verify '${join(setup.folder, setup.names.dmg)}' --repo millZach/Sotto${stop}`)
    expect(result.commands[1]).toBe(`gh attestation verify '${join(setup.folder, setup.names.zip)}' --repo millZach/Sotto${stop}`)
    expect(result.commands[2]).toContain('gh release create'); expect(result.commands[2]).toContain('--prerelease --latest=false')
    expect(result.commands[2]).toContain(setup.names.dmg); expect(result.commands[2]).not.toContain('owl-mac.yml')
    const notes = await readFile(join(setup.root, 'release', 'owl-notes.md'), 'utf8')
    expect(notes).toContain('Windows and Apple silicon Macs'); expect(notes).toContain('Open Anyway')
    expect(notes).toContain('xattr -dr com.apple.quarantine /Applications/Sotto.app'); expect(notes).toContain(`Source commit: ${sourceCommit}`)
  })
  it('keeps the Windows notes and commands when no Mac files are supplied', async () => {
    const setup = await fixture(), result = await prepareOwlRelease(setup)
    expect(result.commands[0]).toContain('gh release create'); expect(result.commands.join('\n')).not.toContain('attestation')
    expect(await readFile(join(setup.root, 'release', 'owl-notes.md'), 'utf8')).toBe(`${defaultOwlNotes()}\n\nSource commit: ${sourceCommit}\n`)
    expect(defaultOwlNotes()).not.toContain('Mac')
  })
  it('refuses Mac files for another version or source before writing publication files', async () => {
    for (const change of [receipt => ({ ...receipt, version: '0.1.38-owl.20261019.2' }), receipt => ({ ...receipt, sourceCommit: 'b'.repeat(40) })]) {
      const setup = { ...await fixture() }
      const other = await macFolder({ receipt: change })
      await expect(prepareOwlRelease({ ...setup, args: ['--mac-artifacts', other.folder] })).rejects.toThrow('Mac Owl receipt')
      await expect(readFile(join(setup.root, 'release', 'owl-notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('refuses a Mac file that changes after its verification', async () => {
    const setup = await fixture()
    const verifyMac = async (folder, expected) => {
      const verified = await setup.verifyMac(folder, expected)
      await writeFile(join(folder, setup.names.zip), 'replaced after verification')
      return verified
    }
    await expect(prepareOwlRelease({ ...setup, verifyMac, args: ['--mac-artifacts', 'mac'] })).rejects.toThrow('changed after its release verification')
  })
})
