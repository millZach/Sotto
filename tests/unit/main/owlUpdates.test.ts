// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NsisUpdater } from 'electron-updater'

import { createElectronUpdaterAdapter } from '../../../src/main/updates/electronUpdaterAdapter'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const current = '0.1.35-owl.20261009.2'
const newer = '0.1.35-owl.20261009.10'

/** Real AppUpdater, provider factory, GitHub Atom selection and semver gate; only HTTP is scripted. */
async function fixture(version: string, tags: string[], manifests: Record<string, string | { version: string; tag: string }> = {}, missingOwl = false) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-owl-update-'))
  directories.push(directory)
  const requests: string[] = []
  const updater = new NsisUpdater(null, {
    version, name: 'Sotto', isPackaged: true, userDataPath: directory, baseCachePath: directory,
    appUpdateConfigPath: join(directory, 'app-update.yml'), whenReady: async () => undefined,
    relaunch: () => undefined, quit: () => undefined, onQuit: () => undefined,
  })
  Object.assign(updater, { httpExecutor: { request: async (options: { path: string }) => {
    requests.push(options.path)
    if (options.path.endsWith('.atom')) return `<feed>${tags.map(tag => `<entry><title>Sotto ${tag}</title><link href="https://github.com/millZach/Sotto-releases/releases/tag/v${tag}"/><content>Release</content></entry>`).join('')}</feed>`
    if (options.path.endsWith('/latest')) return JSON.stringify({ tag_name: 'v0.1.35' })
    const match = /\/download\/v([^/]+)\/(owl|latest)\.yml$/u.exec(options.path)
    if (!match) throw new Error(`Unexpected request: ${options.path}`)
    if (missingOwl && match[2] === 'owl') throw new Error('missing owl.yml')
    const manifest = manifests[match[1]!]
    return JSON.stringify({ ...(typeof manifest === 'string' ? { version: manifest } : manifest ?? { version: match[1] }), files: [{ url: 'Sotto-Owl-Setup.exe', sha512: 'test' }] })
  } } })
  const adapter = createElectronUpdaterAdapter(updater)
  if (!version.includes('-owl.')) updater.setFeedURL({ provider: 'github', owner: 'millZach', repo: 'Sotto-releases' })
  const offers: unknown[] = []
  adapter.subscribe(event => { if (event.type === 'available') offers.push(event.version) })
  return { updater, adapter, offers, requests }
}

describe('Owl GitHub updates', () => {
  it('keeps stable on latest.yml even when the Atom feed starts with Owl and superseded stable releases', async () => {
    const f = await fixture('0.1.34', [newer, '0.1.33', '0.1.35'])
    await f.adapter.check()
    expect(f.offers).toEqual(['0.1.35'])
    expect(f.updater.allowPrerelease).toBe(false)
    expect(f.updater.channel).toBeNull()
    expect(f.requests).toContain('/millZach/Sotto-releases/releases/latest')
    expect(f.requests).toContain('/millZach/Sotto-releases/releases/download/v0.1.35/latest.yml')
    expect(f.requests.some(path => path.includes('owl.yml'))).toBe(false)
  })

  it('offers a newer Owl only, past newer stable and superseded stable tags', async () => {
    const f = await fixture(current, ['0.2.0', '0.1.35', '0.1.33', '0.1.36-beta.1', newer, current])
    await f.adapter.check()
    expect(f.offers).toEqual([newer])
    expect(f.updater.allowPrerelease).toBe(true)
    expect(f.updater.channel).toBe('owl')
    expect(f.updater.allowDowngrade).toBe(false)
    expect(f.updater.autoDownload).toBe(false)
    expect(f.updater.autoInstallOnAppQuit).toBe(false)
    expect(f.requests).toEqual(['/millZach/Sotto-releases/releases.atom', `/millZach/Sotto-releases/releases/download/v${newer}/owl.yml`])
  })

  it.each([current, '0.1.35-owl.20261009.1', '0.1.35-owl.20261008.99', '0.1.34-owl.20261010.1'])('never offers the same version or a downgrade: %s', async candidate => {
    const f = await fixture(current, ['0.2.0', candidate])
    await f.adapter.check()
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it('can move to the next patch on the Owl track', async () => {
    const f = await fixture(current, ['0.1.36', '0.1.36-owl.20261010.1'])
    await f.adapter.check()
    expect(f.offers).toEqual(['0.1.36-owl.20261010.1'])
  })

  it('never falls through to a stable release when the feed has no Owl tag', async () => {
    const f = await fixture(current, ['0.2.0', '0.1.35', '0.1.33'])
    await expect(f.adapter.check()).rejects.toThrow('No published versions')
    expect(f.offers).toEqual([])
    expect(f.requests).toEqual(['/millZach/Sotto-releases/releases.atom'])
  })

  it.each([false, true])('rejects a stable manifest before an offer or download (fallback=%s)', async fallback => {
    const f = await fixture(current, [newer], { [newer]: '0.1.35' }, fallback)
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it('rejects a manifest naming a different Owl tag', async () => {
    const f = await fixture(current, [newer], { [newer]: '0.1.36-owl.20261010.1' })
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
  })

  it('cannot overwrite the selected Atom tag through a manifest tag field', async () => {
    const f = await fixture(current, [current], { [current]: { version: newer, tag: `v${newer}` } })
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })
})
