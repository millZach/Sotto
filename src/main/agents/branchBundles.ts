import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { runGitStatusCommand, type RunGitCommand } from './gitStatus'
import {
  BRANCH_BUNDLE_CHUNK_BYTES, BRANCH_BUNDLE_MAX_BYTES, BRANCH_TIPS_MAX, branchMoveRefusal, branchMoveWords, branchNameSchema, commitIdSchema,
  incomingRef, outgoingRef, SNAPSHOT_UNTRACKED_LISTED, type BranchMoved, type BranchMoveRefusal, type SnapshotCarried,
} from '../../shared/branchMoves'

/**
 * Branch bundles (ADR-0082, amended by ADR-0105 decision 8): the Git half of a branch move, the same on the desktop and on
 * a headless host. A sender checks a working copy, bundles the checked commit against what the receiver already has, and
 * hands the bundle out in chunks; a receiver stages the chunks, checks the whole, and lands the commit in an incoming ref
 * of its own, written once. Nothing here is forced, nothing writes a branch, and nothing touches a remote.
 *
 * Git's output never reaches a log or an answer: a failure is one of the refusals in `branchMoveWords`.
 */

/**
 * What a sender moves: the branch's name and the commit Sotto checked. For a test run with uncommitted work the commit is
 * a snapshot made from a temporary index, on no branch, and `snapshot` says what it carried.
 */
export interface BranchSource { readonly branch: string; readonly commit: string; readonly snapshot?: SnapshotCarried }
/** Who a test-run snapshot's commit names, so it reads as Sotto's own and needs no identity configured in the repository. */
const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: 'Sotto', GIT_AUTHOR_EMAIL: 'sotto@localhost', GIT_COMMITTER_NAME: 'Sotto', GIT_COMMITTER_EMAIL: 'sotto@localhost' } as const
const SNAPSHOT_MESSAGE = 'Snapshot of uncommitted work for a test run\n\nMade by Sotto from a temporary index. It is on no branch, and the working tree it came from is unchanged.\n'
/** A bundle staged for sending, with what the receiver checks it against. */
export interface PreparedBundle { readonly type: 'sending'; readonly path: string; readonly size: number; readonly sha256: string }

/**
 * Each move a receiver took, by its ID, with the commit and ref it was for. Written before anything is imported, so a
 * retry of the same move is answered from it and a move ID that comes back with another commit is refused (ADR-0105).
 */
const recordsSchema = z.object({ v: z.literal(1), moves: z.record(z.string(), z.object({ commit: commitIdSchema, ref: z.string(), at: z.string() })) })
type Records = z.infer<typeof recordsSchema>
/** Records kept, newest by time; one a later move pushes out only stops an old retry being recognised. */
const RECORDS_MAX = 1000

/** The bundle and snapshot index file names this module stages, so a start clears what a crash left and nothing else. */
const STAGED = /^[0-9a-f-]{36}\.(?:(?:in|out)\.bundle|snapshot\.index)$/u

export interface BranchBundlesOptions {
  /** A folder of Sotto's own, in its data folder, where bundles wait while they cross. Emptied of them at start. */
  readonly stagingDirectory: string
  /** The receiver's move records file. */
  readonly recordsPath: string
  readonly run?: RunGitCommand
  /** The most one move carries; the build's cap unless a test sets a smaller one. */
  readonly maxBytes?: number
  readonly now?: () => Date
}

/** A bundle arriving in order, staged until it is whole. */
export class IncomingBundle {
  received = 0
  private readonly hash: Hash = createHash('sha256')
  private closed = false
  constructor(readonly moveId: string, readonly repository: string, readonly branch: string, readonly commit: string, readonly size: number,
    readonly sha256: string, readonly path: string, private readonly handle: FileHandle) {}
  /** Takes the next chunk. A chunk out of order, or past the size the sender named, is refused and nothing is written. */
  async write(offset: number, bytes: Uint8Array): Promise<boolean> {
    if (this.closed || offset !== this.received || bytes.byteLength === 0 || this.received + bytes.byteLength > this.size) return false
    await this.handle.write(bytes, 0, bytes.byteLength, offset)
    this.hash.update(bytes)
    this.received += bytes.byteLength
    return true
  }
  /** The digest of what arrived, once all of it has. */
  digest(): string | null { return this.received === this.size ? this.hash.copy().digest('hex') : null }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.handle.close().catch(() => undefined) }
}

export class BranchBundles {
  private readonly run: RunGitCommand
  private readonly maxBytes: number
  private readonly records: AtomicJsonStore<Records>
  private started: Promise<void> | undefined
  constructor(private readonly options: BranchBundlesOptions) {
    this.run = options.run ?? runGitStatusCommand
    this.maxBytes = Math.min(options.maxBytes ?? BRANCH_BUNDLE_MAX_BYTES, BRANCH_BUNDLE_MAX_BYTES)
    this.records = new AtomicJsonStore(options.recordsPath, value => recordsSchema.parse(value), () => ({ v: 1 as const, moves: {} }))
  }

  /** Makes the staging folder and removes every bundle a cut-off transfer or a crash left in it. Run once; later calls share it. */
  start(): Promise<void> {
    return this.started ??= (async () => {
      await mkdir(this.options.stagingDirectory, { recursive: true })
      for (const name of await readdir(this.options.stagingDirectory)) if (STAGED.test(name)) await unlink(join(this.options.stagingDirectory, name)).catch(() => undefined)
    })()
  }

  private git(cwd: string, args: readonly string[], stdin?: string, timeoutMs = 120_000, env?: Readonly<Record<string, string>>): Promise<string> {
    return this.run(cwd, 'git', args, { timeoutMs, ...(stdin !== undefined ? { stdin } : {}), ...(env ? { env } : {}) })
  }
  private async isRepository(folder: string): Promise<boolean> {
    try { return (await this.git(folder, ['rev-parse', '--is-inside-work-tree', '--git-dir'], undefined, 30_000)).length > 0 } catch { return false }
  }
  private async refCommit(repository: string, ref: string): Promise<string | null> {
    try { return (await this.git(repository, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], undefined, 30_000)).trim() || null } catch { return null }
  }

  // The sending side.

  /**
   * The branch a working copy is on and the commit it names, checked: anything `git status --porcelain` lists refuses the
   * move, asking for a commit first, and so does a working copy on no branch. Sotto never commits or stashes for anyone.
   */
  async branchOf(workingCopy: string): Promise<BranchSource | BranchMoveRefusal> {
    if (!await this.isRepository(workingCopy)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    try {
      if ((await this.git(workingCopy, ['status', '--porcelain', '--untracked-files=normal'], undefined, 60_000)).trim()) return branchMoveRefusal('uncommitted', branchMoveWords.uncommitted)
      let branch: string
      try { branch = (await this.git(workingCopy, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, 30_000)).trim() } catch { return branchMoveRefusal('not-on-branch', branchMoveWords.notOnBranch) }
      if (!branchNameSchema.safeParse(branch).success) return branchMoveRefusal('unsupported', branchMoveWords.branchName)
      const commit = (await this.git(workingCopy, ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, 30_000)).trim()
      if (!commitIdSchema.safeParse(commit).success) return branchMoveRefusal('failed', branchMoveWords.failed)
      return { branch, commit }
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
  }

  /** `branchOf` for a move, or `snapshotOf` for a test run, which carries uncommitted work rather than refusing it. */
  sourceOf(workingCopy: string, snapshot: boolean): Promise<BranchSource | BranchMoveRefusal> {
    return snapshot ? this.snapshotOf(workingCopy) : this.branchOf(workingCopy)
  }

  /**
   * A test run's source (ADR-0105 decision 8): the branch and its commit when the working copy is clean, and otherwise a
   * snapshot of it. The snapshot is a commit object made from a copy of the index: `git add -A` against the copy, so
   * `.gitignore` is respected, then its tree, with the branch's commit as parent. No branch, no stash, and the working tree
   * and the real index are untouched. It names the untracked files it took.
   */
  async snapshotOf(workingCopy: string): Promise<BranchSource | BranchMoveRefusal> {
    if (!await this.isRepository(workingCopy)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    await this.start()
    const index = join(this.options.stagingDirectory, `${randomUUID()}.snapshot.index`)
    try {
      let branch: string
      try { branch = (await this.git(workingCopy, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, 30_000)).trim() } catch { return branchMoveRefusal('not-on-branch', branchMoveWords.notOnBranch) }
      if (!branchNameSchema.safeParse(branch).success) return branchMoveRefusal('unsupported', branchMoveWords.branchName)
      const head = (await this.git(workingCopy, ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, 30_000)).trim()
      if (!commitIdSchema.safeParse(head).success) return branchMoveRefusal('failed', branchMoveWords.failed)
      if (!(await this.git(workingCopy, ['status', '--porcelain', '--untracked-files=normal'], undefined, 60_000)).trim()) return { branch, commit: head }
      // From the top of the working tree, so `add -A` takes all of it and the untracked paths read from its root.
      const top = (await this.git(workingCopy, ['rev-parse', '--show-toplevel'], undefined, 30_000)).trim()
      const untracked = (await this.git(top, ['ls-files', '--others', '--exclude-standard', '-z'], undefined, 60_000)).split('\0').filter(Boolean)
      const real = resolve(top, (await this.git(top, ['rev-parse', '--git-path', 'index'], undefined, 30_000)).trim())
      // A repository with nothing staged yet may have no index; the temporary one then starts empty.
      await copyFile(real, index).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      const env = { GIT_INDEX_FILE: index }
      await this.git(top, ['add', '-A', '--', '.'], undefined, 300_000, env)
      const tree = (await this.git(top, ['write-tree'], undefined, 60_000, env)).trim()
      // Never signed: the snapshot is a throwaway object on no branch, and a signing prompt would hold the start.
      const commit = (await this.git(top, ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-F', '-'], SNAPSHOT_MESSAGE, 60_000, SNAPSHOT_IDENTITY)).trim()
      if (!commitIdSchema.safeParse(commit).success) return branchMoveRefusal('failed', branchMoveWords.failed)
      return { branch, commit, snapshot: { untracked: untracked.slice(0, SNAPSHOT_UNTRACKED_LISTED), untrackedCount: untracked.length } }
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
    finally { await unlink(index).catch(() => undefined) }
  }

  /**
   * Lands a branch on the same machine, for a worker started there from a thread's branch: in `repository`'s incoming ref
   * for the move, written once, as a move lands. When `repository` already holds the commit, as a thread's own worktree
   * and its project's checkout share one object store, only the ref is written; otherwise the commit goes across from
   * `from` as a bundle staged here and taken in at once.
   */
  async copy(input: { readonly from: string; readonly source: BranchSource; readonly repository: string; readonly moveId: string }): Promise<BranchMoved | BranchMoveRefusal> {
    const { source, repository, moveId } = input
    if (!await this.isRepository(repository)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    const ref = incomingRef(moveId, source.branch)
    try { await this.git(repository, ['check-ref-format', ref], undefined, 30_000) } catch { return branchMoveRefusal('unsupported', branchMoveWords.branchName) }
    const carried = (moved: BranchMoved | BranchMoveRefusal): BranchMoved | BranchMoveRefusal => moved.type === 'moved' && source.snapshot ? { ...moved, snapshot: source.snapshot } : moved
    try {
      if (await this.refCommit(repository, source.commit) !== source.commit) {
        const tips = await this.tips(repository)
        if (!Array.isArray(tips)) return tips
        const prepared = await this.prepare({ repository: input.from, moveId, commit: source.commit, bases: tips })
        if (prepared.type !== 'sending') return prepared
        try {
          const incoming = await this.receive({ repository, moveId, branch: source.branch, commit: source.commit, size: prepared.size, sha256: prepared.sha256 })
          if (!(incoming instanceof IncomingBundle)) return carried(incoming)
          for (let offset = 0; offset < prepared.size;) {
            const chunk = await this.readChunk(prepared.path, offset)
            if (!await incoming.write(offset, chunk)) { await this.abandon(incoming); return branchMoveRefusal('not-whole', branchMoveWords.notWhole) }
            offset += chunk.byteLength
          }
          return carried(await this.finish(incoming))
        } finally { await this.discard(moveId) }
      }
      const landed = await this.landed(repository, moveId, ref, source.commit)
      if (landed) return carried(landed)
      await this.record(moveId, source.commit, ref)
      try { await this.git(repository, ['update-ref', ref, source.commit, ''], undefined, 30_000) } catch { /* Read back below: another writer or a lost answer. */ }
      return carried(await this.refCommit(repository, ref) === source.commit ? { type: 'moved', moveId, branch: source.branch, commit: source.commit, ref }
        : branchMoveRefusal('move-differs', branchMoveWords.moveDiffers))
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
  }

  /** Removes the incoming ref a move landed in `repository`, for a start that never made its worktree. Best effort. */
  async forget(repository: string, moveId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(moveId)) return
    try {
      const refs = (await this.git(repository, ['for-each-ref', '--format=%(refname)', `refs/sotto/incoming/${moveId}/`], undefined, 30_000)).split(/\r?\n/u).filter(Boolean)
      for (const ref of refs) await this.git(repository, ['update-ref', '-d', ref], undefined, 30_000)
    } catch { /* Kept: its commits stay until the thread goes. */ }
  }

  /** The receiver's newest branch tips, which a sender bundles against so the bundle carries only what they lack. */
  async tips(repository: string): Promise<string[] | BranchMoveRefusal> {
    if (!await this.isRepository(repository)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    try {
      const output = await this.git(repository, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_TIPS_MAX * 2}`, '--format=%(objectname)', 'refs/heads', 'refs/remotes'], undefined, 30_000)
      return [...new Set(output.split(/\r?\n/u).map(line => line.trim()).filter(line => commitIdSchema.safeParse(line).success))].slice(0, BRANCH_TIPS_MAX)
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
  }

  /**
   * Stages a bundle of `commit` for a move, against the bases the receiver named that this repository also has. Git bundles
   * only a named ref, so the commit is pointed at by `refs/sotto/outgoing/<move>` while the bundle is written, and the ref
   * is removed straight after. When the receiver already has the commit, the bundle carries it alone against its parents.
   */
  async prepare(input: { readonly repository: string; readonly moveId: string; readonly commit: string; readonly bases: readonly string[] }): Promise<PreparedBundle | BranchMoveRefusal> {
    await this.start()
    const path = this.stagedPath(input.moveId, 'out'), ref = outgoingRef(input.moveId)
    try {
      let bases = await this.present(input.repository, input.bases)
      if (bases.length > 0 && (await this.git(input.repository, ['rev-list', '--count', input.commit, '--stdin'], bases.map(base => '^' + base).join('\n') + '\n')).trim() === '0') {
        bases = (await this.git(input.repository, ['rev-list', '--parents', '-n', '1', input.commit])).trim().split(/\s+/u).slice(1)
      }
      await this.git(input.repository, ['update-ref', ref, input.commit], undefined, 30_000)
      try {
        await this.git(input.repository, ['bundle', 'create', '--quiet', path, ref, '--stdin'], bases.map(base => '^' + base).join('\n') + '\n', 600_000)
      } finally { await this.git(input.repository, ['update-ref', '-d', ref], undefined, 30_000).catch(() => undefined) }
      const { size } = await stat(path)
      if (size > this.maxBytes) { await this.discard(input.moveId); return branchMoveRefusal('too-large', branchMoveWords.tooLarge(size, this.maxBytes)) }
      return { type: 'sending', path, size, sha256: await fileDigest(path) }
    } catch {
      await this.discard(input.moveId)
      return branchMoveRefusal('failed', branchMoveWords.failed)
    }
  }

  /** Of the commits a receiver named, the ones this repository has, so `git bundle create` is not handed one it lacks. */
  private async present(repository: string, commits: readonly string[]): Promise<string[]> {
    const wanted = commits.filter(commit => commitIdSchema.safeParse(commit).success)
    if (wanted.length === 0) return []
    const output = await this.git(repository, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], wanted.join('\n') + '\n', 30_000)
    return output.split(/\r?\n/u).map(line => line.trim().split(' ')).filter(([, type]) => type === 'commit').map(([name]) => name!)
  }

  /** One chunk of a staged bundle, from `offset`; empty past its end. */
  async readChunk(path: string, offset: number): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(BRANCH_BUNDLE_CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
      return buffer.subarray(0, bytesRead)
    } finally { await handle.close() }
  }

  /** Removes whatever a move staged, either way. */
  async discard(moveId: string): Promise<void> {
    for (const way of ['in', 'out'] as const) await unlink(this.stagedPath(moveId, way)).catch(() => undefined)
  }

  // The receiving side.

  /**
   * Starts taking a move into `repository`. A retry of a move that already landed, with the same commit, answers as done
   * and writes nothing; a move whose ID was recorded with another commit, or whose ref already names another, is refused.
   */
  async receive(input: { readonly repository: string; readonly moveId: string; readonly branch: string; readonly commit: string; readonly size: number; readonly sha256: string }): Promise<IncomingBundle | BranchMoved | BranchMoveRefusal> {
    await this.start()
    if (!await this.isRepository(input.repository)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    const ref = incomingRef(input.moveId, input.branch)
    try { await this.git(input.repository, ['check-ref-format', ref], undefined, 30_000) } catch { return branchMoveRefusal('unsupported', branchMoveWords.branchName) }
    const landed = await this.landed(input.repository, input.moveId, ref, input.commit)
    if (landed) return landed
    if (input.size > this.maxBytes) return branchMoveRefusal('too-large', branchMoveWords.tooLarge(input.size, this.maxBytes))
    const path = this.stagedPath(input.moveId, 'in')
    try {
      const handle = await open(path, 'wx')
      return new IncomingBundle(input.moveId, input.repository, input.branch, input.commit, input.size, input.sha256, path, handle)
    } catch { return branchMoveRefusal('busy', branchMoveWords.busy) }
  }

  /** Done for a retry of a move that landed; refused for one that conflicts with what is here; null when it may go ahead. */
  private async landed(repository: string, moveId: string, ref: string, commit: string): Promise<BranchMoved | BranchMoveRefusal | null> {
    const record = (await this.records.read()).moves[moveId]
    if (record && (record.commit !== commit || record.ref !== ref)) return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
    const existing = await this.refCommit(repository, ref)
    if (existing === null) return null
    if (record && existing === commit) return { type: 'moved', moveId, branch: ref.slice(`refs/sotto/incoming/${moveId}/`.length), commit, ref }
    return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
  }

  /**
   * Lands a whole bundle: its size and SHA-256 as the sender named them, `git bundle verify` in the receiving repository,
   * and exactly one ref, the sender's outgoing ref for this move, naming the commit. The move is recorded, the objects
   * imported without writing any ref, and the incoming ref created only if it does not exist, then read back. The staged
   * file is removed whatever happens.
   */
  async finish(incoming: IncomingBundle): Promise<BranchMoved | BranchMoveRefusal> {
    const { repository, moveId, branch, commit, path } = incoming
    const ref = incomingRef(moveId, branch)
    try {
      await incoming.close()
      if (incoming.digest() !== incoming.sha256) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      try { await this.git(repository, ['bundle', 'verify', '--quiet', path], undefined, 120_000) } catch { return branchMoveRefusal('not-whole', branchMoveWords.notWhole) }
      const heads = (await this.git(repository, ['bundle', 'list-heads', path], undefined, 30_000)).split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
      if (heads.length !== 1 || heads[0] !== `${commit} ${outgoingRef(moveId)}`) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      const landed = await this.landed(repository, moveId, ref, commit)
      if (landed) return landed
      await this.record(moveId, commit, ref)
      await this.git(repository, ['bundle', 'unbundle', path], undefined, 600_000)
      try { await this.git(repository, ['update-ref', ref, commit, ''], undefined, 30_000) } catch { /* Read back below: another writer or a lost answer. */ }
      return await this.refCommit(repository, ref) === commit ? { type: 'moved', moveId, branch, commit, ref } : branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
    finally { await unlink(path).catch(() => undefined) }
  }

  /** Discards a bundle that will not be finished: the transfer was cut off or ended. */
  async abandon(incoming: IncomingBundle): Promise<void> {
    await incoming.close()
    await unlink(incoming.path).catch(() => undefined)
  }

  private async record(moveId: string, commit: string, ref: string): Promise<void> {
    const records = await this.records.read()
    records.moves[moveId] = { commit, ref, at: (this.options.now?.() ?? new Date()).toISOString() }
    const ids = Object.keys(records.moves)
    if (ids.length > RECORDS_MAX) {
      for (const old of ids.sort((a, b) => records.moves[a]!.at.localeCompare(records.moves[b]!.at)).slice(0, ids.length - RECORDS_MAX)) delete records.moves[old]
    }
    await this.records.write(records)
  }

  private stagedPath(moveId: string, way: 'in' | 'out'): string { return join(this.options.stagingDirectory, `${moveId}.${way}.bundle`) }
}

function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}
