// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkedFullOwlVersion, checkedOwlVersion, checkOwlSource, digestFile, owlBuildArguments, owlPublishConfig, resolveOwlVersion } from '../../../scripts/owl-release.mjs'

describe('Owl build version', () => {
  it('uses the next stable patch and an explicit daily number', () => {
    expect(resolveOwlVersion('0.1.37', '20261013', '1')).toBe('0.1.38-owl.20261013.1')
    expect(resolveOwlVersion('0.1.36', '20261011', '1')).toBe('0.1.37-owl.20261011.1')
    expect(resolveOwlVersion('0.1.36', '20261011', '10')).toBe('0.1.37-owl.20261011.10')
    expect(resolveOwlVersion('1.2.99', '20261012', '2')).toBe('1.2.100-owl.20261012.2')
  })
  it.each(['0.1.34-owl.20261011.1', '0.1', '01.1.34'])('refuses a non-stable base %s', base => {
    expect(() => resolveOwlVersion(base, '20261011', '1')).toThrow('plain stable')
  })
  it.each(['20260229', '20261301', '2026109'])('refuses an invalid date %s', date => {
    expect(() => resolveOwlVersion('0.1.36', date, '1')).toThrow('UTC build date')
  })
  it.each([undefined, '0', '01', '-1', '1.5'])('refuses an invalid daily number %s', number => {
    expect(() => resolveOwlVersion('0.1.36', '20261011', number)).toThrow('daily build number')
  })
  it('defaults the UTC date while accepting a date override', () => {
    expect(owlBuildArguments(['--number', '2'], '20261011')).toEqual({ date: '20261011', number: '2' })
    expect(owlBuildArguments(['--date', '20261012', '--number', '1'])).toEqual({ date: '20261012', number: '1' })
  })
  it.each([['--foo', '1'], ['--number'], ['--number', '1', '--number', '2']])('refuses ambiguous arguments %s', (...args) => {
    expect(() => owlBuildArguments(args)).toThrow('Usage')
  })
})

const sha = 'a'.repeat(40)

describe('pinned Owl build', () => {
  it('takes the date and number from a full Owl version and requires its source', () => {
    expect(owlBuildArguments(['--version', '0.1.38-owl.20261013.2', '--source', sha], '20261099'))
      .toEqual({ date: '20261013', number: '2', version: '0.1.38-owl.20261013.2', sourceCommit: sha })
    expect(owlBuildArguments(['--source', sha, '--version', '0.1.38-owl.20261013.2']).sourceCommit).toBe(sha)
  })
  it.each([
    [['--version', '0.1.38-owl.20261013.1']],
    [['--source', sha]],
    [['--version', '0.1.38-owl.20261013.1', '--source', sha, '--number', '1']],
    [['--version', '0.1.38-owl.20261013.1', '--source', sha, '--date', '20261013']],
    [['--version', '0.1.38-owl.20261013.1', '--version', '0.1.38-owl.20261013.1', '--source', sha]],
  ])('refuses a half or mixed pin %s', args => {
    expect(() => owlBuildArguments(args)).toThrow('Usage')
  })
  it.each(['0.1.38', '0.1.38-owl.2026101.1', 'v0.1.38-owl.20261013.1', '0.1.38-owl.20261013'])('refuses a version that is not a full Owl version %s', version => {
    expect(() => owlBuildArguments(['--version', version, '--source', sha])).toThrow('full Owl version')
  })
  it.each(['A'.repeat(40), 'a'.repeat(39), 'abc1234', `${'a'.repeat(40)}0`])('refuses a source that is not a full lower-case commit %s', source => {
    expect(() => owlBuildArguments(['--version', '0.1.38-owl.20261013.1', '--source', source])).toThrow('full lower-case source commit')
  })
  it('builds a pinned version only when it is the next Owl of the manifest', () => {
    const pinned = version => owlBuildArguments(['--version', version, '--source', sha])
    expect(checkedOwlVersion('0.1.37', pinned('0.1.38-owl.20261013.1'))).toBe('0.1.38-owl.20261013.1')
    expect(() => checkedOwlVersion('0.1.36', pinned('0.1.38-owl.20261013.1'))).toThrow('not a build of this checkout')
    expect(() => checkedOwlVersion('0.1.38', pinned('0.1.38-owl.20261013.1'))).toThrow('not a build of this checkout')
    expect(() => checkedOwlVersion('0.1.37', pinned('0.1.038-owl.20261013.1'))).toThrow('not a build of this checkout')
    expect(() => checkedOwlVersion('0.1.37', pinned('0.1.38-owl.20261301.1'))).toThrow('UTC build date')
    expect(() => checkedOwlVersion('0.1.37', pinned('0.1.38-owl.20261013.01'))).toThrow('daily build number')
  })
  it('leaves a daily build to its date and number', () => {
    expect(checkedOwlVersion('0.1.37', owlBuildArguments(['--number', '3'], '20261014'))).toBe('0.1.38-owl.20261014.3')
  })
  it('requires a clean checkout at the pinned commit, and nothing of a daily build', () => {
    expect(() => checkOwlSource(sha, { sourceCommit: sha, clean: true })).not.toThrow()
    expect(() => checkOwlSource(sha, { sourceCommit: sha, clean: false })).toThrow('clean checkout')
    expect(() => checkOwlSource(sha, { sourceCommit: 'b'.repeat(40), clean: true })).toThrow('not the requested Owl source')
    expect(() => checkOwlSource(undefined, { sourceCommit: 'b'.repeat(40), clean: false })).not.toThrow()
  })
})

describe('What the Windows and Mac Owl share', () => {
  it('publishes both on the Owl channel of the releases repository as a prerelease', () => {
    expect(owlPublishConfig()).toEqual({ provider: 'github', owner: 'millZach', repo: 'Sotto-releases', channel: 'owl', releaseType: 'prerelease' })
    // electron-builder merges into the object it is given, so each build gets its own.
    expect(owlPublishConfig()).not.toBe(owlPublishConfig())
  })
  it("checks a full Owl version in the caller's words", () => {
    const messages = { form: 'Supply the whole version', date: 'Supply a real day' }
    expect(checkedFullOwlVersion('0.1.38-owl.20261013.1', messages)).toBe('0.1.38-owl.20261013.1')
    for (const value of [undefined, '1.0.0', '0.1.38-beta.1', '0.1.38-owl.20261012.0', '0.1.38-owl.20261012.01', '../0.1.38-owl.20261013.1']) {
      expect(() => checkedFullOwlVersion(value, messages)).toThrow('Supply the whole version')
    }
    expect(() => checkedFullOwlVersion('0.1.38-owl.20260229.1', messages)).toThrow('Supply a real day')
  })
  it('hashes a file by streaming it and counts the bytes it hashed', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sotto-owl-digest-test-'))
    try {
      const path = join(folder, 'file.bin'), bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 7)
      await writeFile(path, bytes)
      expect(await digestFile(path)).toEqual({ digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
      expect(await digestFile(path, { algorithm: 'sha512', encoding: 'base64' })).toEqual({ digest: createHash('sha512').update(bytes).digest('base64'), size: bytes.length })
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
})
