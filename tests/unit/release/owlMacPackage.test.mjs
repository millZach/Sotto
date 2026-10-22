// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  checkOwlMacUpdateManifest, compareAppTrees, isSignedAndNotarized, OWL_MAC_SIGNING_ENVIRONMENT, owlMacPackagePlan, owlMacReceipt, owlMacSigning,
  updateFileInfo, verifyOwlMacArchive, verifyOwlMacSignature,
} from '../../../scripts/owl-mac-package.mjs'
import { owlPublishConfig } from '../../../scripts/owl-release.mjs'

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
    expect(plan.app).toBe(resolve(root, 'release', 'mac-arm64', 'Sotto.app'))
    expect(plan.config).toEqual({
      extraMetadata: { version },
      npmRebuild: true,
      forceCodeSigning: true,
      dmg: { artifactName: 'Sotto-Owl-${version}-${arch}.${ext}' },
      mac: { artifactName: 'Sotto-Owl-${version}-${arch}-mac.${ext}' },
      publish: { provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl', releaseType: 'prerelease' },
      generateUpdatesFilesForAllChannels: false,
    })
    // The Mac plan takes the publisher the Windows Owl uses, not a copy of its own.
    expect(plan.config.publish).toEqual(owlPublishConfig())
  })
  it('merges the signing override into the mac section and forces code signing', () => {
    const signing = owlMacSigning(signingEnvironment())
    const plan = owlMacPackagePlan(temporary, version, { signing })
    expect(plan.config.mac).toEqual({ artifactName: 'Sotto-Owl-${version}-${arch}-mac.${ext}', ...signing })
    // electron-builder fails rather than leaving the app unsigned when it cannot find the identity.
    expect(plan.config.forceCodeSigning).toBe(true)
  })
})

const identity = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'
function signingEnvironment(overrides = {}) {
  return { CSC_KEYCHAIN: '/runner/temp/sotto-owl-signing.keychain-db', SOTTO_OWL_MAC_IDENTITY: identity,
    APPLE_API_KEY: '/runner/temp/sotto-owl-signing/AuthKey.p8', APPLE_API_KEY_ID: 'KEY1234567', APPLE_API_ISSUER: 'issuer-uuid', ...overrides }
}

describe('Mac Owl signing override', () => {
  it('signs with the keychain identity, the hardened runtime and the entitlements stable already names, and notarizes', async () => {
    const stable = parse(await readFile(resolve(import.meta.dirname, '../../../electron-builder.yml'), 'utf8')).mac
    expect(owlMacSigning(signingEnvironment())).toEqual({
      identity, hardenedRuntime: true, notarize: true, entitlements: stable.entitlements, entitlementsInherit: stable.entitlementsInherit,
    })
    // Stable's own Mac section stays ad-hoc, without the hardened runtime (ADR-0001).
    expect(stable.identity).toBe('-')
    expect(stable.hardenedRuntime).toBe(false)
    expect(stable).not.toHaveProperty('notarize')
  })
  it.each(OWL_MAC_SIGNING_ENVIRONMENT)('refuses to build without %s, naming it', name => {
    expect(() => owlMacSigning(signingEnvironment({ [name]: '' }))).toThrow(new RegExp(`has no ${name}.*Nothing was packaged`, 'u'))
  })
  it('names every missing credential and where they live', () => {
    expect(() => owlMacSigning({})).toThrow(`has no ${OWL_MAC_SIGNING_ENVIRONMENT.join(', ')}`)
    expect(() => owlMacSigning({})).toThrow('docs/release/macos-owl-signing.md')
  })
  it('refuses an identity that is not a certificate hash', () => {
    expect(() => owlMacSigning(signingEnvironment({ SOTTO_OWL_MAC_IDENTITY: 'Developer ID Application: Example (ABCDE12345)' }))).toThrow('40-character SHA-1')
  })
  it.each(['CSC_LINK', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN_PROFILE'])('refuses %s, which would sign or notarize another way', name => {
    expect(() => owlMacSigning(signingEnvironment({ [name]: 'set' }))).toThrow(`Unset ${name}`)
  })
})

describe('Mac Owl signature check', () => {
  const app = '/build/release/mac-arm64/Sotto.app'
  const outputs = {
    verify: `${app}: valid on disk\n${app}: satisfies its Designated Requirement\n`,
    display: [
      `Executable=${app}/Contents/MacOS/Sotto`, 'Identifier=com.sotto.desktop', 'Format=app bundle with Mach-O thin (arm64)',
      'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded',
      'Authority=Developer ID Application: Zach Knudsen (ABCDE12345)', 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA',
      'Timestamp=20 Oct 2026 at 10:00:00', 'Notarization Ticket=stapled', 'TeamIdentifier=ABCDE12345', 'Runtime Version=15.0.0',
    ].join('\n'),
    assess: `${app}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Zach Knudsen (ABCDE12345)\n`,
    staple: `Processing: ${app}\nThe validate action worked!\n`,
  }
  function tools(changes = {}) {
    const calls = []
    const run = async (file, args) => {
      calls.push([file, ...args])
      const key = file.endsWith('spctl') ? 'assess' : file.endsWith('xcrun') ? 'staple' : args[0] === '--verify' ? 'verify' : 'display'
      const output = changes[key] ?? outputs[key]
      if (output instanceof Error) throw output
      return output
    }
    return { run, calls }
  }
  it('runs codesign, Gatekeeper and the stapler on the app and records what the receipt needs', async () => {
    const { run, calls } = tools()
    expect(await verifyOwlMacSignature(app, { run })).toEqual({ identity: 'Developer ID Application', teamId: 'ABCDE12345', hardenedRuntime: true, notarized: true, stapled: true })
    expect(calls).toEqual([
      ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', app],
      ['/usr/bin/codesign', '--display', '--verbose=4', app],
      ['/usr/sbin/spctl', '--assess', '--type', 'execute', '-vvv', app],
      ['/usr/bin/xcrun', 'stapler', 'validate', app],
    ])
  })
  it.each([
    ['an ad-hoc signature', { display: outputs.display.replace(/^Authority=.*$/gmu, '').replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=not set') }, 'not signed by a Developer ID Application'],
    ['a signer from another team', { display: outputs.display.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=ZZZZZ99999') }, 'a team other than'],
    ['no hardened runtime', { display: outputs.display.replace('flags=0x10000(runtime)', 'flags=0x0(none)') }, 'without the hardened runtime'],
    ['a Gatekeeper rejection', { assess: `${app}: rejected\nsource=Unnotarized Developer ID\n` }, 'not accepted by Gatekeeper'],
    ['a Developer ID app that is not notarized', { assess: `${app}: accepted\nsource=Developer ID\n` }, 'not accepted by Gatekeeper'],
    ['no stapled ticket', { staple: `Processing: ${app}\n${app} does not have a ticket stapled to it.\n` }, 'no notarization ticket'],
  ])('refuses %s', async (_, changes, message) => {
    await expect(verifyOwlMacSignature(app, tools(changes))).rejects.toThrow(message)
  })
  it('stops at the first tool that fails', async () => {
    const { run, calls } = tools({ verify: new Error('codesign --verify refused the Mac Owl: a sealed resource is missing or invalid. Nothing was published.') })
    await expect(verifyOwlMacSignature(app, { run })).rejects.toThrow('sealed resource')
    expect(calls).toHaveLength(1)
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
    const failing = async (archive, folder) => { into = folder; throw new Error('ditto failed') }
    await expect(verifyOwlMacArchive('owl.zip', unpacked, { extract: failing })).rejects.toThrow('ditto failed')
    await expect(lstat(into)).rejects.toThrow('ENOENT')
  })
})

describe('Mac Owl receipt', () => {
  const provenance = { version: 2, sourceCommit: 'c'.repeat(40), buildInputsRevision: 'd'.repeat(64), buildSha256: 'e'.repeat(64), artifacts: [] }
  const signing = { identity: 'Developer ID Application', teamId: 'ABCDE12345', hardenedRuntime: true, notarized: true, stapled: true }
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
    const receipt = await owlMacReceipt({ version, provenance, plan, signing })
    expect(receipt).toEqual({
      kind: 'sotto-owl-mac-package', schemaVersion: 2, version, track: 'owl', platform: 'darwin', arch: 'arm64',
      sourceCommit: provenance.sourceCommit, buildInputsRevision: provenance.buildInputsRevision, signing,
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
    expect(Object.keys((await owlMacReceipt({ version, provenance, plan, signing })).files)).toEqual(['dmg', 'zip', 'updateManifest'])
  })
  it('refuses a missing artifact or an incomplete provenance', async () => {
    const { plan } = await outputs({ blockmaps: false })
    await expect(owlMacReceipt({ version, provenance: { ...provenance, sourceCommit: 'abc' }, plan, signing })).rejects.toThrow('full source commit')
    await expect(owlMacReceipt({ version, provenance: { ...provenance, buildInputsRevision: undefined }, plan, signing })).rejects.toThrow('build-input revision')
    await rm(plan.zip)
    await expect(owlMacReceipt({ version, provenance, plan, signing })).rejects.toThrow()
  })
  it('is written only for a build that is signed, notarized and stapled', async () => {
    const { plan } = await outputs({ blockmaps: false })
    for (const unsigned of [undefined, { ...signing, notarized: false }, { ...signing, stapled: false }, { ...signing, hardenedRuntime: false },
      { ...signing, identity: '-' }, { ...signing, teamId: 'not set' }]) {
      expect(isSignedAndNotarized(unsigned)).toBe(false)
      await expect(owlMacReceipt({ version, provenance, plan, signing: unsigned })).rejects.toThrow('signed, notarized and stapled')
    }
    expect(isSignedAndNotarized(signing)).toBe(true)
  })
})
