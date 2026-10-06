import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ToolsError } from '../../shared/tools'
import { fileRelativePathSchema } from '../../shared/files'
import { checkoutIdentity } from '../agents/threadWorktrees'
import { INVALID_REQUEST, ToolFailure } from './common'
import type { Snapshot } from './checkpointStore'

const FILE_LIMIT = 10_000
const MIB = 1024 * 1024
const TOTAL_BYTE_LIMIT = 64 * MIB
const FILE_BYTE_LIMIT = 8 * MIB
const COUNT_MESSAGE = `This working copy exceeds the ${FILE_LIMIT.toLocaleString('en-US')}-file checkpoint limit.`
const SIZE_MESSAGE = `This working copy exceeds the checkpoint size limit (${TOTAL_BYTE_LIMIT / MIB} MiB total, ${FILE_BYTE_LIMIT / MIB} MiB per file).`
export const LINK_MESSAGE = 'Checkpoint paths cannot follow symbolic links or directory junctions.'
/** `lstat` and directory checks are cheap and many; reads hold up to 8 MiB each, so fewer run at once. */
const STAT_CONCURRENCY = 32
const READ_CONCURRENCY = 8
/**
 * A file whose modification or change time falls this close to the start of the snapshot that read it can be
 * written again inside the same timestamp tick, so its hash is never reused (Git's "racily clean" case). The
 * coarsest tick a working copy may have is FAT's two seconds. A verdict is not held over a watched path this recent.
 */
const RACY_NS = 3_000_000_000n
/** Folders whose last snapshot is remembered; the oldest is forgotten first. */
const REMEMBERED_FOLDERS = 32
/** Paths a verdict watches beyond Git's state and the top-level listing; a verdict that needs more watches none. */
const WATCH_LIMIT = 1_000

/** A checkpoint path: relative to its working folder, inside it, and not the folder itself. */
export const checkpointPathSchema = fileRelativePathSchema.refine(value => value.length > 0)
/** Whether `candidate` is `root` or inside it. */
export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}
/** The name a file's backup is stored under, and the hash a checkpoint records for it. */
export const blobName = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** What one file looked like when its contents were last hashed. */
interface Seen { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; mode: bigint; hash: string; reusable: boolean }
/**
 * Why a folder could not be captured, with what was cheap to read about it then: Git's state and the top-level
 * listing (`signature`), and the paths that decided it (`watched`) as `lstat` saw them (`fingerprints`).
 */
interface Verdict { error: Error; signature: string; watched: readonly string[]; fingerprints: string }
interface Folder {
  /** Git's directory for this folder: a path, null for a folder Git does not know, or unresolved. */
  gitDirectory?: string | null
  checkout?: string
  files?: Map<string, Seen>
  verdict?: Verdict
}
/** A reason the folder cannot be captured that holds until something it names changes, and the paths that would show it. */
class Refusal {
  constructor(readonly error: Error, readonly watch: readonly string[]) {}
}
const refusal = (code: ToolsError['code'], message: string, watch: readonly string[]): Refusal => new Refusal(new ToolFailure(code, message), watch)
const parentOf = (path: string): string => { const cut = path.lastIndexOf('/'); return cut < 0 ? '' : path.slice(0, cut) }

/**
 * Run `work` over `items`, at most `limit` at once, results in item order. After a failure no further item starts,
 * and the first failure is thrown once the items already started have finished, so nothing outlives the call.
 */
async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0, failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await work(items[index]!, index) } catch (error) { failed = true; throw error }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
  const rejected = settled.find(outcome => outcome.status === 'rejected')
  if (rejected) throw rejected.reason
  return results
}

/** For a path that is not there: null. Any other error is thrown. */
const absentAsNull = (error: unknown): null => {
  if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
  throw error
}
const unchanged = (seen: Seen, info: BigIntStats): boolean => seen.size === info.size && seen.mtimeNs === info.mtimeNs
  && seen.ctimeNs === info.ctimeNs && seen.ino === info.ino && seen.mode === info.mode
/**
 * A listing Git refused outright: it exited with an error of its own (the folder is not a repository) or its list
 * outgrew the buffer. A timeout, or a process that could not be started, may pass, so it is not a verdict.
 */
const refusedByGit = (error: unknown): boolean => {
  const failure = error as { code?: unknown; killed?: boolean }
  return typeof failure.code === 'number' && !failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

/**
 * Takes a turn's file snapshot for checkpoints, paying only for what changed since the folder's last one.
 *
 * Every file is `lstat`ed and the size limits are checked before any file is read. A file whose size, times,
 * inode and mode match the folder's last snapshot keeps the hash recorded then, unless its times were too close
 * to that snapshot to trust (`RACY_NS`) or its backup has since been removed. A folder that could not be captured
 * keeps that verdict until its Git state, its top-level listing or a path that decided the verdict moves, so a
 * send into it costs a few `lstat`s.
 */
export class CheckpointCapture {
  private readonly folders = new Map<string, Folder>()
  constructor(private readonly options: {
    blobDirectory: string
    blobSizes: Map<string, number>
    git(cwd: string, args: string[]): Promise<string>
    now?: () => number
  }) {}

  /** Forget every folder's files and verdicts, as when Keep local history is turned off. */
  forget(): void { this.folders.clear() }

  private folder(root: string): Folder {
    let folder = this.folders.get(root)
    if (folder) this.folders.delete(root)
    else folder = {}
    this.folders.set(root, folder)
    for (const oldest of this.folders.keys()) { if (this.folders.size <= REMEMBERED_FOLDERS) break; this.folders.delete(oldest) }
    return folder
  }

  /** The checkout a canonical folder belongs to, asked of Git once per folder while its Git directory stands. */
  async checkout(root: string): Promise<string> {
    const folder = this.folder(root)
    return folder.checkout ??= await checkoutIdentity(root)
  }

  /**
   * The reason this folder could not be captured last time, while nothing cheap says that may have changed.
   * Runs no Git command and reads no file: a handful of `lstat`s.
   */
  async heldVerdict(root: string): Promise<string | undefined> {
    const folder = this.folders.get(root), verdict = folder?.verdict
    if (!folder || !verdict || folder.gitDirectory === undefined) return undefined
    if (await this.signature(root, folder) !== verdict.signature) return undefined
    return (await this.fingerprints(verdict.watched)).text === verdict.fingerprints ? verdict.error.message : undefined
  }

  /**
   * A cheap signature of the folder's Git state and listing: Git's HEAD, its reflog (every commit, checkout and
   * reset), the index's size (a file added to or removed from it) and the folder's own listing. A folder Git
   * does not know is watched for a `.git` appearing.
   */
  private async signature(root: string, folder: Folder): Promise<string | undefined> {
    const read = (path: string, fields: (info: BigIntStats) => unknown[]): Promise<unknown> =>
      lstat(path, { bigint: true }).then(info => fields(info).map(String), error => (error as NodeJS.ErrnoException).code ?? 'error')
    const times = (info: BigIntStats): unknown[] => [info.mtimeNs, info.size]
    if (folder.gitDirectory) {
      const git = folder.gitDirectory
      const parts = await Promise.all([read(join(git, 'HEAD'), times), read(join(git, 'logs', 'HEAD'), times),
        read(join(git, 'index'), info => [info.size]), read(root, info => [info.mtimeNs])])
      if (typeof parts[0] === 'string') {
        // Git's directory moved or went: ask again next time, and the checkout with it.
        delete folder.gitDirectory; delete folder.checkout
        return undefined
      }
      return JSON.stringify(parts)
    }
    return JSON.stringify(await Promise.all([read(join(root, '.git'), info => [info.mtimeNs]), read(root, info => [info.mtimeNs])]))
  }

  /** What `lstat` says of each path, and whether any was changed too recently to trust that it stays as read. */
  private async fingerprints(paths: readonly string[], started?: bigint): Promise<{ text: string; recent: boolean }> {
    let recent = false
    const prints = await inOrder(paths, STAT_CONCURRENCY, path => lstat(path, { bigint: true }).then(info => {
      if (started !== undefined && (info.mtimeNs >= started - RACY_NS || info.ctimeNs >= started - RACY_NS)) recent = true
      return [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.mode, info.nlink].join(':')
    }, error => (error as NodeJS.ErrnoException).code ?? 'error'))
    return { text: JSON.stringify(prints), recent }
  }

  /**
   * Snapshot a working folder. With `reuse`, files unchanged since the folder's last snapshot are not read again.
   * A revert passes `reuse: false` so that the check guarding later edits reads every file.
   */
  async snapshot(cwd: string, { reuse }: { reuse: boolean }): Promise<Snapshot> {
    const root = await realpath(cwd), folder = this.folder(root)
    if (!folder.gitDirectory) {
      const previous = folder.gitDirectory
      folder.gitDirectory = await this.options.git(root, ['rev-parse', '--absolute-git-dir']).then(text => text.trim() || null, () => null)
      if (previous !== undefined && previous !== folder.gitDirectory) delete folder.checkout
    }
    // Taken before the walk, so a change during it shows as a different signature next time.
    const signature = await this.signature(root, folder)
    const started = BigInt(this.options.now?.() ?? Date.now()) * 1_000_000n
    let outcome: Snapshot | Refusal
    try { outcome = await this.walk(root, folder, reuse, started) }
    catch (error) { delete folder.verdict; throw error }
    if (!(outcome instanceof Refusal)) { delete folder.verdict; return outcome }
    // Read after the walk: a watched path changed since it started is too recent to hold the verdict over.
    const watched = await this.fingerprints(outcome.watch, started)
    if (signature !== undefined && !watched.recent) folder.verdict = { error: outcome.error, signature, watched: outcome.watch, fingerprints: watched.text }
    else delete folder.verdict
    throw outcome.error
  }

  private async walk(root: string, folder: Folder, reuse: boolean, started: bigint): Promise<Snapshot | Refusal> {
    const { git } = this.options
    let listing: string
    try { listing = await git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.']) }
    catch (error) {
      if (!refusedByGit(error)) throw error
      return new Refusal(new Error(error instanceof Error ? error.message : 'Git could not list this working copy.', { cause: error }), [])
    }
    const paths = [...new Set(listing.split('\0').filter(Boolean))].sort()
    const valid = (path: string): boolean => checkpointPathSchema.safeParse(path).success && isInside(root, join(root, path))
    // Git's ignore files decide which untracked files are listed, so every verdict watches them too.
    const ignores = paths.filter(path => (path === '.gitignore' || path.endsWith('/.gitignore')) && valid(path))
    const refuse = (code: ToolsError['code'], message: string, decided: readonly string[]): Refusal => {
      const watch = [...new Set(decided.filter(path => path === '' || valid(path)))]
      const named = [...watch, ...ignores].map(path => join(root, path))
      if (folder.gitDirectory) named.push(join(folder.gitDirectory, 'info', 'exclude'))
      return refusal(code, message, named.length <= WATCH_LIMIT ? named : [])
    }
    if (paths.length > FILE_LIMIT) {
      // A file added or removed anywhere changes the listing of the directory holding it.
      const directories = new Set(paths.filter(valid).map(parentOf).filter(Boolean))
      return refuse('too-large', COUNT_MESSAGE, directories.size + ignores.length < WATCH_LIMIT ? [...directories] : [])
    }
    const gitState = Promise.all([git(root, ['ls-files', '--stage', '-z']), git(root, ['rev-parse', '--verify', 'HEAD']).then(text => text.trim(), () => '')])
    gitState.catch(() => undefined)

    // Every directory is checked once, however many files it holds: true for a safe directory, false for none there.
    const directories = new Map<string, Promise<boolean | Refusal>>([['', Promise.resolve(true)]])
    const directorySafety = (path: string): Promise<boolean | Refusal> => {
      let check = directories.get(path)
      if (!check) {
        check = directorySafety(parentOf(path)).then(async parent => {
          if (parent !== true) return parent
          const absolute = join(root, path)
          const info = await lstat(absolute).catch(absentAsNull)
          if (!info) return false
          if (info.isSymbolicLink() || !isInside(root, await realpath(absolute))) return refuse('blocked', LINK_MESSAGE, [path, parentOf(path)])
          return info.isDirectory()
        })
        directories.set(path, check)
      }
      return check
    }
    const entries = await inOrder<string, BigIntStats | Refusal | null>(paths, STAT_CONCURRENCY, async path => {
      if (['__proto__', 'constructor', 'prototype'].includes(path)) return refuse('blocked', 'This working copy contains a file name that checkpoint storage cannot safely represent.', [path, ''])
      if (!valid(path)) return refuse('invalid-request', INVALID_REQUEST, [])
      const parent = await directorySafety(parentOf(path))
      if (parent !== true) return parent || null
      return lstat(join(root, path), { bigint: true }).catch(absentAsNull)
    })
    // Decide in path order, as a walk one file at a time would, before reading anything.
    let total = 0n
    for (const [index, entry] of entries.entries()) {
      if (!entry) continue
      if (entry instanceof Refusal) return entry
      const path = paths[index]!
      if (entry.isSymbolicLink()) return refuse('blocked', LINK_MESSAGE, [path, parentOf(path)])
      if (!entry.isFile() || entry.nlink > 1n) return refuse('blocked', 'Checkpoint capture requires regular files without hard links.', [path, parentOf(path)])
      if (entry.size > BigInt(FILE_BYTE_LIMIT)) return refuse('too-large', SIZE_MESSAGE, [path])
      total += entry.size
      if (total > BigInt(TOTAL_BYTE_LIMIT)) return refuse('too-large', SIZE_MESSAGE, this.largest(paths, entries))
    }

    const blobDirectory = this.options.blobDirectory
    await mkdir(blobDirectory, { recursive: true })
    const previous = reuse ? folder.files : undefined
    const trusted = (info: BigIntStats): boolean => info.mtimeNs < started - RACY_NS && info.ctimeNs < started - RACY_NS
    const seen = await inOrder<number, Seen | null>(paths.map((_path, index) => index), READ_CONCURRENCY, async index => {
      const info = entries[index]
      if (!info || info instanceof Refusal) return null
      const path = paths[index]!, before = previous?.get(path)
      if (before?.reusable && unchanged(before, info) && this.options.blobSizes.has(before.hash)) return before
      // A file removed since its lstat is not in the snapshot, as if it had gone a moment sooner.
      const bytes = await readFile(join(root, path)).catch(absentAsNull)
      if (!bytes) return null
      const hash = blobName(bytes)
      await writeFile(join(blobDirectory, hash), bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      this.options.blobSizes.set(hash, bytes.length)
      // A file that changed size while it was read is not trusted next time, whatever its times say.
      return { size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino, mode: info.mode, hash,
        reusable: trusted(info) && BigInt(bytes.length) === info.size }
    })
    const files: Snapshot['files'] = Object.create(null), remembered = new Map<string, Seen>()
    paths.forEach((path, index) => {
      const file = seen[index]
      if (!file) return
      files[path] = { hash: file.hash, mode: Number(file.mode) }
      remembered.set(path, file)
    })
    const [index, head] = await gitState
    folder.files = remembered
    return { files, index, head }
  }

  /**
   * The largest files that alone exceed the total limit. While they stay as they are the folder stays over it,
   * whatever else is added or removed, so they are what a too-large verdict watches.
   */
  private largest(paths: readonly string[], entries: readonly (BigIntStats | Refusal | null)[]): string[] {
    const sized = entries.flatMap((entry, index) => entry && !(entry instanceof Refusal) ? [{ path: paths[index]!, size: entry.size }] : [])
      .sort((a, b) => a.size === b.size ? 0 : a.size > b.size ? -1 : 1)
    const chosen: string[] = []
    let total = 0n
    for (const { path, size } of sized) {
      chosen.push(path); total += size
      if (total > BigInt(TOTAL_BYTE_LIMIT) || chosen.length > WATCH_LIMIT) break
    }
    return chosen
  }
}
