// @vitest-environment node
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NsisUpdater } from 'electron-updater'

import { createElectronUpdaterAdapter, STAGING_ID_FILE, STAGING_ID_HEADER } from '../../../src/main/updates/electronUpdaterAdapter'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const current = '0.1.37-owl.20261011.2'
const newer = '0.1.37-owl.20261011.10'

/** Real AppUpdater, provider factory, GitHub Atom selection and semver gate; only HTTP is scripted. */
async function fixture(version: string, tags: string[], manifests: Record<string, string | { version: string; tag: string }> = {}, missingOwl = false,
  platform: 'win32' | 'darwin' = 'win32', leftoverId?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-owl-update-'))
  directories.push(directory)
  if (leftoverId !== undefined) await writeFile(join(directory, STAGING_ID_FILE), leftoverId)
  const requests: string[] = []
  const headers: Record<string, unknown>[] = []
  const updater = new NsisUpdater(null, {
    version, name: 'Sotto', isPackaged: true, userDataPath: directory, baseCachePath: directory,
    appUpdateConfigPath: join(directory, 'app-update.yml'), whenReady: async () => undefined,
    relaunch: () => undefined, quit: () => undefined, onQuit: () => undefined,
  })
  // The provider names its channel file for this platform, regardless of the test host: owl.yml on Windows,
  // owl-mac.yml on a Mac. Only the provider is exercised; the Mac's Squirrel install needs a real app.
  Object.assign(updater, { _testOnlyOptions: { platform }, httpExecutor: { request: async (options: { path: string; headers?: Record<string, unknown> }) => {
    requests.push(options.path)
    headers.push({ ...options.headers })
    if (options.path.endsWith('.atom')) return `<feed>${tags.map(tag => `<entry><title>Sotto ${tag}</title><link href="https://github.com/millZach/Sotto-releases/releases/tag/v${tag}"/><content>Release</content></entry>`).join('')}</feed>`
    if (options.path.endsWith('/latest')) return JSON.stringify({ tag_name: 'v0.1.37' })
    const match = /\/download\/v([^/]+)\/(owl|latest)(-mac)?\.yml$/u.exec(options.path)
    if (!match || (match[3] !== undefined) !== (platform === 'darwin')) throw new Error(`Unexpected request: ${options.path}`)
    if (missingOwl && match[2] === 'owl') throw new Error('missing owl.yml')
    const manifest = manifests[match[1]!]
    return JSON.stringify({ ...(typeof manifest === 'string' ? { version: manifest } : manifest ?? { version: match[1] }), files: [{ url: 'Sotto-Owl-Setup.exe', sha512: 'test' }] })
  } } })
  const adapter = createElectronUpdaterAdapter(updater)
  if (!version.includes('-owl.')) updater.setFeedURL({ provider: 'github', owner: 'millZach', repo: 'Sotto-releases' })
  const offers: unknown[] = []
  adapter.subscribe(event => { if (event.type === 'available') offers.push(event.version) })
  return { updater, adapter, offers, requests, headers, directory }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

describe('Owl GitHub updates', () => {
  it('keeps stable on latest.yml even when the Atom feed starts with Owl and superseded stable releases', async () => {
    const f = await fixture('0.1.36', [newer, '0.1.33', '0.1.37'])
    await f.adapter.check()
    expect(f.offers).toEqual(['0.1.37'])
    expect(f.updater.allowPrerelease).toBe(false)
    expect(f.updater.channel).toBeNull()
    // A stable check is three requests, where Owl's below are two: the feed, the latest release's tag, its manifest.
    expect(f.requests).toEqual([
      '/millZach/Sotto-releases/releases.atom',
      '/millZach/Sotto-releases/releases/latest',
      '/millZach/Sotto-releases/releases/download/v0.1.37/latest.yml',
    ])
  })

  it('offers a newer Owl only, past newer stable and superseded stable tags', async () => {
    const f = await fixture(current, ['0.2.0', '0.1.37', '0.1.33', '0.1.38-beta.1', newer, current])
    await f.adapter.check()
    expect(f.offers).toEqual([newer])
    expect(f.updater.allowPrerelease).toBe(true)
    expect(f.updater.channel).toBe('owl')
    expect(f.updater.allowDowngrade).toBe(false)
    expect(f.updater.autoDownload).toBe(false)
    expect(f.updater.autoInstallOnAppQuit).toBe(false)
    expect(f.requests).toEqual(['/millZach/Sotto-releases/releases.atom', `/millZach/Sotto-releases/releases/download/v${newer}/owl.yml`])
  })

  it.each([current, '0.1.37-owl.20261011.1', '0.1.37-owl.20261010.99', '0.1.36-owl.20261012.1'])('never offers the same version or a downgrade: %s', async candidate => {
    const f = await fixture(current, ['0.2.0', candidate])
    await f.adapter.check()
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it('can move to the next patch on the Owl track', async () => {
    const f = await fixture(current, ['0.1.38', '0.1.38-owl.20261012.1'])
    await f.adapter.check()
    expect(f.offers).toEqual(['0.1.38-owl.20261012.1'])
  })

  it('never falls through to a stable release when the feed has no Owl tag', async () => {
    const f = await fixture(current, ['0.2.0', '0.1.37', '0.1.33'])
    await expect(f.adapter.check()).rejects.toThrow('No published versions')
    expect(f.offers).toEqual([])
    expect(f.requests).toEqual(['/millZach/Sotto-releases/releases.atom'])
  })

  it.each([false, true])('rejects a stable manifest before an offer or download (fallback=%s)', async fallback => {
    const f = await fixture(current, [newer], { [newer]: '0.1.37' }, fallback)
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it('rejects a manifest naming a different Owl tag', async () => {
    const f = await fixture(current, [newer], { [newer]: '0.1.38-owl.20261012.1' })
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
  })

  it('reads owl-mac.yml on a Mac and offers a newer Owl from it', async () => {
    const f = await fixture(current, ['0.2.0', '0.1.37', newer, current], {}, false, 'darwin')
    await f.adapter.check()
    expect(f.offers).toEqual([newer])
    expect(f.updater.autoDownload).toBe(false)
    expect(f.updater.autoInstallOnAppQuit).toBe(false)
    expect(f.requests).toEqual(['/millZach/Sotto-releases/releases.atom', `/millZach/Sotto-releases/releases/download/v${newer}/owl-mac.yml`])
  })

  it.each([false, true])('rejects a stable Mac manifest before an offer, including the latest-mac.yml fallback (fallback=%s)', async fallback => {
    const f = await fixture(current, [newer], { [newer]: '0.1.37' }, fallback, 'darwin')
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
    if (fallback) expect(f.requests).toContain(`/millZach/Sotto-releases/releases/download/v${newer}/latest-mac.yml`)
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it('rejects a Mac manifest naming a different Owl tag', async () => {
    const f = await fixture(current, [newer], { [newer]: '0.1.38-owl.20261012.1' }, false, 'darwin')
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
  })

  it('cannot overwrite the selected Atom tag through a manifest tag field', async () => {
    const f = await fixture(current, [current], { [current]: { version: newer, tag: `v${newer}` } })
    await expect(f.adapter.check()).rejects.toThrow('inconsistent update information')
    expect(f.offers).toEqual([])
    await expect(f.adapter.download()).rejects.toThrow('Please check update first')
  })

  it.each(['0.1.36', current])('sends GitHub no install ID and keeps none on disk (%s)', async version => {
    const f = await fixture(version, version === current ? [newer] : ['0.1.37'])
    await f.adapter.check()
    expect(f.offers).toHaveLength(1)
    expect(f.headers.length).toBeGreaterThan(0)
    for (const sent of f.headers) expect(Object.keys(sent).map(name => name.toLowerCase())).not.toContain(STAGING_ID_HEADER)
    expect(await exists(join(f.directory, STAGING_ID_FILE))).toBe(false)
  })

  it('removes the install ID an earlier Sotto left behind', async () => {
    const f = await fixture('0.1.36', ['0.1.37'], {}, false, 'win32', '6b3f6d2c-1d0e-4c4f-9b8a-2f1e0d9c8b7a')
    await f.adapter.check()
    expect(await exists(join(f.directory, STAGING_ID_FILE))).toBe(false)
    expect(f.headers.flatMap(sent => Object.values(sent))).not.toContain('6b3f6d2c-1d0e-4c4f-9b8a-2f1e0d9c8b7a')
  })
})
