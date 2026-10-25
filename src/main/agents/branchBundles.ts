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
const SNAPSHOT_MESSAGE = 'Snapshot of uncommitted work for a check\n\nMade by Sotto from a temporary index. It is on no branch, and the working tree it came from is unchanged.\n'
/** A bundle staged for sending, with what the receiver checks it against. */
export interface PreparedBundle { readonly type: 'sending'; readonly path: string; readonly size: number; readonly sha256: string }
/** The receiver already has the commit, from the tips it named: no bundle is needed, only its incoming ref. */
export interface AlreadyPresent { readonly type: 'present' }

/**
 * Each move a receiver took, by its ID, with the commit and ref it was for. Written before anything is imported, so a
 * retry of the same move is answered from it and a move ID that comes back with another commit is refused (ADR-0105).
 */
const recordsSchema = z.object({ v: z.literal(1), moves: z.record(z.string(), z.object({ commit: commitIdSchema, ref: z.string(), at: z.string() })) })
type Records = z.infer<typeof recordsSchema>
/** Records kept, newest by time; one a later move pushes out only stops an old retry being recognised. */
const RECORDS_MAX = 1000

/**
 * The bundle and test-run snapshot index file names this module stages, so a start clears what a crash left and nothing else: the move, then the
 * attempt, so an attempt that outlives its connection can only ever remove its own file.
 */
const STAGED = /^[0-9a-f-]{36}\.(?:[0-9a-f-]{36}\.(?:in|out)\.bundle|snapshot\.index)$/u

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

/**
 * The fence between a move and its incoming ref: once the move is ended, by `end` or by its connection closing, no ref is
 * created for it. The check and the start of the write happen in one turn, so an end either comes first and stops the
 * ref, or comes after and waits for the write in `cancel`.
 */
export class MoveFence {
  private ended = false
  private landing: Promise<void> | undefined
  /** Whether the move was ended, so nothing more of it may land. */
  get cancelled(): boolean { return this.ended }
  /** Runs `write`, which creates the incoming ref, unless the move was ended first: null when it was. */
  land<T>(write: () => Promise<T>): Promise<T> | null { return MoveFence.land([this], write) }
  /**
   * Runs `write` behind every fence at once, as when a move's own fence and its bundle's both guard one ref: null when any
   * of them was ended first, and each one's `cancel` waits for the write once it has begun.
   */
  static land<T>(fences: readonly MoveFence[], write: () => Promise<T>): Promise<T> | null {
    if (fences.some(fence => fence.ended)) return null
    const landing = write()
    const settled = landing.then(() => undefined, () => undefined)
    for (const fence of fences) fence.landing = settled
    return landing
  }
  /** Ends the move. Once this resolves no ref is created for it: a landing already under way has finished. */
  async cancel(): Promise<void> { this.ended = true; await this.landing }
}

/** A bundle arriving in order, staged until it is whole, and fenced like every move. */
export class IncomingBundle extends MoveFence {
  received = 0
  private readonly hash: Hash = createHash('sha256')
  private closed = false
  constructor(readonly moveId: string, readonly repository: string, readonly branch: string, readonly commit: string, readonly size: number,
    readonly sha256: string, readonly path: string, private readonly handle: FileHandle) { super() }
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
  /** The records' last read-modify-write, which the next one waits for, so moves finishing together each keep theirs. */
  private recording: Promise<void> = Promise.resolve()
  /** Each move's outgoing ref in use, so two attempts at one move never point, bundle or remove it at the same time. */
  private readonly outgoing = new Map<string, Promise<unknown>>()
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

  /**
   * Whether `oid` names a commit this repository has. A blob or a tree passes `rev-list --count <oid> --not --all` as
   * readily as a reachable commit does, so nothing is recorded or published for an object until this says it is a commit.
   */
  private async isCommit(repository: string, oid: string): Promise<boolean> {
    try { return (await this.git(repository, ['cat-file', '-t', oid], undefined, 30_000)).trim() === 'commit' } catch { return false }
  }

  /** Whether `ref` is a symbolic ref, whether or not what it points at exists. */
  private async symbolic(repository: string, ref: string): Promise<boolean> {
    try { await this.git(repository, ['symbolic-ref', '--quiet', ref], undefined, 30_000); return true } catch { return false }
  }

  // The sending side.

  /**
   * The branch a working copy is on and the commit it names, checked: anything `git status --porcelain` lists refuses the
   * move, asking for a commit first, and so does a working copy on no branch. Sotto never commits or stashes for anyone.
   */
  async branchOf(workingCopy: string): Promise<BranchSource | BranchMoveRefusal> {
    if (!await this.isRepository(workingCopy)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    try {
      if ((await this.git(workingCopy, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], undefined, 60_000)).trim()) return branchMoveRefusal('uncommitted', branchMoveWords.uncommitted)
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
      if (!(await this.git(workingCopy, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], undefined, 60_000)).trim()) return { branch, commit: head }
      if (await this.dirtySubmodule(workingCopy)) return branchMoveRefusal('uncommitted', branchMoveWords.submoduleChanges)
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
   * Whether a submodule of the working copy has changes of its own, tracked or untracked. `git add -A` in the parent takes
   * only a submodule's commit, so a check's snapshot would leave that work behind while saying it carried everything.
   * Porcelain v2 marks a submodule `S<c><m><u>`: `M` for its tracked changes, `U` for its untracked files.
   * `--ignore-submodules=none` here and in the status calls before it, so a repository's `submodule.<name>.ignore` set to
   * `dirty` or `all` cannot make a changed submodule read as clean.
   */
  private async dirtySubmodule(workingCopy: string): Promise<boolean> {
    const lines = (await this.git(workingCopy, ['status', '--porcelain=v2', '--untracked-files=normal', '--ignore-submodules=none'], undefined, 60_000)).split(/\r?\n/u)
    return lines.some(line => {
      const fields = line.split(' ')
      const sub = fields[2] ?? ''
      return (fields[0] === '1' || fields[0] === '2') && sub.startsWith('S') && (sub[2] === 'M' || sub[3] === 'U')
    })
  }

  /**
   * Lands a branch on the same machine, for a worker started there from a thread's branch: in `repository`'s incoming ref
   * for the move, written once, as a move lands. When `repository` already has the commit and its history, as a thread's
   * worktree and its project's checkout share one object store, only the ref is written; otherwise, as for a test-run
   * snapshot that no ref names yet, the commit goes across from `from` as a bundle staged here and taken in at once. A copy
   * ended through `fence` creates no ref, as a move ended over the socket does not.
   */
  async copy(input: { readonly from: string; readonly source: BranchSource; readonly repository: string; readonly moveId: string; readonly fence?: MoveFence }): Promise<BranchMoved | BranchMoveRefusal> {
    const { source, repository, moveId, fence } = input
    const carried = (moved: BranchMoved | BranchMoveRefusal): BranchMoved | BranchMoveRefusal => moved.type === 'moved' && source.snapshot ? { ...moved, snapshot: source.snapshot } : moved
    const cutOff = (): BranchMoveRefusal => branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    if (fence?.cancelled) return cutOff()
    const tips = await this.tips(repository)
    if (!Array.isArray(tips)) return tips
    const prepared = await this.prepare({ repository: input.from, moveId, commit: source.commit, bases: tips })
    if (prepared.type === 'refused') return prepared
    if (prepared.type === 'present') return carried(await this.receiveRef({ repository, moveId, branch: source.branch, commit: source.commit, ...fence ? { fence } : {} }))
    // Whatever stops the copy before its finish, a read or write that fails included, abandons what it staged here
    // (ADR-0105 decision 8): its handle is closed and its file removed, never left for the next start to clear.
    let incoming: IncomingBundle | undefined
    let finishing = false
    try {
      if (fence?.cancelled) return cutOff()
      const begun = await this.receive({ repository, moveId, branch: source.branch, commit: source.commit, size: prepared.size, sha256: prepared.sha256 })
      if (!(begun instanceof IncomingBundle)) return carried(begun)
      incoming = begun
      for (let offset = 0; offset < prepared.size;) {
        if (fence?.cancelled) return cutOff()
        const chunk = await this.readChunk(prepared.path, offset)
        if (chunk.byteLength === 0 || !await incoming.write(offset, chunk)) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
        offset += chunk.byteLength
      }
      finishing = true
      return carried(await this.finish(incoming, fence))
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
    finally {
      if (incoming && !finishing) await this.abandon(incoming)
      await this.discard(prepared)
    }
  }

  /** Removes the incoming ref a move landed in `repository`, for a start that never made its worktree. Best effort. */
  async forget(repository: string, moveId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(moveId)) return
    try {
      const refs = (await this.git(repository, ['for-each-ref', '--format=%(refname)', `refs/sotto/incoming/${moveId}/`], undefined, 30_000)).split(/\r?\n/u).filter(Boolean)
      for (const ref of refs) await this.git(repository, ['update-ref', '-d', '--no-deref', ref], undefined, 30_000)
    } catch { /* Kept: its commits stay until the thread goes. */ }
  }

  /**
   * The receiver's newest tips, which a sender bundles against so the bundle carries only what they lack: its branches,
   * its remote-tracking branches, and the incoming refs earlier moves left, so moving a branch again sends only what is new.
   */
  async tips(repository: string): Promise<string[] | BranchMoveRefusal> {
    if (!await this.isRepository(repository)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    try {
      const output = await this.git(repository, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_TIPS_MAX * 2}`, '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/sotto/incoming'], undefined, 30_000)
      return [...new Set(output.split(/\r?\n/u).map(line => line.trim()).filter(line => commitIdSchema.safeParse(line).success))].slice(0, BRANCH_TIPS_MAX)
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
  }

  /**
   * Stages a bundle of `commit` for a move, against the bases the receiver named that this repository also has. Git bundles
   * only a named ref, so the commit is pointed at by `refs/sotto/outgoing/<move>` while the bundle is written, and the ref
   * is removed straight after. When the receiver already has the commit, nothing is staged and the answer says so: the
   * receiver only needs its incoming ref (`receiveRef`), and no object it has travels again.
   */
  async prepare(input: { readonly repository: string; readonly moveId: string; readonly commit: string; readonly bases: readonly string[] }): Promise<PreparedBundle | AlreadyPresent | BranchMoveRefusal> {
    await this.start()
    const path = this.stagedPath(input.moveId, 'out')
    try {
      const bases = await this.present(input.repository, input.bases)
      if (bases.length > 0 && (await this.git(input.repository, ['rev-list', '--count', input.commit, '--stdin'], bases.map(base => '^' + base).join('\n') + '\n')).trim() === '0') {
        return { type: 'present' }
      }
      const written = await this.withOutgoingRef(input.moveId, async ref => {
        // A symbolic ref already in the outgoing ref's place is never written through or removed: pointing it, or deleting
        // it, would move or delete the branch it names. Both writes use `--no-deref` so only the ref itself is touched.
        if (await this.symbolic(input.repository, ref)) return false
        await this.git(input.repository, ['update-ref', '--no-deref', ref, input.commit], undefined, 30_000)
        try {
          await this.git(input.repository, ['bundle', 'create', '--quiet', path, ref, '--stdin'], bases.map(base => '^' + base).join('\n') + '\n', 600_000)
        } finally { await this.git(input.repository, ['update-ref', '--no-deref', '-d', ref], undefined, 30_000).catch(() => undefined) }
        return true
      })
      if (!written) return branchMoveRefusal('failed', branchMoveWords.outgoingRefChanged)
      const { size } = await stat(path)
      if (size > this.maxBytes) { await unlink(path).catch(() => undefined); return branchMoveRefusal('too-large', branchMoveWords.tooLarge(size, this.maxBytes)) }
      return { type: 'sending', path, size, sha256: await fileDigest(path) }
    } catch {
      await unlink(path).catch(() => undefined)
      return branchMoveRefusal('failed', branchMoveWords.failed)
    }
  }

  /** Runs `use` with the move's outgoing ref to itself, once any other attempt at the same move has finished with it. */
  private withOutgoingRef<T>(moveId: string, use: (ref: string) => Promise<T>): Promise<T> {
    const mine = (this.outgoing.get(moveId) ?? Promise.resolve()).then(() => use(outgoingRef(moveId)))
    const settled = mine.catch(() => undefined)
    this.outgoing.set(moveId, settled)
    void settled.then(() => { if (this.outgoing.get(moveId) === settled) this.outgoing.delete(moveId) })
    return mine
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

  /** Removes a bundle staged for sending: that attempt's file only, so another attempt at the same move keeps its own. */
  async discard(prepared: PreparedBundle): Promise<void> {
    await unlink(prepared.path).catch(() => undefined)
  }

  // The receiving side.

  /**
   * Starts taking a move into `repository`. A retry of a move that already landed, with the same commit, answers as done
   * and writes nothing; a move whose ID was recorded with another commit, or whose ref already names another, is refused.
   */
  async receive(input: { readonly repository: string; readonly moveId: string; readonly branch: string; readonly commit: string; readonly size: number; readonly sha256: string }): Promise<IncomingBundle | BranchMoved | BranchMoveRefusal> {
    await this.start()
    const admitted = await this.admit(input.repository, input.moveId, input.branch, input.commit)
    if (admitted !== null) return admitted
    if (input.size > this.maxBytes) return branchMoveRefusal('too-large', branchMoveWords.tooLarge(input.size, this.maxBytes))
    const path = this.stagedPath(input.moveId, 'in')
    try {
      const handle = await open(path, 'wx')
      return new IncomingBundle(input.moveId, input.repository, input.branch, input.commit, input.size, input.sha256, path, handle)
    } catch { return branchMoveRefusal('busy', branchMoveWords.busy) }
  }

  /**
   * Lands a move whose commit this repository already has, as the sender found from the tips it was given: no bundle, only
   * the incoming ref. The commit must be reachable from one of this repository's refs, so every object it needs is here;
   * otherwise the move is refused and a retry, with fresh tips, sends a bundle. A move ended through `fence` while it is
   * checked creates no ref.
   */
  async receiveRef(input: { readonly repository: string; readonly moveId: string; readonly branch: string; readonly commit: string; readonly fence?: MoveFence }): Promise<BranchMoved | BranchMoveRefusal> {
    const { repository, moveId, branch, commit } = input
    const fence = input.fence ?? new MoveFence()
    const admitted = await this.admit(repository, moveId, branch, commit)
    if (admitted !== null) return admitted
    try {
      if (!await this.isCommit(repository, commit)) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      let missing: string
      try { missing = (await this.git(repository, ['rev-list', '--count', commit, '--not', '--all'], undefined, 60_000)).trim() } catch { missing = '' }
      if (missing !== '0') return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      if (fence.cancelled) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
      const ref = incomingRef(moveId, branch)
      await this.record(moveId, commit, ref)
      // The same fence as a bundle's: a move ended while it was checked or recorded creates no ref.
      const landing = fence.land(() => this.createRef(repository, moveId, branch, commit))
      return landing ? await landing : branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
  }

  /** What every receive checks first: a repository, a ref Git takes, and whether this move already landed or conflicts. */
  private async admit(repository: string, moveId: string, branch: string, commit: string): Promise<BranchMoved | BranchMoveRefusal | null> {
    if (!await this.isRepository(repository)) return branchMoveRefusal('not-a-repository', branchMoveWords.notARepository)
    const ref = incomingRef(moveId, branch)
    try { await this.git(repository, ['check-ref-format', ref], undefined, 30_000) } catch { return branchMoveRefusal('unsupported', branchMoveWords.branchName) }
    return this.landed(repository, moveId, ref, commit)
  }

  /** Creates the move's incoming ref only if it does not exist, and reads it back. */
  private async createRef(repository: string, moveId: string, branch: string, commit: string): Promise<BranchMoved | BranchMoveRefusal> {
    const ref = incomingRef(moveId, branch)
    if (!await this.isCommit(repository, commit)) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
    if (await this.symbolic(repository, ref)) return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
    // `--no-deref`: the ref itself is written, never a branch a symbolic ref put in its place points at.
    try { await this.git(repository, ['update-ref', '--no-deref', ref, commit, ''], undefined, 30_000) } catch { /* Read back below: another writer or a lost answer. */ }
    return await this.refCommit(repository, ref) === commit ? { type: 'moved', moveId, branch, commit, ref } : branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
  }

  /** Done for a retry of a move that landed; refused for one that conflicts with what is here; null when it may go ahead. */
  private async landed(repository: string, moveId: string, ref: string, commit: string): Promise<BranchMoved | BranchMoveRefusal | null> {
    const record = (await this.records.read()).moves[moveId]
    if (record && (record.commit !== commit || record.ref !== ref)) return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
    // A symbolic ref where the incoming ref goes, even one pointing nowhere, is never written through or counted as landed.
    if (await this.symbolic(repository, ref)) return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
    const existing = await this.refCommit(repository, ref)
    if (existing === null) return null
    if (record && existing === commit) return { type: 'moved', moveId, branch: ref.slice(`refs/sotto/incoming/${moveId}/`.length), commit, ref }
    return branchMoveRefusal('move-differs', branchMoveWords.moveDiffers)
  }

  /**
   * Lands a whole bundle: its size and SHA-256 as the sender named them, `git bundle verify` in the receiving repository,
   * and exactly one ref, the sender's outgoing ref for this move, naming the commit. The objects are imported without
   * writing any ref, the commit is checked to be a commit, the move is recorded, and the incoming ref created only if it
   * does not exist, then read back. The staged file is removed whatever happens.
   */
  async finish(incoming: IncomingBundle, fence?: MoveFence): Promise<BranchMoved | BranchMoveRefusal> {
    const fences = fence ? [incoming, fence] : [incoming]
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
      if (fences.some(each => each.cancelled)) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
      await this.git(repository, ['bundle', 'unbundle', path], undefined, 600_000)
      // A bundle whose one ref names a blob or a tree verifies and imports like any other, so its object's type is
      // checked before the move is recorded: a record of what never landed would turn a good retry into move-differs.
      if (!await this.isCommit(repository, commit)) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      if (fences.some(each => each.cancelled)) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
      await this.record(moveId, commit, ref)
      // The fence: a move ended while it was checked or imported creates no ref. Its objects stay, unreferenced, for Git
      // to collect, and its record lets a retry go ahead.
      const landing = MoveFence.land(fences, () => this.createRef(repository, moveId, branch, commit))
      return landing ? await landing : branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    } catch { return branchMoveRefusal('failed', branchMoveWords.failed) }
    finally { await unlink(path).catch(() => undefined) }
  }

  /**
   * Discards a bundle that will not be finished: the transfer was cut off or ended. A finish under way creates no ref
   * after this resolves.
   */
  async abandon(incoming: IncomingBundle): Promise<void> {
    await incoming.cancel()
    await incoming.close()
    await unlink(incoming.path).catch(() => undefined)
  }

  private record(moveId: string, commit: string, ref: string): Promise<void> {
    const recorded = this.recording.then(async () => {
      const records = await this.records.read()
      records.moves[moveId] = { commit, ref, at: (this.options.now?.() ?? new Date()).toISOString() }
      const ids = Object.keys(records.moves)
      if (ids.length > RECORDS_MAX) {
        for (const old of ids.sort((a, b) => records.moves[a]!.at.localeCompare(records.moves[b]!.at)).slice(0, ids.length - RECORDS_MAX)) delete records.moves[old]
      }
      await this.records.write(records)
    })
    this.recording = recorded.catch(() => undefined)
    return recorded
  }

  /** A new attempt's staged file for a move. */
  private stagedPath(moveId: string, way: 'in' | 'out'): string { return join(this.options.stagingDirectory, `${moveId}.${randomUUID()}.${way}.bundle`) }
}

function fileDigest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}
