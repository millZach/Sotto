// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assembleOwlRelease, decideOwlNightly, decisionSummary, nextOwlNumber, OWL_NIGHTLY_REQUIRED_CHECKS, requiredCheckStates,
} from '../../../scripts/owl-nightly.mjs'

const main = 'a'.repeat(40)
const earlier = 'b'.repeat(40)
const owl = (tag, source, publishedAt = '2026-10-31T22:28:06Z') => ({ tag_name: tag, draft: false, published_at: publishedAt, body: `Preview.\n\nSource commit: ${source}\n` })
const stable = { tag_name: 'v0.1.42', draft: false, published_at: '2026-10-31T16:20:20Z', body: '' }
const check = (name, { id = 1, sha = main, status = 'completed', conclusion = 'success' } = {}) => ({ id, name, head_sha: sha, status, conclusion, app: { slug: 'github-actions' } })
const green = OWL_NIGHTLY_REQUIRED_CHECKS.map((name, index) => check(name, { id: index + 1 }))
const tonight = { sourceCommit: main, sourceVersion: '0.1.43', tags: [], checkRuns: green, date: '20261102', publish: true }

describe('the nightly\'s decision', () => {
  it('loads on Node\'s own modules alone, since the decide job installs nothing', async () => {
    const seen = new Set(), queue = ['scripts/owl-nightly.mjs']
    while (queue.length > 0) {
      const file = queue.pop()
      if (seen.has(file)) continue
      seen.add(file)
      const text = await readFile(join(import.meta.dirname, '../../..', file), 'utf8')
      for (const [, specifier] of text.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gmu)) {
        if (specifier.startsWith('./')) queue.push(`scripts/${specifier.slice(2)}`)
        else expect(specifier, `${file} imports ${specifier}`).toMatch(/^node:/u)
      }
    }
    expect(seen.has('scripts/release-owl.mjs')).toBe(false)
  })
})

describe('the nightly Owl\'s version', () => {
  it('takes the next number for the day across every base, and 1 on a new day', () => {
    const tags = ['v0.1.42-owl.20261031.1', 'v0.1.43-owl.20261031.1', 'v0.1.43-owl.20261031.2', 'v0.1.43-owl.20261101.1', 'v0.1.42']
    expect(nextOwlNumber(tags, '20261031')).toBe(3)
    expect(nextOwlNumber(tags, '20261101')).toBe(2)
    expect(nextOwlNumber(tags, '20261102')).toBe(1)
    expect(nextOwlNumber(['v0.1.43-owl.20261031.9', 'v0.1.43-owl.20261031.10'], '20261031')).toBe(11)
  })
  it('ignores tags that are not whole Owl versions', () => {
    expect(nextOwlNumber(['v0.1.43-owl.20261031.0', '0.1.43-owl.20261031.4', 'v0.1.43-owl.202610311.2', 'v0.1.43-owl.20261031.1-extra'], '20261031')).toBe(1)
    expect(() => nextOwlNumber([], '2026-11-02')).toThrow('YYYYMMDD')
  })
  it('counts tags with no release, and releases whose tag the listing missed', () => {
    const decision = decideOwlNightly({ ...tonight, releases: [owl('v0.1.43-owl.20261102.1', earlier)], tags: ['v0.1.43-owl.20261102.2'] })
    expect(decision.version).toBe('0.1.44-owl.20261102.3')
  })
})

describe('the nightly\'s skip rules', () => {
  it('builds main when it moved since the newest Owl and all three required checks passed', () => {
    const decision = decideOwlNightly({ ...tonight, releases: [stable, owl('v0.1.43-owl.20261031.1', earlier)] })
    expect(decision).toMatchObject({ build: true, publish: true, version: '0.1.44-owl.20261102.1', sourceCommit: main, skips: [] })
    expect(decision.previous).toMatchObject({ tag: 'v0.1.43-owl.20261031.1', sourceCommit: earlier })
  })
  it('skips when main has not changed since the newest Owl, by publish time rather than by version', () => {
    const releases = [owl('v0.1.43-owl.20261031.1', main, '2026-10-31T22:28:06Z'), owl('v0.1.42-owl.20261031.1', earlier, '2026-10-31T16:14:01Z')]
    const decision = decideOwlNightly({ ...tonight, releases })
    expect(decision.build).toBe(false)
    expect(decision.skips).toEqual([`Main has not changed since v0.1.43-owl.20261031.1, which was built from ${main.slice(0, 12)}.`])
  })
  it('skips when a required check is missing, still running or failed on main\'s commit', () => {
    const checkRuns = [check('Gates (Windows)', { id: 1 }), check('Package result', { id: 2, status: 'in_progress', conclusion: null }), check('Desktop result', { id: 3, conclusion: 'failure' })]
    const decision = decideOwlNightly({ ...tonight, releases: [], checkRuns })
    expect(decision.build).toBe(false)
    expect(decision.skips).toEqual([
      `Required CI check "Package result" is still running on ${main.slice(0, 12)}.`,
      `Required CI check "Desktop result" did not pass on ${main.slice(0, 12)} (failure).`,
    ])
    expect(decideOwlNightly({ ...tonight, releases: [], checkRuns: [] }).skips).toHaveLength(3)
  })
  it('reads only the newest run of each check, on main\'s commit, made by GitHub Actions', () => {
    const states = requiredCheckStates([
      check('Gates (Windows)', { id: 9, conclusion: 'failure' }), check('Gates (Windows)', { id: 10 }),
      check('Package result', { id: 11, sha: earlier }),
      { ...check('Desktop result', { id: 12 }), app: { slug: 'someone-else' } },
    ], main)
    expect(states).toEqual([{ name: 'Gates (Windows)', state: 'passed', conclusion: 'success' }, { name: 'Package result', state: 'missing' }, { name: 'Desktop result', state: 'missing' }])
  })
  it('requires the three checks main\'s ruleset requires', () => {
    expect(OWL_NIGHTLY_REQUIRED_CHECKS).toEqual(['Gates (Windows)', 'Package result', 'Desktop result'])
  })
  it('builds on a dry run whatever the rules say, and says what a publishing run would have done', () => {
    const decision = decideOwlNightly({ ...tonight, publish: false, releases: [owl('v0.1.43-owl.20261031.1', main)], checkRuns: [] })
    expect(decision.build).toBe(true)
    expect(decision.skips).toHaveLength(4)
    const summary = decisionSummary(decision)
    expect(summary).toContain('**Dry run.**')
    expect(summary).toContain('A publishing run would have skipped because:')
  })
  it('builds when no Owl was ever published, and refuses an Owl that names no source', () => {
    expect(decideOwlNightly({ ...tonight, releases: [stable] }).build).toBe(true)
    expect(() => decideOwlNightly({ ...tonight, releases: [{ ...owl('v0.1.43-owl.20261031.1', main), body: 'No source.' }] })).toThrow('names no single full source commit')
    expect(() => decideOwlNightly({ ...tonight, sourceCommit: 'abc', releases: [] })).toThrow('full source commit')
  })
  it('says plainly in the summary when tonight has no Owl and why', () => {
    const summary = decisionSummary(decideOwlNightly({ ...tonight, releases: [owl('v0.1.43-owl.20261031.1', main)] }))
    expect(summary).toContain('**No Owl tonight.** Nothing was built or published.')
    expect(summary).toContain('Skipped because:')
    expect(summary).toContain('Main has not changed since v0.1.43-owl.20261031.1')
  })
})

describe('gathering the nightly\'s release', () => {
  let folder
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }) })
  it('copies every file release:owl verified, its notes and checksums, and names the assets in order', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-owl-nightly-'))
    await mkdir(join(folder, 'release/owl-mac'), { recursive: true })
    for (const name of ['release/Sotto-Owl-Setup-0.1.44-owl.20261102.1.exe', 'release/owl.yml', 'release/owl-mac/Sotto-Owl-0.1.44-owl.20261102.1-arm64.dmg', 'release/owl-notes.md', 'release/SHA256SUMS.txt']) {
      await writeFile(join(folder, name), name)
    }
    let seen
    const prepare = async options => {
      seen = options
      return { publication: { tag: 'v0.1.44-owl.20261102.1', title: 'Sotto Owl 0.1.44-owl.20261102.1 (aaaaaaaaaaaa)' },
        files: ['release/Sotto-Owl-Setup-0.1.44-owl.20261102.1.exe', 'release/owl.yml', join(folder, 'release/owl-mac/Sotto-Owl-0.1.44-owl.20261102.1-arm64.dmg')] }
    }
    const manifest = await assembleOwlRelease({ rootDirectory: folder, out: 'release/owl-nightly', args: ['--mac-artifacts', 'release/owl-mac'], prepare })
    expect(seen).toEqual({ rootDirectory: folder, args: ['--mac-artifacts', 'release/owl-mac'] })
    expect(manifest.assets).toEqual(['Sotto-Owl-Setup-0.1.44-owl.20261102.1.exe', 'owl.yml', 'Sotto-Owl-0.1.44-owl.20261102.1-arm64.dmg'])
    const out = join(folder, 'release/owl-nightly')
    expect(JSON.parse(await readFile(join(out, 'release.json'), 'utf8'))).toEqual(manifest)
    expect(await readFile(join(out, 'Sotto-Owl-0.1.44-owl.20261102.1-arm64.dmg'), 'utf8')).toBe('release/owl-mac/Sotto-Owl-0.1.44-owl.20261102.1-arm64.dmg')
    expect(await readFile(join(out, 'owl-notes.md'), 'utf8')).toBe('release/owl-notes.md')
    expect(await readFile(join(out, 'SHA256SUMS.txt'), 'utf8')).toBe('release/SHA256SUMS.txt')
  })
  it('gathers nothing when release:owl\'s checks refuse', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-owl-nightly-'))
    const prepare = async () => { throw new Error('The Mac Owl receipt does not name this Windows Owl\'s version.') }
    await expect(assembleOwlRelease({ rootDirectory: folder, out: 'release/owl-nightly', args: [], prepare })).rejects.toThrow('receipt')
    await expect(readFile(join(folder, 'release/owl-nightly/release.json'))).rejects.toThrow()
  })
})
