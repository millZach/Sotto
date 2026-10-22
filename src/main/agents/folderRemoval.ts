import { chmod, lstat, opendir, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * How long a removal may go without deleting anything before it stops (#1297). A removal that keeps deleting keeps
 * going however long the folder takes, so a checkout with its own 1.4 GB `node_modules` on a slow Windows disk finishes.
 */
export const REMOVAL_STALL_MS = 120_000
/** Entries removed side by side within one folder. More would only queue behind Node's file system threads. */
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
  const persist = async (path: string, link: boolean, remove: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try { await remove(); await progressed(); return }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (code === 'ENOENT') { await progressed(); return }
        if (!BUSY.has(code)) throw error
        if (now() - progressAt > stallMs) throw new FolderRemovalStalled('A file in the folder stayed in use. Close any program using the folder.', { cause: error })
        // A read-only file, or a file in a folder that is not writable, is made writable once. chmod follows a link, so
        // a link's own mode is left as it is and only the folder holding it is changed.
        if (attempt === 0 && (code === 'EPERM' || code === 'EACCES')) {
          await chmod(dirname(path), 0o700).catch(() => undefined)
          if (!link) await chmod(path, 0o600).catch(() => undefined)
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1_000, 10 * 2 ** Math.min(attempt, 7))))
      }
    }
  }
  const removeEntry = async (path: string): Promise<void> => {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) return
    // A junction reads as a link here, and unlinking it removes the junction, not the folder it leads to.
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await removeChildren(path)
      await persist(path, false, async () => {
        try { await rmdir(path) }
        catch (error) {
          // Something wrote into the folder after its entries went; take those too before asking again.
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') await removeChildren(path)
          throw error
        }
      })
    } else await persist(path, info.isSymbolicLink(), () => unlink(path))
  }
  const removeChildren = async (directory: string, keep?: ReadonlySet<string>): Promise<void> => {
    const names: string[] = []
    const handle = await opendir(directory)
    for await (const entry of handle) if (!keep?.has(entry.name)) names.push(entry.name)
    for (let offset = 0; offset < names.length; offset += PARALLEL) {
      // Every removal in a batch settles before a failure is reported, so nothing is still deleting once the caller hears.
      const results = await Promise.allSettled(names.slice(offset, offset + PARALLEL).map(name => removeEntry(join(directory, name))))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    }
  }
  await removeChildren(root, options.keep)
}
