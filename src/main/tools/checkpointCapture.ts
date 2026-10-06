import type { BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileRelativePathSchema } from '../../shared/files'
import { checkoutIdentity } from '../agents/threadWorktrees'
import { fail } from './common'

export interface CapturedFile { hash: string; mode: number }
export interface CapturedSnapshot { files: Record<string, CapturedFile>; index: string; head: string }

const FILE_LIMIT = 10_000
const TOTAL_BYTE_LIMIT = 64 * 1024 * 1024
const FILE_BYTE_LIMIT = 8 * 1024 * 1024
/** `lstat` and directory checks are cheap and many; reads hold up to 8 MiB each, so fewer run at once. */
const STAT_CONCURRENCY = 32
const READ_CONCURRENCY = 8
/**
 * A file whose modification or change time falls this close to the start of the snapshot that read it can be
 * written again inside the same timestamp tick, so its hash is never reused (Git's "racily clean" case). The
 * coarsest tick a working copy may have is FAT's two seconds.
 */
const RACY_NS = 3_000_000_000n
/** Folders whose last snapshot is remembered; the oldest is forgotten first. */
const REMEMBERED_FOLDERS = 32

const LINK_MESSAGE = 'Checkpoint paths cannot follow symbolic links or directory junctions.'

/** What one file looked like when its contents were last hashed. */
interface Seen { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; mode: bigint; hash: string; reusable: boolean }
/** Why a folder cannot be captured, and the cheap signature of the folder it was decided against. */
interface Verdict { error: Error; key: string }
interface Folder {
  /** Git's directory for this folder: a path, null for a folder Git does not know, or unresolved. */
  gitDirectory?: string | null
  checkout?: string
  files?: Map<string, Seen>
  verdict?: Verdict
}
type Outcome = BigIntStats | 'name' | 'invalid' | 'link' | null
const storablePath = fileRelativePathSchema.refine(value => value.length > 0)

/** A listing Git refused: the folder cannot be listed, so it cannot be captured. */
class ListingFailure extends Error {}
/**
 * A listing Git refused outright: it exited with an error of its own (the folder is not a repository) or its list
 * outgrew the buffer. A timeout, or a process that could not be started, may pass, so it is not a verdict.
 */
const refusedByGit = (error: unknown): boolean => {
  const failure = error as { code?: unknown; killed?: boolean }
  return typeof failure.code === 'number' && !failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

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

const missing = (error: unknown): null => {
  if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
  throw error
}
const unchanged = (seen: Seen, info: BigIntStats): boolean => seen.size === info.size && seen.mtimeNs === info.mtimeNs
  && seen.ctimeNs === info.ctimeNs && seen.ino === info.ino && seen.mode === info.mode

/**
 * Takes a turn's file snapshot for checkpoints, paying only for what changed since the folder's last one.
 *
 * Every file is `lstat`ed and the size limits are checked before any file is read. A file whose size, times,
 * inode and mode match the folder's last snapshot keeps the hash recorded then, unless its times were too close
 * to that snapshot to trust (`RACY_NS`) or its backup has since been removed. A folder that could not be captured
 * keeps that verdict until its Git state or top-level listing moves, so a send into it costs a few `lstat`s.
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
    const folder = this.folders.get(root)
    if (!folder?.verdict || folder.gitDirectory === undefined) return undefined
    return await this.key(root, folder) === folder.verdict.key ? folder.verdict.error.message : undefined
  }

  /**
   * A cheap signature of what could turn a verdict around: Git's HEAD, its reflog (every commit, checkout and
   * reset), the index's size (a file added to or removed from it) and the folder's own listing. A folder Git
   * does not know is watched for a `.git` appearing.
   */
  private async key(root: string, folder: Folder): Promise<string | undefined> {
    const signature = (path: string, fields: (info: BigIntStats) => unknown[]): Promise<unknown> =>
      lstat(path, { bigint: true }).then(info => fields(info).map(String), error => (error as NodeJS.ErrnoException).code ?? 'error')
    const times = (info: BigIntStats): unknown[] => [info.mtimeNs, info.size]
    if (folder.gitDirectory) {
      const git = folder.gitDirectory
      const parts = await Promise.all([signature(join(git, 'HEAD'), times), signature(join(git, 'logs', 'HEAD'), times),
        signature(join(git, 'index'), info => [info.size]), signature(root, info => [info.mtimeNs])])
      if (typeof parts[0] === 'string') {
        // Git's directory moved or went: ask again next time, and the checkout with it.
        delete folder.gitDirectory; delete folder.checkout
        return undefined
      }
      return JSON.stringify(parts)
    }
    return JSON.stringify(await Promise.all([signature(join(root, '.git'), info => [info.mtimeNs]), signature(root, info => [info.mtimeNs])]))
  }

  /**
   * Snapshot a working folder. With `reuse`, files unchanged since the folder's last snapshot are not read again.
   * A revert passes `reuse: false` so that the check guarding later edits reads every file.
   */
  async snapshot(cwd: string, { reuse }: { reuse: boolean }): Promise<CapturedSnapshot> {
    const root = await realpath(cwd), folder = this.folder(root)
    if (!folder.gitDirectory) {
      const previous = folder.gitDirectory
      folder.gitDirectory = await this.options.git(root, ['rev-parse', '--absolute-git-dir']).then(text => text.trim() || null, () => null)
      if (previous !== undefined && previous !== folder.gitDirectory) delete folder.checkout
    }
    // Taken before the walk, so a change during it shows as a different key next time.
    const key = await this.key(root, folder)
    const started = BigInt(this.options.now?.() ?? Date.now()) * 1_000_000n
    try {
      const snapshot = await this.walk(root, folder, reuse, started)
      delete folder.verdict
      return snapshot
    } catch (error) {
      const settled = error instanceof ListingFailure || ['too-large', 'blocked', 'invalid-request'].includes((error as { code?: string }).code ?? '')
      if (settled && key !== undefined && error instanceof Error) folder.verdict = { error, key }
      else delete folder.verdict
      throw error
    }
  }

  private async walk(root: string, folder: Folder, reuse: boolean, started: bigint): Promise<CapturedSnapshot> {
    const { git } = this.options
    const raw = await git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.']).catch(error => {
      if (!refusedByGit(error)) throw error
      throw Object.assign(new ListingFailure(error instanceof Error ? error.message : 'Git could not list this working copy.'), { cause: error })
    })
    const paths = [...new Set(raw.split('\0').filter(Boolean))].sort()
    if (paths.length > FILE_LIMIT) return fail('too-large', 'This working copy exceeds the 10,000-file checkpoint limit.')
    const state = Promise.all([git(root, ['ls-files', '--stage', '-z']), git(root, ['rev-parse', '--verify', 'HEAD']).then(text => text.trim(), () => '')])
    state.catch(() => undefined)

    // Every directory is checked once, however many files it holds.
    const inside = (candidate: string): boolean => { const rel = relative(root, candidate); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
    const directories = new Map<string, Promise<'ok' | 'link' | null>>([['', Promise.resolve('ok')]])
    const directory = (path: string): Promise<'ok' | 'link' | null> => {
      let check = directories.get(path)
      if (!check) {
        const cut = path.lastIndexOf('/')
        check = directory(cut < 0 ? '' : path.slice(0, cut)).then(async parent => {
          if (parent !== 'ok') return parent
          const absolute = join(root, path)
          const info = await lstat(absolute).catch(missing)
          if (!info) return null
          if (info.isSymbolicLink() || !inside(await realpath(absolute))) return 'link'
          return info.isDirectory() ? 'ok' : null
        })
        directories.set(path, check)
      }
      return check
    }
    const outcomes = await inOrder<string, Outcome>(paths, STAT_CONCURRENCY, async path => {
      if (['__proto__', 'constructor', 'prototype'].includes(path)) return 'name'
      if (!storablePath.safeParse(path).success || !inside(join(root, path))) return 'invalid'
      const cut = path.lastIndexOf('/'), parent = await directory(cut < 0 ? '' : path.slice(0, cut))
      if (parent !== 'ok') return parent
      return lstat(join(root, path), { bigint: true }).catch(missing)
    })
    // Decide in path order, as a walk one file at a time would, before reading anything.
    let total = 0n
    for (const outcome of outcomes) {
      if (outcome === 'name') return fail('blocked', 'This working copy contains a file name that checkpoint storage cannot safely represent.')
      // The words a path the tools refuse has always had.
      if (outcome === 'invalid') return fail('invalid-request', 'This tool request is invalid. Refresh the tools panel.')
      if (outcome === 'link') return fail('blocked', LINK_MESSAGE)
      if (!outcome) continue
      if (outcome.isSymbolicLink()) return fail('blocked', LINK_MESSAGE)
      if (!outcome.isFile() || outcome.nlink > 1n) return fail('blocked', 'Checkpoint capture requires regular files without hard links.')
      total += outcome.size
      if (total > BigInt(TOTAL_BYTE_LIMIT) || outcome.size > BigInt(FILE_BYTE_LIMIT)) return fail('too-large', 'This working copy exceeds the checkpoint size limit (64 MiB total, 8 MiB per file).')
    }

    const blobDirectory = this.options.blobDirectory
    await mkdir(blobDirectory, { recursive: true })
    const previous = reuse ? folder.files : undefined
    const trusted = (info: BigIntStats): boolean => info.mtimeNs < started - RACY_NS && info.ctimeNs < started - RACY_NS
    const seen = await inOrder<number, Seen | null>(paths.map((_path, index) => index), READ_CONCURRENCY, async index => {
      const info = outcomes[index]
      if (!info || typeof info === 'string') return null
      const path = paths[index]!, before = previous?.get(path)
      if (before?.reusable && unchanged(before, info) && this.options.blobSizes.has(before.hash)) return before
      // A file removed since its lstat is not in the snapshot, as if it had gone a moment sooner.
      const bytes = await readFile(join(root, path)).catch(missing)
      if (!bytes) return null
      const hash = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(blobDirectory, hash), bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      this.options.blobSizes.set(hash, bytes.length)
      // A file that changed size while it was read is not trusted next time, whatever its times say.
      return { size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, ino: info.ino, mode: info.mode, hash,
        reusable: trusted(info) && BigInt(bytes.length) === info.size }
    })
    const files: CapturedSnapshot['files'] = Object.create(null), remembered = new Map<string, Seen>()
    paths.forEach((path, index) => {
      const file = seen[index]
      if (!file) return
      files[path] = { hash: file.hash, mode: Number(file.mode) }
      remembered.set(path, file)
    })
    const [index, head] = await state
    folder.files = remembered
    return { files, index, head }
  }
}
