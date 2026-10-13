// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { decideStablePromotion, newestOwlRelease, publishedReleases } from '../../../scripts/stable-promotion.mjs'
import { checkedPromotion, stablePackagePlan } from '../../../scripts/stable-package.mjs'
import { owlPublication } from '../../../scripts/owl-publication.mjs'

const sourceCommit = 'a'.repeat(40)
const checkout = { sourceCommit, clean: true }
const release = (overrides = {}) => ({ id: 2, tag_name: 'v0.1.37-owl.20261011.1', body: `Preview\n\nSource commit: ${sourceCommit}\n`,
  draft: false, prerelease: true, published_at: '2026-10-11T12:00:00Z', ...overrides })

describe('Stable promotion', () => {
  it('uses the newest published Owl, ignoring newer stable and drafts regardless of feed order', () => {
    const newest = release()
    const feed = [release({ id: 4, tag_name: 'v0.1.37', published_at: '2026-10-12T12:00:00Z' }), newest,
      release({ id: 8, draft: true, published_at: '2026-10-13T12:00:00Z' }), release({ id: 1, published_at: '2026-10-10T12:00:00Z' })]
    expect(newestOwlRelease(feed)).toBe(newest)
    expect(decideStablePromotion(feed, checkout)).toEqual({ owlVersion: '0.1.37-owl.20261011.1', stableVersion: '0.1.37', sourceCommit })
  })
  it('requires exactly the commit named by the newest build', () => {
    expect(() => decideStablePromotion([release()], { ...checkout, sourceCommit: 'b'.repeat(40) })).toThrow(`Check out ${sourceCommit}, the commit Sotto Owl 0.1.37-owl.20261011.1 carried, or publish an Owl build of this commit first.`)
  })
  it('requires a clean tree even at the promoted commit', () => {
    expect(() => decideStablePromotion([release()], { ...checkout, clean: false })).toThrow('uncommitted changes')
  })
  it('does not infer Owl 1 source from its tag target or use older source records', () => {
    const unnamed = release({ body: 'First Owl', target_commitish: sourceCommit })
    expect(() => decideStablePromotion([unnamed, release({ published_at: '2026-10-10T12:00:00Z' })], checkout)).toThrow('names no single full source commit')
  })
  it.each(['', 'Source commit: abc123', `Source commit: ${sourceCommit}\nSource commit: ${'b'.repeat(40)}`, `Source commit: ${'a'.repeat(39)}`, `Source commit: ${sourceCommit}extra`])('refuses missing, short or ambiguous sources: %s', body => {
    expect(() => decideStablePromotion([release({ body })], checkout)).toThrow('full source commit')
  })
  it('refuses no Owl and a malformed newest Owl tag', () => {
    expect(() => decideStablePromotion([], checkout)).toThrow('No published Sotto Owl')
    expect(() => decideStablePromotion([release({ tag_name: 'v0.1.37-owl.bad' })], checkout)).toThrow('invalid Owl version')
  })
  it('reads a paginated public feed without a token or gh credentials', async () => {
    const fetchFeed = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => Array.from({ length: 100 }, () => release({ tag_name: 'v0.1.36' })) })
      .mockResolvedValueOnce({ ok: true, json: async () => [release()] })
    expect(decideStablePromotion(await publishedReleases(fetchFeed), checkout).stableVersion).toBe('0.1.37')
    expect(fetchFeed).toHaveBeenCalledTimes(2)
    expect(fetchFeed.mock.calls[1][0]).toBe('https://api.github.com/repos/millZach/Sotto-releases/releases?per_page=100&page=2')
    expect(fetchFeed.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  })
  it('refuses network and HTTP failures plainly', async () => {
    await expect(publishedReleases(async () => { throw new Error('secret upstream prose') })).rejects.toThrow('Check your connection')
    await expect(publishedReleases(async () => ({ ok: false, status: 403 }))).rejects.toThrow('HTTP 403')
  })
})

describe('Stable package and Owl publication plans', () => {
  it('packages the Owl base as stable metadata and names outputs with it on Windows and Mac', () => {
    expect(stablePackagePlan('win', '0.1.37')).toMatchObject({ installer: 'release/Sotto Setup 0.1.37.exe', target: 'nsis', config: { extraMetadata: { version: '0.1.37' } } })
    expect(stablePackagePlan('mac', '0.1.37')).toMatchObject({ installer: 'release/Sotto-0.1.37-arm64.dmg', target: 'dmg', config: { extraMetadata: { version: '0.1.37' }, npmRebuild: true } })
    expect(stablePackagePlan('linux', '0.1.38')).toEqual({ platform: 'linux', target: 'tar.gz', unpacked: 'release/linux-unpacked', installer: 'release/Sotto-0.1.38-linux-x64.tar.gz', config: { extraMetadata: { version: '0.1.38' }, npmRebuild: true } })
    expect(() => stablePackagePlan('win', '0.1.37-owl.20261011.1')).toThrow('base version')
  })
  it('rechecks the source and cleanliness before using the saved promotion', () => {
    const promotion = decideStablePromotion([release()], checkout)
    expect(checkedPromotion(promotion, checkout)).toEqual(promotion)
    expect(() => checkedPromotion(promotion, { ...checkout, clean: false })).toThrow('uncommitted changes')
    expect(() => checkedPromotion({ ...promotion, stableVersion: '0.1.99' }, checkout)).toThrow('does not match')
  })
  it('takes publication source from provenance and includes full source in body and short source in title', () => {
    const publication = owlPublication('0.1.37-owl.20261011.1', { sourceCommit }, 'Preview notes')
    expect(publication.title).toBe('Sotto Owl 0.1.37-owl.20261011.1 (aaaaaaaaaaaa)')
    expect(publication.body).toBe(`Preview notes\n\nSource commit: ${sourceCommit}\n`)
    expect(() => owlPublication('0.1.37-owl.20261011.1', {}, 'Preview')).toThrow('full source commit')
    expect(() => owlPublication('0.1.37-owl.20261011.1', { sourceCommit }, `Preview\nSource commit: ${'b'.repeat(40)}`)).toThrow('out of custom notes')
  })
  it('keeps nonrelease package commands offline and unchanged', async () => {
    const { scripts } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
    expect(scripts['package:win']).toBe('npm run release:check && node scripts/package-stable.mjs win')
    expect(scripts['package:mac']).toBe('npm run release:check && node scripts/package-stable.mjs mac')
    expect(scripts['package:linux:stable']).toBe('npm run release:check && node scripts/package-stable.mjs linux')
    for (const name of ['package:dir', 'package:dir:mac', 'package:linux']) {
      expect(scripts[name]).not.toMatch(/release:check|package-stable/u)
    }
  })
})
