import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** How long a saved screenshot or recording is kept before a start of Sotto removes it (ADR-0220, decision 7). */
export const BROWSER_FILES_KEPT_MS = 7 * 24 * 60 * 60_000
/** A recording stops itself at this size, as T3 Code's does. */
export const RECORDING_LIMIT = 50 * 1024 * 1024
/** How many files one upload may give a page. */
export const UPLOAD_FILES_MAX = 10

/** The folder, inside the browser's own, where an upload's copies wait for the user and the page (ADR-0220, decision 5). */
const STAGED = 'staged-uploads'

/** One file an upload gives a page: the copy Sotto made when it was asked for, where it came from, and what it held. */
export interface StagedFile { readonly name: string; readonly source: string; readonly path: string; readonly size: number; readonly digest: string }
export interface StagedUpload { readonly folder: string; readonly files: readonly StagedFile[] }

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
  /**
   * Copies of files an upload names (ADR-0220, decision 5), made when the agent asks, into a folder of Sotto's own: the
   * user is asked about these copies and the page is given only them, so a file changed, replaced or relinked after
   * the request changes nothing. Each source is opened and then checked to be the same file its checked path still
   * leads to without a link, so a swap made while it was being checked is refused too. `roots` are the folders the
   * files must be in.
   */
  async stage(sources: readonly string[], roots: readonly string[]): Promise<{ ok: true; upload: StagedUpload } | { ok: false; message: string }> {
    const folder = join(this.directory, STAGED, randomBytes(12).toString('hex'))
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const allowed = (await Promise.all(roots.map(root => realpath(root).catch(() => null)))).filter((root): root is string => root !== null)
    const files: StagedFile[] = []
    try {
      for (const [index, source] of sources.entries()) {
        const name = basename(source)
        const handle = await open(source, 'r').catch(() => null)
        if (!handle) throw new StageProblem(`${name} could not be read. Nothing was given to the page.`)
        try {
          const opened = await handle.stat()
          const named = await lstat(source).catch(() => null)
          const real = await realpath(source).catch(() => null)
          const same = !!named && named.isFile() && !named.isSymbolicLink() && named.dev === opened.dev && (opened.ino === 0 || named.ino === opened.ino)
          if (!opened.isFile() || !same || real !== source || !allowed.some(root => inside(root, source))) throw new StageProblem(`${name} changed while Sotto was checking it. Nothing was given to the page.`)
          const path = join(folder, String(index), name)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const digest = await copyHashing(handle.fd, path)
          files.push({ name, source, path, size: opened.size, digest })
        } finally { await handle.close().catch(() => undefined) }
      }
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof StageProblem) return { ok: false, message: error.message }
      return { ok: false, message: 'Sotto could not copy those files for the page. Nothing was given to it.' }
    }
    return { ok: true, upload: { folder, files } }
  }
  /** Whether an upload's copies are still exactly what was copied: plain files, not links, holding the same bytes. */
  async verify(upload: StagedUpload): Promise<boolean> {
    if (!inside(join(this.directory, STAGED), upload.folder)) return false
    for (const file of upload.files) {
      const info = await lstat(file.path).catch(() => null)
      if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== file.size) return false
      const digest = await hashOf(file.path).catch(() => null)
      if (digest !== file.digest) return false
    }
    return true
  }
  /** An upload's copies go, once its request lapsed or the page that was given them closed. */
  async discard(upload: StagedUpload): Promise<void> {
    if (!inside(join(this.directory, STAGED), upload.folder)) return
    await rm(upload.folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  }
  /** Removes what is older than `BROWSER_FILES_KEPT_MS`, and every upload copy an earlier run left; a start of Sotto runs it. Best effort. */
  async sweep(now = Date.now()): Promise<void> {
    await rm(join(this.directory, STAGED), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
    const folders = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.name === STAGED) continue
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

class StageProblem extends Error {}
/** Copies an open file to `to`, which must not exist yet, and answers the SHA-256 of what was copied. */
async function copyHashing(fd: number, to: string): Promise<string> {
  const hash = createHash('sha256')
  const tap = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk) } })
  await pipeline(createReadStream('', { fd, autoClose: false, start: 0 }), tap, createWriteStream(to, { flags: 'wx', mode: 0o600 }))
  return hash.digest('hex')
}
async function hashOf(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
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
