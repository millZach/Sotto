// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BrowserProfiles, profilePartition } from '../../../src/main/tools/browserProfiles'
import { cookieDetails, findImportSources, importCookies, importRoots, parseProfilesIni } from '../../../src/main/tools/browserImport'
import { BROWSER_PROFILES_MAX, browserAddProfileSchema } from '../../../src/shared/browser'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-profiles-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('browser profiles (ADR-0221)', () => {
  it('keeps names and IDs in one file, and refuses a second of the same name', async () => {
    const file = join(root, 'browser-profiles.json')
    const profiles = new BrowserProfiles(file)
    const work = await profiles.add('  Work ')
    expect(work.name).toBe('Work')
    await expect(profiles.add('work')).rejects.toThrow('already has that name')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, profiles: [work] })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    // A fresh store reads the same file; the file holds no cookie or value, only the name.
    expect(await new BrowserProfiles(file).list()).toEqual([work])
    expect(profilePartition(work.id)).toBe(`persist:sotto-profile-${work.id}`)
    expect(await profiles.remove(work.id)).toEqual(work)
    expect(await profiles.list()).toEqual([])
    expect(await profiles.remove(work.id)).toBeNull()
  })

  it('stops at its limit, adds one at a time, and reads a broken file as none', async () => {
    const file = join(root, 'browser-profiles.json')
    const profiles = new BrowserProfiles(file)
    await Promise.all(Array.from({ length: BROWSER_PROFILES_MAX }, (_, index) => profiles.add(`Profile ${index}`)))
    expect(await profiles.list()).toHaveLength(BROWSER_PROFILES_MAX)
    await expect(profiles.add('One more')).rejects.toThrow('Remove a profile')
    await writeFile(file, '{ not json')
    expect(await new BrowserProfiles(file).list()).toEqual([])
  })

  it('deletes partition folders no profile names at the next start, and nothing else', async () => {
    const profiles = new BrowserProfiles(join(root, 'browser-profiles.json'))
    const kept = await profiles.add('Kept')
    const partitions = join(root, 'Partitions')
    for (const name of [`sotto-profile-${kept.id}`, 'sotto-profile-6f1c1d0e-6a2b-4d39-9c43-1b0b9e1f4a11', 'visual-seal']) await mkdir(join(partitions, name), { recursive: true })
    await profiles.sweepPartitions(root)
    expect((await readdir(partitions)).sort()).toEqual([`sotto-profile-${kept.id}`, 'visual-seal'])
    await expect(new BrowserProfiles(join(root, 'none.json')).sweepPartitions(join(root, 'missing'))).resolves.toBeUndefined()
  })

  it('takes a name the user typed, without control or direction characters', () => {
    expect(browserAddProfileSchema.safeParse({ name: 'Work' }).success).toBe(true)
    expect(browserAddProfileSchema.safeParse({ name: 'Wo\u202erk' }).success).toBe(false)
    expect(browserAddProfileSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(browserAddProfileSchema.safeParse({ name: 'x'.repeat(49) }).success).toBe(false)
    expect(browserAddProfileSchema.safeParse({ name: 'Work', importFrom: '../etc' }).success).toBe(false)
  })
})

/** A Firefox profile folder with the cookies table as Firefox makes it. */
function firefoxCookies(folder: string, rows: Record<string, unknown>[]): void {
  const database = new DatabaseSync(join(folder, 'cookies.sqlite'))
  database.exec('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT \'\', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)')
  const insert = database.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const row of rows) insert.run(String(row.originAttributes ?? ''), String(row.name), String(row.value), String(row.host), String(row.path ?? '/'), Number(row.expiry ?? 0), Number(row.isSecure ?? 0), Number(row.isHttpOnly ?? 0), Number(row.sameSite ?? 0))
  database.close()
}

describe('copying sign-ins from Firefox or Zen (ADR-0221)', () => {
  it('reads profiles.ini sections, relative and absolute', () => {
    const ini = ['[Install4F96D1932A9F858E]', 'Default=Profiles/abc.default-release', '', '[Profile1]', 'Name=default', 'IsRelative=1', 'Path=Profiles/xyz.default', '', '[Profile0]', 'Name=default-release', 'IsRelative=0', 'Path=D:\\Firefox\\work', 'Default=1', '[General]', 'Version=2'].join('\r\n')
    expect(parseProfilesIni(ini)).toEqual([{ name: 'default', path: 'Profiles/xyz.default', relative: true }, { name: 'default-release', path: 'D:\\Firefox\\work', relative: false }])
  })

  it('looks where each platform keeps them', () => {
    expect(importRoots('win32', { APPDATA: 'C:\\Users\\rez\\AppData\\Roaming' }, 'C:\\Users\\rez').map(entry => entry.browser)).toEqual(['Firefox', 'Zen'])
    expect(importRoots('darwin', {}, '/Users/rez')[0]!.folder).toBe(join('/Users/rez', 'Library', 'Application Support', 'Firefox'))
    expect(importRoots('linux', {}, '/home/rez').map(entry => entry.folder)).toContain(join('/home/rez', '.mozilla', 'firefox'))
  })

  it('finds profiles that keep cookies, named by a hash of the folder', async () => {
    const firefox = join(root, 'Firefox')
    await mkdir(join(firefox, 'Profiles', 'a.default-release'), { recursive: true })
    await mkdir(join(firefox, 'Profiles', 'b.empty'), { recursive: true })
    await writeFile(join(firefox, 'profiles.ini'), '[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/a.default-release\n[Profile1]\nName=empty\nIsRelative=1\nPath=Profiles/b.empty\n')
    firefoxCookies(join(firefox, 'Profiles', 'a.default-release'), [])
    const sources = await findImportSources([{ browser: 'Firefox', folder: firefox }, { browser: 'Zen', folder: join(root, 'zen') }])
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ browser: 'Firefox', name: 'default-release', folder: join(firefox, 'Profiles', 'a.default-release') })
    expect(sources[0]!.id).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('turns a Firefox cookie into one Electron sets, and leaves expired, partitioned and container cookies', () => {
    const now = Date.UTC(2026, 10, 27)
    const later = Math.floor(now / 1000) + 3600
    expect(cookieDetails({ host: '.example.com', name: 'sid', value: 'v', path: '/', expiry: later, isSecure: 1, isHttpOnly: 1, sameSite: 1, originAttributes: '' }, now))
      .toEqual({ url: 'https://example.com/', name: 'sid', value: 'v', path: '/', domain: '.example.com', secure: true, httpOnly: true, expirationDate: later, sameSite: 'lax' })
    expect(cookieDetails({ host: 'app.example.com', name: '__Host-x', value: 'v', path: '/', expiry: later * 1000, isSecure: 1, isHttpOnly: 0, sameSite: 0, originAttributes: '' }, now))
      .toEqual({ url: 'https://app.example.com/', name: '__Host-x', value: 'v', path: '/', secure: true, httpOnly: false, expirationDate: later, sameSite: 'no_restriction' })
    expect(cookieDetails({ host: 'example.com', name: 'a', value: 'v', path: '/', expiry: later, isSecure: 0, isHttpOnly: 0, sameSite: 0, originAttributes: '' }, now)?.sameSite).toBe('unspecified')
    expect(cookieDetails({ host: 'example.com', name: 'old', value: 'v', path: '/', expiry: 1000, isSecure: 0, isHttpOnly: 0, sameSite: 0, originAttributes: '' }, now)).toBeNull()
    expect(cookieDetails({ host: 'example.com', name: 'p', value: 'v', path: '/', expiry: later, isSecure: 1, isHttpOnly: 0, sameSite: 0, originAttributes: '^partitionKey=%28https%2Cexample.org%29' }, now)).toBeNull()
    expect(cookieDetails({ host: 'example.com', name: 'c', value: 'v', path: '/', expiry: later, isSecure: 1, isHttpOnly: 0, sameSite: 0, originAttributes: '^userContextId=2' }, now)).toBeNull()
  })

  it('copies the database before reading it, sets each cookie, and deletes its copy', async () => {
    const profile = join(root, 'profile')
    await mkdir(profile)
    const later = Math.floor(Date.now() / 1000) + 3600
    firefoxCookies(profile, [
      { name: 'sid', value: 'secret-session', host: '.example.com', expiry: later, isSecure: 1, isHttpOnly: 1, sameSite: 1 },
      { name: 'gone', value: 'x', host: 'example.com', expiry: 1000 },
      { name: 'refused', value: 'x', host: 'refused.example', expiry: later, isSecure: 1 },
    ])
    const before = await readFile(join(profile, 'cookies.sqlite'))
    const set = vi.fn(async (details: { name?: string | undefined }) => { if (details.name === 'refused') throw new Error('Failed to set cookie') })
    expect(await importCookies(profile, { set })).toEqual({ imported: 1, skipped: 2 })
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/', name: 'sid', value: 'secret-session', domain: '.example.com' }))
    expect(await readFile(join(profile, 'cookies.sqlite'))).toEqual(before)
    expect((await readdir(tmpdir())).filter(name => name.startsWith('sotto-import-'))).toEqual([])
  })

  it('says it failed, and keeps nothing, when the database cannot be read', async () => {
    await expect(importCookies(join(root, 'missing'), { set: vi.fn() })).rejects.toThrow()
    expect((await readdir(tmpdir())).filter(name => name.startsWith('sotto-import-'))).toEqual([])
  })
})
