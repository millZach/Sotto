import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * How long a removal may go without deleting anything before it stops (#1297). A removal that keeps deleting keeps
 * going however long the folder takes, so a checkout with its own 1.4 GB `node_modules` on a slow Windows disk finishes.
 */
export const REMOVAL_STALL_MS = 120_000
/** File system calls running at once across the whole removal. More would only queue behind Node's file system threads. */
const PARALLEL = 16
/** Every this many entries, the event loop gets a turn, as `periodicYield` gives the reclaim walk (`threadWorktrees.ts`). */
const YIELD_EVERY = 256
/** What Windows answers while an antivirus scanner or the search indexer holds a just-written file, or a read-only bit is set. */
const BUSY = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE'])

/** A removal that stopped because something kept a file in the folder for longer than the stall allows. */
export class FolderRemovalStalled extends Error {}

export interface FolderRemovalOptions {
  /** Names directly inside the folder that stay, such as a linked worktree's `.git` file. */
  readonly keep?: ReadonlySet<string>
  readonly stallMs?: number
  readonly now?: () => number
}

/**
 * Deletes everything inside `root` except the top-level names in `keep`, and leaves `root` itself. A link or junction is
 * removed as itself and never followed, so a link into another folder cannot take that folder with it. A busy entry is
 * retried with a growing pause; the removal stops only when nothing has been deleted for `stallMs`. Stopping at any point,
 * or the process ending, leaves `keep` where it was, so whoever started the removal can tell it was started and finish it.
 */
export async function removeFolderContents(root: string, options: FolderRemovalOptions = {}): Promise<void> {
  const stallMs = options.stallMs ?? REMOVAL_STALL_MS
  const now = options.now ?? Date.now
  let progressAt = now()
  let visited = 0
  const progressed = async (): Promise<void> => {
    progressAt = now()
    if (++visited % YIELD_EVERY === 0) await new Promise(resolve => setImmediate(resolve))
  }
  // One limit for the whole removal, not one per folder: a deep dependency tree would otherwise open thousands of
  // folders at once and run out of file handles. Only single file system calls take a place, never a whole subtree.
  let active = 0
  const waiting: Array<() => void> = []
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    while (active >= PARALLEL) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try { return await work() }
    finally { active--; waiting.shift()?.() }
  }
  /**
   * One file system call, retried while the entry is busy. `gone` is the answer when the entry is already not there.
   * `mode` is what a read-only entry is made, once; none for a link, because chmod follows a link and its target is not
   * the removal's to change. `beforeRetry` runs outside the limit, so it may itself remove entries.
   */
  const attempt = async <T>(path: string, mode: number | undefined, work: () => Promise<T>, gone: T, beforeRetry?: (code: string) => Promise<void>): Promise<T> => {
    for (let tries = 0; ; tries++) {
      try { const result = await slot(work); await progressed(); return result }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (code === 'ENOENT') { await progressed(); return gone }
        if (!BUSY.has(code)) throw error
        if (now() - progressAt > stallMs) throw new FolderRemovalStalled('A file in the folder stayed in use. Close any program using the folder.', { cause: error })
        // A read-only entry, or one in a folder that is not writable, is made writable once.
        if (tries === 0 && (code === 'EPERM' || code === 'EACCES')) {
          await slot(() => chmod(dirname(path), 0o700)).catch(() => undefined)
          if (mode !== undefined) await slot(() => chmod(path, mode)).catch(() => undefined)
        }
        await beforeRetry?.(code)
        await new Promise(resolve => setTimeout(resolve, Math.min(1_000, 10 * 2 ** Math.min(tries, 7))))
      }
    }
  }
  const removeEntry = async (path: string): Promise<void> => {
    const info = await slot(() => lstat(path)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return
    // A junction reads as a link here, and unlinking it removes the junction, not the folder it leads to.
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await removeChildren(path)
      // Something that wrote into the folder after its entries went is taken too before asking again.
      await attempt(path, 0o700, () => rmdir(path), undefined, async code => { if (code === 'ENOTEMPTY') await removeChildren(path) })
    } else await attempt(path, info.isSymbolicLink() ? undefined : 0o600, () => unlink(path), undefined)
  }
  const removeChildren = async (directory: string, keep?: ReadonlySet<string>): Promise<void> => {
    // A folder something else removed between its lstat and here is already what this removal wanted.
    const names = (await attempt(directory, 0o700, () => readdir(directory), [] as string[])).filter(name => !keep?.has(name))
    for (let offset = 0; offset < names.length; offset += PARALLEL) {
      // Every removal in a batch settles before a failure is reported, so nothing is still deleting once the caller hears.
      const results = await Promise.allSettled(names.slice(offset, offset + PARALLEL).map(name => removeEntry(join(directory, name))))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    }
  }
  await removeChildren(root, options.keep)
}
