import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FilePath, FileWorkspace } from '../../shared/files'
import { fileRelativePathSchema } from '../../shared/files'
import { gitPathRequestSchema, gitReviewRequestSchema, gitWatchRequestSchema, GIT_MAX_PATCH, GIT_REVIEW_MAX_FILES, GIT_REVIEW_MAX_PATCH, type GitChange, type GitChangeListing, type GitReview, type GitReviewFile } from '../../shared/gitChanges'
import { toolListRequestSchema, type ToolTarget } from '../../shared/tools'
import type { FilesService } from '../files/service'
import { ToolOperations, fail, parse, workspace } from './common'
import type { CheckpointService } from './checkpoints'
import { parseNameStatusZ, parseNumstatZ, sectionIsBinary, sectionPath, splitPatch } from './gitReview'

interface GitDependencies {
  files: FilesService
  copyPath(path: string): void
  reveal(path: string): void
  emit(event: ToolTarget & { revision: string }): void
  pollMs?: number
  canMutate?(threadId: string): Promise<boolean> | boolean
  checkpoints?: CheckpointService
  /** A Git action changed this thread's folder, so the thread's Git status is read again without waiting for the timer. */
  acted?(threadId: string): void
}
interface GitRunOptions { readonly maxBuffer?: number; readonly env?: Readonly<Record<string, string>>; readonly input?: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
const TOO_LARGE_FILE = 'This file is past the 512 KiB diff preview limit. Copy its path or open it.'
const TOO_LARGE_REVIEW = 'This comparison is past the 2 MiB preview limit, so this file is not shown. Copy its path or open it.'
const BINARY = 'Binary file: no text diff.'

/**
 * Changes' reads of a thread's working folder: the change list (for the rail's count and the watch), and the
 * comparisons T3's diff panel shows, Working tree (the working copy against HEAD, untracked files included) and
 * Branch changes (`base...HEAD`). Nothing here stages, commits or switches; the Git action does that (ADR-0027).
 */
export class GitChangesService extends ToolOperations {
  private readonly mutations = new Set<string>()
  private readonly watches = new Map<string, { target: ToolTarget; revision: string }>()
  private readonly children = new Set<ReturnType<typeof execFile>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  constructor(private readonly dependencies: GitDependencies) { super() }
  async isMutating(threadId: string): Promise<boolean> {
    if (this.mutations.size === 0) return false
    const owner = await workspace(this.dependencies.files, threadId)
    return this.mutations.has(await realpath(owner.workingDirectory))
  }
  checkpoints(payload: unknown) { return this.dependencies.checkpoints?.checkpoints(payload) ?? this.run(async () => fail('unavailable', 'Checkpoints are unavailable in this window.')) }
  inspectCheckpoint(payload: unknown) { return this.dependencies.checkpoints?.inspectCheckpoint(payload) ?? this.run(async () => fail('unavailable', 'Checkpoints are unavailable in this window.')) }
  revertCheckpoint(payload: unknown) { return this.dependencies.checkpoints?.revertCheckpoint(payload) ?? this.run(async () => fail('unavailable', 'Checkpoints are unavailable in this window.')) }
  recoverCheckpoint(payload: unknown) { return this.dependencies.checkpoints?.recoverCheckpoint(payload) ?? this.run(async () => fail('unavailable', 'Checkpoints are unavailable in this window.')) }
  private git(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('disposed'))
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && !['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].includes(key)) delete env[key]
    Object.assign(env, options.env)
    return new Promise((resolveOutput, reject) => {
      const child = execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.external=', ...args], { cwd, env, windowsHide: true, timeout: 10_000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        this.children.delete(child)
        // The output read before a failure travels with it: an overflowing diff is still a diff.
        if (error) reject(Object.assign(error, { stdout })); else resolveOutput(stdout)
      })
      this.children.add(child)
      if (options.input !== undefined) child.stdin?.end(options.input)
    })
  }
  private async safePath(owner: FileWorkspace, path: string): Promise<{ absolutePath: string; existing: string; stamp: string; size: number; regular: boolean }> {
    const root = await realpath(owner.workingDirectory)
    const absolutePath = resolve(root, path)
    if (!inside(root, absolutePath)) return fail('path-unavailable', 'This path is outside the thread working directory.')
    let candidate = absolutePath
    for (;;) {
      try {
        const canonical = await realpath(candidate)
        if (!inside(root, canonical)) return fail('path-unavailable', 'This path points outside the thread working directory.')
        const info = await lstat(candidate)
        if (info.isSymbolicLink()) return fail('path-unavailable', 'Symbolic links are unavailable in Git previews.')
        return { absolutePath, existing: canonical, stamp: `${info.size}:${info.mtimeMs}:${info.ctimeMs}`, size: candidate === absolutePath ? info.size : 0, regular: candidate === absolutePath && info.isFile() }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        if (candidate === root) throw error
        candidate = dirname(candidate)
      }
    }
  }
  list(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    return this.listing(owner)
  }) }
  private async listing(owner: FileWorkspace): Promise<GitChangeListing> {
    let prefix: string, raw: string, head: string, branch: string | null
    try {
      prefix = (await this.git(owner.workingDirectory, ['rev-parse', '--show-prefix'])).trimEnd()
      raw = await this.git(owner.workingDirectory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
      head = await this.git(owner.workingDirectory, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim(), () => '')
      branch = await this.git(owner.workingDirectory, ['symbolic-ref', '--short', '-q', 'HEAD']).then(value => value.trim(), () => null)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail('too-large', 'The Git change list exceeds the safe preview limit. Open the working directory externally.')
      return fail('not-repository', 'Git is unavailable or this thread working directory is not a Git repository.')
    }
    const files = new Map<string, GitChange>()
    const records = raw.split('\0')
    let truncated = false
    const stamps: string[] = []
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!
      if (!record) continue
      const xy = record.slice(0, 2), repositoryPath = record.slice(3)
      const original = /[RC]/.test(xy) ? records[++index] : undefined
      if (!repositoryPath.startsWith(prefix)) continue
      const path = repositoryPath.slice(prefix.length)
      if (!fileRelativePathSchema.safeParse(path).success || !path) { truncated = true; continue }
      if (files.size >= GIT_REVIEW_MAX_FILES) { truncated = true; break }
      const status: GitChange['status'] = xy.includes('U') || ['AA', 'DD'].includes(xy) ? 'conflicted' : xy === '??' ? 'untracked' : xy.includes('R') ? 'renamed' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : xy.includes('T') ? 'type-changed' : 'modified'
      const originalPath = original?.startsWith(prefix) ? original.slice(prefix.length) : undefined
      files.set(path, { path, ...(originalPath && fileRelativePathSchema.safeParse(originalPath).success ? { originalPath } : {}), status })
      stamps.push(await this.safePath(owner, path).then(info => `${path}:${info.stamp}`, () => `${path}:unavailable`))
    }
    await workspace(this.dependencies.files, owner.threadId, owner.workspaceId)
    const indexState = await this.git(owner.workingDirectory, ['ls-files', '--stage', '-z'])
    return { workspace: owner, branch, revision: digest(`${branch}\0${head}\0${raw}\0${indexState}\0${stamps.join('\0')}`), files: [...files.values()], truncated }
  }
  /**
   * T3's automatic base for Branch changes: the branch's recorded `gh-merge-base`, the remote's default branch,
   * then `main` and `master`, each as the primary remote's copy when it has one and the local branch otherwise,
   * never the branch itself. Null when none exists.
   */
  private async automaticBase(cwd: string, branch: string): Promise<string | null> {
    const exists = (ref: string): Promise<boolean> => this.git(cwd, ['show-ref', '--verify', '--quiet', ref]).then(() => true, () => false)
    const configured = (await this.git(cwd, ['config', '--get', `branch.${branch}.gh-merge-base`]).catch(() => '')).trim()
    const remotes = (await this.git(cwd, ['remote']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean)
    const primary = remotes.includes('origin') ? 'origin' : remotes[0] ?? null
    const head = primary ? (await this.git(cwd, ['symbolic-ref', '--short', '-q', `refs/remotes/${primary}/HEAD`]).catch(() => '')).trim() : ''
    const defaultBranch = primary && head.startsWith(`${primary}/`) ? head.slice(primary.length + 1) : null
    for (const candidate of [configured || null, defaultBranch, 'main', 'master']) {
      if (!candidate) continue
      const name = candidate.startsWith('origin/') ? candidate.slice('origin/'.length) : primary && candidate.startsWith(`${primary}/`) ? candidate.slice(primary.length + 1) : candidate
      if (!name || name === branch || name.startsWith('-')) continue
      if (primary && await exists(`refs/remotes/${primary}/${name}`)) return `${primary}/${name}`
      if (await exists(`refs/heads/${name}`)) return name
    }
    return null
  }
  review(payload: unknown) { return this.run(() => this.readReview(payload)) }
  private async readReview(payload: unknown, retry = true): Promise<GitReview> {
    const request = parse(gitReviewRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const listing = await this.listing(owner)
    const cwd = owner.workingDirectory
    const hasHead = await this.git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false)
    const empty = (scope: GitReview['scope']): GitReview => ({ workspace: owner, revision: listing.revision, scope, files: [], truncated: false })
    let scope: GitReview['scope']
    let range: string
    const extra: GitReviewFile[] = []
    let temporary: string | null = null
    const env: Record<string, string> = {}
    try {
      if (request.scope.kind === 'working') {
        scope = { kind: 'working' }
        range = hasHead ? 'HEAD' : (await this.git(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim()
        // Untracked files join the comparison through a copy of the index that marks them intent-to-add, as T3
        // does; the real index is never written. A file too large, not regular or reaching outside is listed without.
        const untracked: string[] = []
        for (const file of listing.files.filter(item => item.status === 'untracked')) {
          let info: Awaited<ReturnType<GitChangesService['safePath']>> | null = null
          try { info = await this.safePath(owner, file.path) } catch { info = null }
          const skipped = (content: GitReviewFile['content']): void => { extra.push({ path: file.path, status: 'untracked', additions: null, deletions: null, content }) }
          if (!info || !info.regular) skipped({ kind: 'unavailable', message: 'This path is not an available regular file.' })
          else if (info.size > GIT_MAX_PATCH) skipped({ kind: 'too-large', message: TOO_LARGE_FILE })
          else untracked.push(file.path)
        }
        if (untracked.length > 0) {
          temporary = await mkdtemp(join(tmpdir(), 'sotto-changes-'))
          const index = join(temporary, 'index')
          env.GIT_INDEX_FILE = index
          const real = resolve(cwd, (await this.git(cwd, ['rev-parse', '--git-path', 'index'])).trim())
          try { await copyFile(real, index) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.git(cwd, ['read-tree', '--empty'], { env }) }
          await this.git(cwd, ['-c', 'core.splitIndex=false', 'update-index', '--no-split-index'], { env }).catch(() => undefined)
          await this.git(cwd, ['-c', 'core.splitIndex=false', 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${untracked.join('\0')}\0` })
        }
      } else {
        const branch = listing.branch
        if (!hasHead) return fail('blocked', 'This branch has no commits yet, so there are no branch changes to compare.')
        if (!branch) return fail('blocked', 'Branch changes compare a branch with its base. This working copy is on a detached HEAD.')
        const automatic = request.scope.base === null
        const base = request.scope.base ?? await this.automaticBase(cwd, branch)
        if (base === null) return empty({ kind: 'branch', base: null, automatic, head: branch })
        const known = await this.git(cwd, ['rev-parse', '--verify', '-q', '--end-of-options', `${base}^{commit}`]).then(() => true, () => false)
        if (!known) return fail('path-unavailable', `${base} is not a branch in this repository. Choose another base.`)
        scope = { kind: 'branch', base, automatic, head: branch }
        range = `${base}...HEAD`
      }
      const diff = ['-c', 'core.bigFileThreshold=512k', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--relative', '--src-prefix=a/', '--dst-prefix=b/', ...(request.ignoreWhitespace ? ['--ignore-all-space'] : [])]
      const nameStatus = parseNameStatusZ(await this.git(cwd, [...diff, '--name-status', '-z', range, '--'], { env }))
      const numstat = new Map(parseNumstatZ(await this.git(cwd, [...diff, '--numstat', '-z', range, '--'], { env })).map(entry => [entry.path, entry]))
      let patch: string, overflowed = false
      try { patch = await this.git(cwd, [...diff, '--patch', range, '--'], { env, maxBuffer: GIT_REVIEW_MAX_PATCH }) }
      catch (error) {
        const partial = error as { code?: unknown; stdout?: unknown }
        if (partial.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || typeof partial.stdout !== 'string') throw error
        patch = partial.stdout; overflowed = true
      }
      const sections = splitPatch(patch)
      const incomplete = overflowed ? sections.at(-1) : undefined
      const byPath = new Map<string, string>()
      for (const section of sections) { const path = sectionPath(section); if (path !== null && !byPath.has(path)) byPath.set(path, section) }
      const files: GitReviewFile[] = [...extra]
      const untrackedPaths = new Set(listing.files.filter(item => item.status === 'untracked').map(item => item.path))
      for (const entry of nameStatus) {
        if (!fileRelativePathSchema.safeParse(entry.path).success || entry.originalPath !== undefined && !fileRelativePathSchema.safeParse(entry.originalPath).success) continue
        const counts = numstat.get(entry.path)
        const section = byPath.get(entry.path)
        let content: GitReviewFile['content']
        if (!section || section === incomplete) content = overflowed ? { kind: 'too-large', message: TOO_LARGE_REVIEW } : { kind: 'unavailable', message: 'Git gave no text diff for this file.' }
        else if (sectionIsBinary(section)) {
          const size = request.scope.kind === 'working' && entry.status !== 'deleted' ? await this.safePath(owner, entry.path).then(info => info.size, () => 0) : 0
          content = size > GIT_MAX_PATCH ? { kind: 'too-large', message: TOO_LARGE_FILE } : { kind: 'binary', message: BINARY }
        }
        else if (section.length > GIT_MAX_PATCH) content = { kind: 'too-large', message: TOO_LARGE_FILE }
        else content = { kind: 'text', patch: section }
        const status = request.scope.kind === 'working' && entry.status === 'added' && untrackedPaths.has(entry.path) ? 'untracked' : entry.status
        files.push({ path: entry.path, ...(entry.originalPath ? { originalPath: entry.originalPath } : {}), status, additions: counts?.additions ?? null, deletions: counts?.deletions ?? null, content })
      }
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const truncated = files.length > GIT_REVIEW_MAX_FILES || (request.scope.kind === 'working' && listing.truncated)
      if (request.scope.kind === 'working' && retry) {
        const current = await this.listing(owner)
        if (current.revision !== listing.revision) {
          if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
          temporary = null
          return this.readReview(payload, false)
        }
      }
      return { workspace: owner, revision: listing.revision, scope, files: files.slice(0, GIT_REVIEW_MAX_FILES), truncated }
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail('too-large', 'This comparison is too large to list. Review it with Git directly.')
      throw error
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  private pathAction(payload: unknown, action: 'copyPath' | 'reveal') { return this.run(async (): Promise<FilePath> => {
    const request = parse(gitPathRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const info = await this.safePath(owner, request.path)
    await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    this.dependencies[action](action === 'copyPath' ? info.absolutePath : info.existing)
    return { workspace: owner, path: request.path, absolutePath: info.absolutePath }
  }) }
  copyPath(payload: unknown) { return this.pathAction(payload, 'copyPath') }
  reveal(payload: unknown) { return this.pathAction(payload, 'reveal') }
  watch(payload: unknown) { return this.run(async () => {
    const request = parse(gitWatchRequestSchema, payload)
    if (!request.enabled) { this.watches.delete(request.workspaceId); return }
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    if (!this.watches.has(owner.workspaceId) && this.watches.size >= 8) return fail('busy', 'Too many Git workspaces are being watched.')
    if (this.disposed) return
    this.watches.set(owner.workspaceId, { target: { threadId: owner.threadId, workspaceId: owner.workspaceId }, revision: '' })
    if (!this.timer) { this.timer = setInterval(() => { void this.poll() }, this.dependencies.pollMs ?? 2000); this.timer.unref() }
  }) }
  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    try {
      for (const watch of this.watches.values()) {
        const result = await this.list(watch.target)
        if (this.disposed || this.watches.get(watch.target.workspaceId) !== watch) continue
        const revision = result.ok ? result.value.revision : `error:${result.error.code}`
        if (revision !== watch.revision) { watch.revision = revision; this.dependencies.emit({ ...watch.target, revision }) }
      }
    } finally { this.polling = false }
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.watches.clear()
    for (const child of this.children) child.kill()
    this.children.clear()
  }
}
