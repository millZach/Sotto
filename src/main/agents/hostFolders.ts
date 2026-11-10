import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { HOST_FOLDERS_MAX, type HostFolder, type HostFolderCrumb, type HostFoldersRequest, type HostFoldersResult } from '../../shared/hostFolders'

/** No `.git` or `stat` is asked for on more folders than this at once, so a folder full of subfolders reads at a bounded pace. */
const GIT_CONCURRENCY = 16
/** How long one drive letter is given to answer before it is read as absent, so a dead mapped drive cannot hang the listing. */
const DRIVE_PROBE_TIMEOUT_MS = 300
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const WINDOWS_ROOTED = /^[A-Za-z]:[\\/]/u
const WINDOWS_BARE_DRIVE = /^[A-Za-z]:$/u

/**
 * The Add project folder browser's read: the subfolders of one folder on the host that will run the
 * project, never a file and never anything inside one. `options` exists for tests, which hand in a
 * platform and a home folder instead of this process's own so both Windows and POSIX behaviour can be
 * exercised from one machine.
 */
export async function listHostFolders(request: HostFoldersRequest, options?: { platform?: NodeJS.Platform; home?: string }): Promise<HostFoldersResult> {
  const platform = options?.platform ?? process.platform
  const home = options?.home ?? homedir()
  const separator: '\\' | '/' = platform === 'win32' ? '\\' : '/'
  if (request.path === null) {
    if (platform === 'win32') {
      const folders = await listDrives()
      return { status: 'listed', path: null, home, separator, crumbs: hostFolderCrumbs(null, platform), folders, truncated: false }
    }
    return listDirectory('/', platform, home, separator)
  }
  const target = request.path ?? home
  if (!isAllowedPath(target, platform)) return { status: 'unreadable', path: target }
  return listDirectory(normalizePath(target, platform), platform, home, separator)
}

/**
 * A path this read will open: absolute in the host's own spelling, and on Windows never a UNC or a
 * device path (`\\server\share`, `\\?\`, `\\.\`, also with forward slashes), so a paired device cannot
 * make the host open a network share. A bare drive letter (`C:`) is not rooted here; `normalizePath`
 * is what turns it into `C:\`.
 */
function isAllowedPath(target: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return WINDOWS_ROOTED.test(target) || WINDOWS_BARE_DRIVE.test(target)
  return posix.isAbsolute(target)
}

/** `resolve`s the path in the host's own style, after a bare drive letter is given its root. */
function normalizePath(target: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return win32.resolve(WINDOWS_BARE_DRIVE.test(target) ? target + '\\' : target)
  return posix.resolve(target)
}

async function listDirectory(path: string, platform: NodeJS.Platform, home: string, separator: '\\' | '/'): Promise<HostFoldersResult> {
  const pathModule = platform === 'win32' ? win32 : posix
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable', path }
  }
  const candidates = entries.filter(entry => isCandidateName(entry.name, platform))
  const isDirectory = await mapWithConcurrency(candidates, GIT_CONCURRENCY, async entry => {
    if (entry.isDirectory()) return true
    if (!entry.isSymbolicLink()) return false
    // A junction or a symlink counts as a folder only when its target still resolves to one; a broken link is skipped.
    try { return (await stat(pathModule.join(path, entry.name))).isDirectory() } catch { return false }
  })
  const names = candidates.filter((_, index) => isDirectory[index]).map(entry => entry.name)
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0))
  const truncated = names.length > HOST_FOLDERS_MAX
  const listed = names.slice(0, HOST_FOLDERS_MAX)
  const hasGitFlags = await mapWithConcurrency(listed, GIT_CONCURRENCY, name => hasGit(pathModule.join(path, name), pathModule))
  const folders: HostFolder[] = listed.map((name, index) => ({ name, path: pathModule.join(path, name), git: hasGitFlags[index]! }))
  return { status: 'listed', path, home, separator, crumbs: hostFolderCrumbs(path, platform), folders, truncated }
}

/** Never a file, never a dot folder, and on Windows never one of the machine's own hidden folders. */
function isCandidateName(name: string, platform: NodeJS.Platform): boolean {
  if (name.startsWith('.')) return false
  if (platform !== 'win32') return true
  return !name.startsWith('$') && name.toLowerCase() !== 'system volume information'
}

async function hasGit(folderPath: string, pathModule: typeof win32 | typeof posix): Promise<boolean> {
  try { await stat(pathModule.join(folderPath, '.git')); return true }
  catch { return false }
}

/** Runs `fn` over `items` with at most `limit` in flight, in the order results are needed rather than the order they finish. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function listDrives(): Promise<HostFolder[]> {
  const found = await Promise.all([...DRIVE_LETTERS].map(async letter => {
    const root = `${letter}:\\`
    return await probeDrive(root) ? { name: `${letter}:`, path: root, git: false } : null
  }))
  return found.filter((item): item is HostFolder => item !== null)
}

/** Whether a drive letter answers within its own short window, so one dead mapped drive cannot hold up the rest. */
function probeDrive(root: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, DRIVE_PROBE_TIMEOUT_MS)
    stat(root).then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false) } },
    )
  })
}

/**
 * From the top of the machine down to `path`, the last crumb. `path: null` is the top of a Windows
 * machine (its drives); POSIX has no such state; its top is `/` itself. A pure function of the path and
 * the platform, so it is tested without touching a filesystem.
 */
export function hostFolderCrumbs(path: string | null, platform: NodeJS.Platform): HostFolderCrumb[] {
  if (platform === 'win32') {
    if (path === null) return [{ name: 'Drives', path: null }]
    const root = win32.parse(path).root
    const drive = root.slice(0, 2)
    const segments = path.slice(root.length).split(/[\\/]+/u).filter(Boolean)
    const crumbs: HostFolderCrumb[] = [{ name: 'Drives', path: null }, { name: drive, path: root }]
    let current = root
    for (const segment of segments) { current = win32.join(current, segment); crumbs.push({ name: segment, path: current }) }
    return crumbs
  }
  const segments = (path ?? '/').split('/').filter(Boolean)
  const crumbs: HostFolderCrumb[] = [{ name: '/', path: '/' }]
  let current = '/'
  for (const segment of segments) { current = posix.join(current, segment); crumbs.push({ name: segment, path: current }) }
  return crumbs
}
