// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { decideStablePromotion, newestOwlRelease, publishedCheckRuns, publishedReleases, releaseCheckout } from '../../../scripts/stable-promotion.mjs'
import { checkedPromotion, stablePackagePlan } from '../../../scripts/stable-package.mjs'
import { checkRelease, stableReleaseArguments } from '../../../scripts/check-release.mjs'
import { owlPublication } from '../../../scripts/owl-publication.mjs'
import { cleanStableCheckout as checkout, successfulStableChecks as checks, sourceCommit, stableReleaseRecord } from '../../fixtures/stableReleaseFixture.mjs'

const release = (overrides = {}) => ({ tag_name: 'v0.1.37', draft: false, prerelease: false, published_at: '2026-10-11T12:00:00Z', ...overrides })

describe('Stable from main', () => {
  it('uses the next source patch without any Owl release, independently of feed order', () => {
    const feed = [release({ tag_name: 'v0.1.39', draft: true }), release({ tag_name: 'v0.1.36', prerelease: true }),
      release({ tag_name: 'v9.0.0-owl.20261013.1' }), release(), release({ tag_name: 'speech-model-parakeet-1' })]
    expect(decideStablePromotion(feed, checkout, checks)).toEqual(stableReleaseRecord)
    expect(decideStablePromotion([], checkout, checks)).toMatchObject({ stableVersion: '0.1.38', latestStableVersion: null })
  })
  it('requires a clean main commit', () => {
    expect(() => decideStablePromotion([], { ...checkout, clean: false }, checks)).toThrow('uncommitted changes')
    expect(() => decideStablePromotion([], { ...checkout, onMain: false }, checks)).toThrow('is not on origin/main')
    expect(() => decideStablePromotion([], { ...checkout, mainCommit: null }, checks)).toThrow('is not on origin/main')
  })
  it('checks real Git main membership, dirty files and a branch-only commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-stable-checkout-'))
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    try {
      git(['init']); git(['config', 'user.name', 'Release test']); git(['config', 'user.email', 'release@example.test'])
      await writeFile(join(root, 'package.json'), '{"version":"0.1.37"}\n'); git(['add', '.']); git(['commit', '-m', 'Initial'])
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      expect(releaseCheckout(root)).toMatchObject({ onMain: true, clean: true, sourceVersion: '0.1.37' })
      await writeFile(join(root, 'pending.txt'), 'pending')
      expect(releaseCheckout(root).clean).toBe(false)
      git(['add', '.']); git(['commit', '-m', 'Branch only'])
      expect(releaseCheckout(root)).toMatchObject({ onMain: false, clean: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['failure', 'cancelled', 'skipped', 'neutral', null])('refuses a required check concluded %s', conclusion => {
    expect(() => decideStablePromotion([], checkout, [{ ...checks[0], conclusion }, checks[1]])).toThrow('has not succeeded')
  })
  it('refuses missing, pending, foreign-app and wrong-commit CI; a newer red retry wins', () => {
    expect(() => decideStablePromotion([], checkout, [null])).toThrow('unreadable')
    for (const candidate of [checks.slice(1), [{ ...checks[0], head_sha: 'b'.repeat(40) }, checks[1]],
      [{ ...checks[0], app: { slug: 'other-app' } }, checks[1]]]) {
      expect(() => decideStablePromotion([], checkout, candidate)).toThrow('is missing')
    }
    expect(() => decideStablePromotion([], checkout, [{ ...checks[0], status: 'in_progress' }, checks[1]])).toThrow('has not succeeded')
    expect(() => decideStablePromotion([], checkout, [...checks, { ...checks[0], id: 10, conclusion: 'failure' }])).toThrow('has not succeeded')
  })
  it('accepts an explicit newer version and compares numbers, including superseded stable prereleases', () => {
    expect(decideStablePromotion([release()], checkout, checks, '0.2.0')).toMatchObject({ stableVersion: '0.2.0', explicitVersion: true })
    expect(decideStablePromotion([release({ tag_name: 'v0.1.9' })], checkout, checks, '0.1.10').stableVersion).toBe('0.1.10')
    for (const version of ['0.1.36', '0.1.37']) expect(() => decideStablePromotion([release({ prerelease: true })], checkout, checks, version)).toThrow('not newer')
    expect(() => decideStablePromotion([release({ tag_name: 'v0.1.38' })], checkout, checks)).toThrow('not newer')
    for (const version of ['01.1.38', '0.1', '0.1.38-owl.20261013.1', '9007199254740992.0.0']) {
      expect(() => decideStablePromotion([], checkout, checks, version)).toThrow('plain stable')
    }
  })
  it('parses only an optional explicit stable version', () => {
    expect(stableReleaseArguments([])).toEqual({})
    expect(stableReleaseArguments(['--version', '0.1.38'])).toEqual({ version: '0.1.38' })
    for (const args of [['--version'], ['0.1.38'], ['--version', '0.1.38', '--version', '0.1.39']]) expect(() => stableReleaseArguments(args)).toThrow('Usage')
  })
  it('records successful live Git eligibility and invalidates the record after any failed check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-stable-record-'))
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    let fetchSpy
    try {
      git(['init']); git(['config', 'user.name', 'Release test']); git(['config', 'user.email', 'release@example.test'])
      await writeFile(join(root, '.gitignore'), 'release/\n')
      await writeFile(join(root, 'package.json'), '{"version":"0.1.37"}\n'); git(['add', '.']); git(['commit', '-m', 'Initial'])
      git(['branch', '-M', 'main']); git(['remote', 'add', 'origin', root]); git(['fetch', 'origin', 'main'])
      const actualCommit = git(['rev-parse', 'HEAD'])
      let ci = checks.map(check => ({ ...check, head_sha: actualCommit }))
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => ({ ok: true,
        json: async () => String(url).includes('/check-runs?') ? { check_runs: ci } : [release()],
      }))
      const recordPath = join(root, 'release/stable-promotion.json')
      const record = await checkRelease({ root })
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(record)
      expect(record).toMatchObject({ sourceCommit: actualCommit, stableVersion: '0.1.38', checkedAt: expect.any(String) })
      for (const bad of [[], [{ ...ci[0], conclusion: 'failure' }, ci[1]]]) {
        ci = bad
        await expect(checkRelease({ root })).rejects.toThrow(/CI check/u)
        await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      ci = checks.map(check => ({ ...check, head_sha: actualCommit }))
      await expect(checkRelease({ root, version: '0.1.37' })).rejects.toThrow('not newer')
      await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
      // Source changes while waiting for the public APIs must not earn a record.
      fetchSpy.mockImplementation(async url => {
        await writeFile(join(root, 'pending.txt'), 'changed during check')
        return { ok: true, json: async () => String(url).includes('/check-runs?') ? { check_runs: ci } : [release()] }
      })
      await expect(checkRelease({ root })).rejects.toThrow('uncommitted changes')
      await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { fetchSpy?.mockRestore(); await rm(root, { recursive: true, force: true }) }
  })
  it('reads paginated public releases and check runs without credentials', async () => {
    const feed = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 100 }, () => release()) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
    expect(await publishedReleases(feed)).toHaveLength(100)
    expect(feed.mock.calls[1][0]).toContain('page=2')
    const ci = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ check_runs: Array.from({ length: 100 }, () => ({ name: 'unrelated' })) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ check_runs: checks }) })
    expect(await publishedCheckRuns(sourceCommit, ci)).toHaveLength(102)
    expect(ci.mock.calls[1][0]).toBe(`https://api.github.com/repos/millZach/Sotto/commits/${sourceCommit}/check-runs?filter=latest&per_page=100&page=2`)
    for (const call of [feed.mock.calls[0], ci.mock.calls[0]]) expect(call[1].headers).not.toHaveProperty('Authorization')
  })
  it('refuses network, rate limit, HTTP and malformed response failures plainly', async () => {
    for (const read of [publishedReleases, fetcher => publishedCheckRuns(sourceCommit, fetcher)]) {
      await expect(read(async () => { throw new Error('secret upstream prose') })).rejects.toThrow('Check your connection')
      for (const status of [403, 429]) await expect(read(async () => ({ ok: false, status }))).rejects.toThrow('rate limit')
      await expect(read(async () => ({ ok: false, status: 500 }))).rejects.toThrow('HTTP 500')
      await expect(read(async () => ({ ok: true, json: async () => { throw new SyntaxError() } }))).rejects.toThrow('unreadable')
      await expect(read(async () => ({ ok: true, json: async () => ({}) }))).rejects.toThrow('did not return')
    }
  })
})

describe('Stable package and Owl publication plans', () => {
  it('overrides stable metadata and output names on Windows, Mac and Linux', () => {
    expect(stablePackagePlan('win', '0.1.38')).toMatchObject({ installer: 'release/Sotto Setup 0.1.38.exe', target: 'nsis', config: { extraMetadata: { version: '0.1.38' } } })
    expect(stablePackagePlan('mac', '0.1.38')).toMatchObject({ installer: 'release/Sotto-0.1.38-arm64.dmg', target: 'dmg', config: { extraMetadata: { version: '0.1.38' }, npmRebuild: true } })
    expect(stablePackagePlan('linux', '0.1.38')).toEqual({ platform: 'linux', target: 'tar.gz', unpacked: 'release/linux-unpacked', installer: 'release/Sotto-0.1.38-linux-x64.tar.gz', config: { extraMetadata: { version: '0.1.38' }, npmRebuild: true } })
    expect(() => stablePackagePlan('win', '0.1.37-owl.20261011.1')).toThrow('plain stable')
  })
  it('rechecks saved source, version, main membership and CI evidence, refusing old Owl records', () => {
    expect(checkedPromotion(stableReleaseRecord, checkout)).toEqual(stableReleaseRecord)
    expect(() => checkedPromotion(stableReleaseRecord, { ...checkout, clean: false })).toThrow('uncommitted changes')
    expect(() => checkedPromotion(stableReleaseRecord, { ...checkout, onMain: false })).toThrow('not on origin/main')
    expect(() => checkedPromotion(stableReleaseRecord, { ...checkout, sourceVersion: '0.1.39' })).toThrow('does not match')
    expect(() => checkedPromotion({ ...stableReleaseRecord, stableVersion: '0.1.99' }, checkout)).toThrow('does not match')
    expect(() => checkedPromotion({ ...stableReleaseRecord, latestStableVersion: 'garbage' }, checkout)).toThrow('does not match')
    expect(() => checkedPromotion({ ...stableReleaseRecord, checks: checks.slice(1) }, checkout)).toThrow('is missing')
    expect(() => checkedPromotion({ owlVersion: '0.1.38-owl.20261013.1', stableVersion: '0.1.38', sourceCommit }, checkout)).toThrow('outdated')
  })
  it('keeps newest Owl selection and source publication independent of stable eligibility', () => {
    const owl = release({ tag_name: 'v0.1.37-owl.20261011.1' })
    expect(newestOwlRelease([release(), owl])).toBe(owl)
    const publication = owlPublication('0.1.37-owl.20261011.1', { sourceCommit }, 'Preview notes')
    expect(publication.title).toBe('Sotto Owl 0.1.37-owl.20261011.1 (aaaaaaaaaaaa)')
    expect(publication.body).toBe(`Preview notes\n\nSource commit: ${sourceCommit}\n`)
    expect(() => owlPublication('0.1.37-owl.20261011.1', {}, 'Preview')).toThrow('full source commit')
    expect(() => owlPublication('0.1.37-owl.20261011.1', { sourceCommit }, `Preview\nSource commit: ${'b'.repeat(40)}`)).toThrow('out of custom notes')
  })
  it('keeps nonrelease package commands offline and routes stable commands through fresh checks', async () => {
    const { scripts } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(scripts['package:win']).toBe('node scripts/package-stable.mjs win')
    expect(scripts['package:mac']).toBe('node scripts/package-stable.mjs mac')
    expect(scripts['package:linux:stable']).toBe('node scripts/package-stable.mjs linux')
    for (const name of ['package:dir', 'package:dir:mac', 'package:linux']) expect(scripts[name]).not.toMatch(/release:check|package-stable/u)
  })
})
