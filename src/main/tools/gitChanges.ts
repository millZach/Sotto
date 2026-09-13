import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FilePath, FileWorkspace } from '../../shared/files'
import { fileRelativePathSchema } from '../../shared/files'
import { gitDiffRequestSchema, gitWatchRequestSchema, GIT_MAX_PATCH, type GitChange, type GitChangeListing, type GitFileDiff } from '../../shared/gitChanges'
import { toolListRequestSchema, type ToolTarget } from '../../shared/tools'
import type { FilesService } from '../files/service'
import { ToolOperations, fail, parse, workspace } from './common'

interface GitDependencies {
  files: FilesService
  copyPath(path: string): void
  reveal(path: string): void
  emit(event: ToolTarget & { revision: string }): void
  pollMs?: number
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
export class GitChangesService extends ToolOperations {
  private readonly watches = new Map<string, { target: ToolTarget; revision: string }>()
  private readonly children = new Set<ReturnType<typeof execFile>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  constructor(private readonly dependencies: GitDependencies) { super() }
  private git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('disposed'))
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && !['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].includes(key)) delete env[key as keyof typeof env]
    return new Promise((resolveOutput, reject) => {
      const child = execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.external=', ...args], { cwd, env, windowsHide: true, timeout: 10_000, maxBuffer, encoding: 'utf8' }, (error, stdout) => {
        this.children.delete(child)
        if (error) reject(error); else resolveOutput(stdout)
      })
      this.children.add(child)
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
      if (files.size >= 2000) { truncated = true; break }
      const status: GitChange['status'] = xy.includes('U') || ['AA', 'DD'].includes(xy) ? 'conflicted' : xy === '??' ? 'untracked' : xy.includes('R') ? 'renamed' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : xy.includes('T') ? 'type-changed' : 'modified'
      const originalPath = original?.startsWith(prefix) ? original.slice(prefix.length) : undefined
      files.set(path, { path, ...(originalPath && fileRelativePathSchema.safeParse(originalPath).success ? { originalPath } : {}), status, staged: xy[0] !== ' ' && xy[0] !== '?', unstaged: xy[1] !== ' ' })
      stamps.push(await this.safePath(owner, path).then(info => `${path}:${info.stamp}`, () => `${path}:unavailable`))
    }
    await workspace(this.dependencies.files, owner.threadId, owner.workspaceId)
    return { workspace: owner, branch, revision: digest(`${branch}\0${head}\0${raw}\0${stamps.join('\0')}`), files: [...files.values()], truncated }
  }
  diff(payload: unknown) { return this.run(async (): Promise<GitFileDiff> => {
    const request = parse(gitDiffRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const listing = await this.listing(owner)
    const entry = listing.files.find(file => file.path === request.path)
    const base = { workspace: owner, path: request.path, revision: listing.revision }
    const unavailable = (message: string): GitFileDiff => ({ ...base, content: { kind: 'unavailable', message } })
    if (!entry) return unavailable('This file is no longer in the current change list. Refresh Git changes.')
    let info: Awaited<ReturnType<GitChangesService['safePath']>>
    try {
      info = await this.safePath(owner, request.path)
      if (entry.originalPath) await this.safePath(owner, entry.originalPath)
    }
    catch { return unavailable('This file is unavailable or points outside the working directory.') }
    if (info.size > GIT_MAX_PATCH) return { ...base, content: { kind: 'too-large', message: 'This file exceeds the 512 KiB diff preview limit. Copy its path or reveal it externally.' } }
    const head = await this.git(owner.workingDirectory, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
    let patch: string
    if (entry.status === 'untracked' || !head) {
      if (!info.regular) return unavailable('This path is not an available regular file.')
      const preview = await this.dependencies.files.preview(request)
      if (!preview.ok) return { ...base, content: { kind: preview.error.code === 'too-large' ? 'too-large' : preview.error.code === 'binary' ? 'binary' : 'unavailable', message: preview.error.message } }
      if (preview.value.content.kind === 'image') return { ...base, content: { kind: 'binary', message: 'Binary content has no text diff. Reveal the file to inspect it.' } }
      const text = preview.value.content.text
      const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      patch = `diff --git a/${request.path} b/${request.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${request.path}\n@@ -0,0 +1,${text ? lines.length : 0} @@\n${text ? lines.map(line => '+' + line).join('\n') + '\n' : ''}${text && !text.endsWith('\n') ? '\\ No newline at end of file\n' : ''}`
    } else {
      try { patch = await this.git(owner.workingDirectory, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', request.path, ...(entry.originalPath ? [entry.originalPath] : [])], GIT_MAX_PATCH) }
      catch (error) { return { ...base, content: { kind: (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'too-large' : 'unavailable', message: 'This diff could not be read within the preview limits. Copy its path or reveal the file.' } } }
    }
    if (patch.length > GIT_MAX_PATCH) return { ...base, content: { kind: 'too-large', message: 'This diff exceeds the 512 KiB preview limit.' } }
    if (/^Binary files .* differ$/m.test(patch) || patch.includes('\0')) return { ...base, content: { kind: 'binary', message: 'Binary content has no text diff. Reveal the file to inspect it.' } }
    const current = await this.listing(owner)
    if (current.revision !== listing.revision) return unavailable('The working changes moved while this diff was read. Refresh to inspect the current version.')
    return { ...base, content: { kind: 'text', patch } }
  }) }
  private pathAction(payload: unknown, action: 'copyPath' | 'reveal') { return this.run(async (): Promise<FilePath> => {
    const request = parse(gitDiffRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const listing = await this.listing(owner)
    if (!listing.files.some(file => file.path === request.path)) return fail('path-unavailable', 'Refresh and select a changed file.')
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
