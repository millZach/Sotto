import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** How long a saved screenshot or recording is kept before a start of Sotto removes it (ADR-0220, decision 7). */
export const BROWSER_FILES_KEPT_MS = 7 * 24 * 60 * 60_000
/** A recording stops itself at this size, as T3 Code's does. */
export const RECORDING_LIMIT = 50 * 1024 * 1024
/** How many files one upload may give a page. */
export const UPLOAD_FILES_MAX = 10

const stamp = (at: Date): string => at.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)

/**
 * Where the browser keeps what an agent saves (ADR-0220): screenshots and recordings, in Sotto's own data folder under
 * a folder per thread named by a hash of its ID, so a path says nothing of the thread. Plain Node, so a paired host
 * keeps its own the same way. Files are the user's alone where the system allows it, and go after a week.
 */
export class BrowserFiles {
  constructor(private readonly directory: string) {}
  /** The thread's folder. Its name is a hash: the thread ID never appears in a path an agent is told. */
  folder(threadId: string): string {
    return join(this.directory, createHash('sha256').update(threadId).digest('hex').slice(0, 20))
  }
  async save(threadId: string, kind: 'screenshot' | 'recording', extension: 'png' | 'webm', data: Uint8Array): Promise<string> {
    const folder = this.folder(threadId)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, `${kind}-${stamp(new Date())}-${randomBytes(3).toString('hex')}.${extension}`)
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
    return path
  }
  /** Removes what is older than `BROWSER_FILES_KEPT_MS`; a start of Sotto runs it. Best effort. */
  async sweep(now = Date.now()): Promise<void> {
    const folders = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    for (const folder of folders) {
      if (!folder.isDirectory()) continue
      const path = join(this.directory, folder.name)
      const files = await readdir(path).catch(() => [])
      for (const name of files) {
        const file = join(path, name)
        const info = await stat(file).catch(() => null)
        if (info && now - info.mtimeMs > BROWSER_FILES_KEPT_MS) await rm(file, { force: true }).catch(() => undefined)
      }
      if ((await readdir(path).catch(() => ['kept'])).length === 0) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

const inside = (root: string, path: string): boolean => {
  const between = relative(root, path)
  return between === '' ? false : !between.startsWith('..') && !isAbsolute(between) && !between.split(sep).includes('..')
}

/**
 * The files an agent may give a page (ADR-0220, decision 5): files in its thread's folder, or ones Sotto saved for the
 * thread, by an absolute path or one relative to the folder. Each is followed through links to where it really is, so
 * a link cannot reach outside. Answers the real paths, or what is wrong in words.
 */
export async function uploadPaths(paths: readonly string[], workingDirectory: string, savedFolder: string | undefined): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  if (paths.length > UPLOAD_FILES_MAX) return { ok: false, message: `Give at most ${UPLOAD_FILES_MAX} files at once.` }
  const roots = (await Promise.all([workingDirectory, savedFolder].filter((root): root is string => !!root).map(root => realpath(root).catch(() => null)))).filter((root): root is string => root !== null)
  const real: string[] = []
  for (const path of paths) {
    const candidate = isAbsolute(path) ? path : resolve(workingDirectory, path)
    const actual = await realpath(candidate).catch(() => null)
    if (!actual) return { ok: false, message: `${path} does not exist. Nothing was given to the page.` }
    if (!roots.some(root => inside(root, actual))) return { ok: false, message: `${path} is outside this thread's folder. Copy it into the folder first; nothing was given to the page.` }
    const info = await stat(actual).catch(() => null)
    if (!info?.isFile()) return { ok: false, message: `${path} is not a file. Nothing was given to the page.` }
    real.push(actual)
  }
  return { ok: true, paths: real }
}
