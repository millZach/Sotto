import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrowserImportSource } from '../../shared/browser'

/** Another browser's profile Sotto can copy sign-ins from; `folder` never leaves main. */
export type FoundImportSource = BrowserImportSource & { readonly folder: string }
/** The part of Electron's `session.cookies` an import writes to. */
export interface CookieTarget { set(details: Electron.CookiesSetDetails): Promise<void> }

/** Where Firefox and Zen keep `profiles.ini` on each platform (ADR-0221). */
export function importRoots(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): { browser: BrowserImportSource['browser']; folder: string }[] {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [{ browser: 'Firefox', folder: join(appData, 'Mozilla', 'Firefox') }, { browser: 'Zen', folder: join(appData, 'zen') }]
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [{ browser: 'Firefox', folder: join(support, 'Firefox') }, { browser: 'Zen', folder: join(support, 'zen') }]
  }
  return [
    { browser: 'Firefox', folder: join(home, '.mozilla', 'firefox') },
    { browser: 'Firefox', folder: join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox') },
    { browser: 'Firefox', folder: join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox') },
    { browser: 'Zen', folder: join(home, '.zen') },
    { browser: 'Zen', folder: join(home, '.var', 'app', 'app.zen_browser.zen', '.zen') },
  ]
}

/** The `[ProfileN]` sections of a `profiles.ini`: each profile's name and folder. */
export function parseProfilesIni(text: string): { name: string; path: string; relative: boolean }[] {
  const profiles: { name: string; path: string; relative: boolean }[] = []
  let current: Record<string, string> | null = null
  const flush = (): void => { if (current?.Path) profiles.push({ name: current.Name ?? current.Path, path: current.Path, relative: current.IsRelative !== '0' }) }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith('[')) { flush(); current = /^\[Profile\d+\]$/u.test(line) ? {} : null; continue }
    const equals = line.indexOf('=')
    if (current && equals > 0) current[line.slice(0, equals)] = line.slice(equals + 1)
  }
  flush()
  return profiles
}

/** Firefox and Zen profiles on this computer that keep cookies, each named by a hash of its folder. */
export async function findImportSources(roots = importRoots()): Promise<FoundImportSource[]> {
  const found: FoundImportSource[] = []
  for (const root of roots) {
    let ini: string
    try { ini = await readFile(join(root.folder, 'profiles.ini'), 'utf8') } catch { continue }
    for (const entry of parseProfilesIni(ini)) {
      const folder = entry.relative && !isAbsolute(entry.path) ? resolve(root.folder, entry.path) : entry.path
      try { if (!(await stat(join(folder, 'cookies.sqlite'))).isFile()) continue } catch { continue }
      const id = createHash('sha256').update(`${root.browser}\0${folder}`).digest('hex').slice(0, 16)
      if (found.some(source => source.id === id)) continue
      // eslint-disable-next-line no-control-regex -- A name from another program's file, shown in Sotto's own chrome.
      found.push({ id, browser: root.browser, name: entry.name.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').slice(0, 200), folder })
    }
  }
  return found.slice(0, 40)
}

/** A row of Firefox's `moz_cookies`. Most columns may be NULL in a file another program wrote. */
type MozCookie = { host: string | null; name: string | null; value: string | null; path: string | null; expiry: number | bigint | null; isSecure: number | bigint | null; isHttpOnly: number | bigint | null; sameSite: number | bigint | null; originAttributes: string | null }
const SAME_SITE = new Map<number, Electron.CookiesSetDetails['sameSite']>([[0, 'no_restriction'], [1, 'lax'], [2, 'strict']])

/**
 * One Firefox cookie as Electron sets it, or null for one Sotto leaves behind: expired, partitioned, in a container, or
 * missing its host, name or value.
 */
export function cookieDetails(cookie: MozCookie, now = Date.now()): Electron.CookiesSetDetails | null {
  if (cookie.originAttributes !== '') return null
  if (typeof cookie.host !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null
  const host = cookie.host
  const bare = host.replace(/^\./u, '')
  if (!bare || /[\s/]/u.test(bare)) return null
  let expiry = Number(cookie.expiry)
  // Newer Firefox keeps milliseconds where older kept seconds.
  if (expiry > 100_000_000_000) expiry /= 1000
  if (expiry > 0 && expiry * 1000 <= now) return null
  const secure = Number(cookie.isSecure) === 1
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/'
  const named = SAME_SITE.get(Number(cookie.sameSite)) ?? 'unspecified'
  const hostOnly = !host.startsWith('.') || cookie.name.startsWith('__Host-')
  return {
    url: `${secure ? 'https' : 'http'}://${bare}${path}`, name: cookie.name, value: cookie.value, path,
    ...hostOnly ? {} : { domain: host }, secure, httpOnly: Number(cookie.isHttpOnly) === 1,
    ...expiry > 0 ? { expirationDate: expiry } : {},
    // Chromium refuses SameSite=None without Secure, so such a cookie keeps the browser's default instead.
    sameSite: named === 'no_restriction' && !secure ? 'unspecified' : named,
  }
}

/** Each import's own folder under the scratch root starts with this; a start of Sotto removes any left behind. */
const SCRATCH_PREFIX = 'import-'
/** The scratch folders of imports running now, which a sweep leaves alone. */
const importing = new Set<string>()
/** Windows may hold a file a moment after SQLite closes it, so removal tries again for half a second. */
const removeScratch = (path: string): Promise<void> => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)

/**
 * Copies a Firefox or Zen profile's cookies into a profile's session, once (ADR-0221). The database is copied first to
 * a folder of its own under `scratchRoot`, a folder in Sotto's private data, so the other browser's file is only ever
 * read, and the copy is deleted after; a copy a crash left behind goes at the next start (`sweepImportScratch`). Values
 * go from that copy straight into Chromium's cookie store; nothing is logged or kept anywhere else.
 */
export async function importCookies(folder: string, target: CookieTarget, scratchRoot: string, now = Date.now()): Promise<{ imported: number; skipped: number }> {
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(scratchRoot, SCRATCH_PREFIX))
  importing.add(scratch)
  try {
    await chmod(scratch, 0o700).catch(() => undefined)
    const copy = join(scratch, 'cookies.sqlite')
    await copyFile(join(folder, 'cookies.sqlite'), copy)
    // The write-ahead log holds what Firefox has not yet written into the database, so the copy reads stale cookies
    // without it: a log that is there but cannot be read fails the import, and the user is told to close the browser.
    // The shared-memory index is SQLite's own and is rebuilt from the log, so it is not copied.
    try { await copyFile(join(folder, 'cookies.sqlite-wal'), `${copy}-wal`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const database = new DatabaseSync(copy)
    let rows: MozCookie[]
    try { rows = database.prepare('SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies').all() as MozCookie[] } finally { database.close() }
    let imported = 0; let skipped = 0
    for (const row of rows) {
      // One odd row is skipped; it never ends the import.
      try {
        const details = cookieDetails(row, now)
        if (!details) { skipped++; continue }
        await target.set(details); imported++
      } catch { skipped++ }
    }
    return { imported, skipped }
  } finally {
    await removeScratch(scratch)
    importing.delete(scratch)
  }
}

/** Removes the copies imports left under `scratchRoot` when Sotto stopped part way; a start of Sotto runs it. Best effort. */
export async function sweepImportScratch(scratchRoot: string): Promise<void> {
  const entries = await readdir(scratchRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(scratchRoot, entry.name)
    if (entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX) && !importing.has(path)) await removeScratch(path)
  }
}
