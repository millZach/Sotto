import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { FILES_MAX_ENTRIES, FILES_MAX_IMAGE_BYTES, FILES_MAX_TEXT_BYTES, fileListRequestSchema, fileRelativePathSchema, fileRequestSchema,
  type FileListing, type FilePath, type FilePreview, type FileWorkspace, type FilesError, type FilesResult } from '../../shared/files'
import { rasterImage } from './imagePreview'

export interface FilesBinding { threadId: string; projectId: string; workingDirectory: string }
export interface FilesDependencies {
  /** Resolve from current main-owned thread state, never a renderer-provided root. */
  resolveBinding(threadId: string): FilesBinding | null
  copyPath(path: string): void
  reveal(path: string): void
}
class FilesFailure extends Error {
  constructor(readonly code: FilesError['code'], message: string) { super(message) }
}
const fail = (code: FilesError['code'], message: string): never => { throw new FilesFailure(code, message) }
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs
const sameRevision = (a: BigIntStats, b: BigIntStats): boolean => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
interface Workspace { value: FileWorkspace; root: string }
interface Target { absolutePath: string; stats: BigIntStats }

export class FilesService {
  private active = 0
  constructor(private readonly dependencies: FilesDependencies) {}

  /** Shared main-owned identity boundary for terminal, browser and Git tools. */
  resolveWorkspace(threadId: string, expected?: string): Promise<FilesResult<FileWorkspace>> {
    return this.run(async () => (await this.workspace(threadId, expected)).value)
  }

  private async run<T>(operation: () => Promise<T>): Promise<FilesResult<T>> {
    if (this.active >= 4) return { ok: false, error: { code: 'busy', message: 'Files is busy. Try again shortly.' } }
    this.active++
    try { return { ok: true, value: await operation() } }
    catch (error) {
      if (error instanceof FilesFailure) return { ok: false, error: { code: error.code, message: error.message } }
      // Do not return raw OS errors: they can disclose a symlink's external target.
      const code = (error as NodeJS.ErrnoException)?.code
      return { ok: false, error: { code: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code ?? '') ? 'path-unavailable' : 'unavailable',
        message: 'This path is unavailable or changed. Refresh Files and try again.' } }
    } finally { this.active-- }
  }

  private async workspace(threadId: string, expected?: string): Promise<Workspace> {
    let binding: FilesBinding | null
    try { binding = this.dependencies.resolveBinding(threadId) }
    catch { return fail('workspace-unavailable', 'The thread working directory is not ready. Retry its setup, then refresh Files.') }
    if (!binding || binding.threadId !== threadId) return fail('thread-unavailable', 'This thread is unavailable. Select a thread and refresh Files.')
    if (!isAbsolute(binding.workingDirectory)) return fail('workspace-unavailable', 'The thread working directory is unavailable.')
    let root: string, info: BigIntStats
    try {
      root = await realpath(binding.workingDirectory)
      info = await stat(root, { bigint: true })
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch { return fail('workspace-unavailable', 'The thread working directory is unavailable. Restore the folder and refresh Files.') }
    const workspaceId = createHash('sha256').update(JSON.stringify([binding.threadId, binding.projectId, binding.workingDirectory, root, info.dev.toString(), info.ino.toString(), info.birthtimeNs.toString()])).digest('hex')
    const latest = this.dependencies.resolveBinding(threadId)
    if (!latest || latest.threadId !== binding.threadId || latest.projectId !== binding.projectId || latest.workingDirectory !== binding.workingDirectory) return fail('workspace-changed', 'The thread working directory changed. Refresh Files.')
    if (expected !== undefined && expected !== workspaceId) return fail('workspace-changed', 'The thread working directory changed. Refresh Files before selecting a path.')
    return { root, value: { ...binding, workspaceId } }
  }

  private async target(workspace: Workspace, path: string): Promise<Target> {
    if (!fileRelativePathSchema.safeParse(path).success) return fail('invalid-request', 'Use a relative workspace path.')
    const absolutePath = await realpath(resolve(workspace.root, path))
    if (!inside(workspace.root, absolutePath)) return fail('path-outside-workspace', 'This path points outside the thread working directory.')
    const stats = await stat(absolutePath, { bigint: true })
    return { absolutePath, stats }
  }

  private async verify(workspace: Workspace, path: string, target: Target, revision = false): Promise<void> {
    await this.workspace(workspace.value.threadId, workspace.value.workspaceId)
    const current = await this.target(workspace, path)
    if (current.absolutePath !== target.absolutePath || !(revision ? sameRevision(current.stats, target.stats) : sameFile(current.stats, target.stats))) {
      fail('path-unavailable', 'This path changed while it was being read. Refresh Files and try again.')
    }
  }

  list(payload: unknown): Promise<FilesResult<FileListing>> {
    return this.run(async () => {
      const parsed = fileListRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'Refresh the workspace and use a relative directory path.')
      const request = parsed.data
      const workspace = await this.workspace(request.threadId, request.workspaceId)
      const target = await this.target(workspace, request.path)
      if (!target.stats.isDirectory()) return fail('not-directory', 'Select a directory to browse.')
      const entries: FileListing['entries'] = []
      let truncated = false
      let scanned = 0
      // opendir streams a bounded set instead of allocating an unbounded readdir array.
      const directory = await opendir(target.absolutePath)
      try {
        await this.verify(workspace, request.path, target)
        for await (const entry of directory) {
          if (scanned++ === FILES_MAX_ENTRIES) { truncated = true; break }
          const path = request.path ? `${request.path}/${entry.name}` : entry.name
          if (!fileRelativePathSchema.safeParse(path).success) continue
          let kind: FileListing['entries'][number]['kind'] = 'unavailable'
          try {
            const child = await this.target(workspace, path)
            kind = child.stats.isDirectory() ? 'directory' : child.stats.isFile() ? 'file' : 'unavailable'
          } catch { /* Broken or escaping links are visible, but never followed into a preview. */ }
          entries.push({ name: entry.name, path, kind })
        }
      } finally { await directory.close().catch(() => undefined) }
      await this.verify(workspace, request.path, target)
      entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
      return { workspace: workspace.value, path: request.path, entries, truncated }
    })
  }

  preview(payload: unknown): Promise<FilesResult<FilePreview>> {
    return this.run(async () => {
      const parsed = fileRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'Refresh the workspace and select a file.')
      const request = parsed.data
      const workspace = await this.workspace(request.threadId, request.workspaceId)
      const target = await this.target(workspace, request.path)
      if (!target.stats.isFile()) return fail('not-file', 'Select a regular file to preview.')
      if (target.stats.size > BigInt(FILES_MAX_IMAGE_BYTES)) return fail('too-large', 'This file exceeds the 8 MiB preview limit.')
      // O_NONBLOCK avoids hanging if a regular file is exchanged for a FIFO; NOFOLLOW
      // rejects a last-component symlink exchange on platforms that provide it.
      const file = await open(target.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      let bytes: Buffer
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile() || !sameRevision(before, target.stats)) return fail('path-unavailable', 'This file changed. Refresh Files and try again.')
        await this.verify(workspace, request.path, target, true)
        bytes = Buffer.alloc(Number(before.size) + 1)
        let count = 0
        while (count < bytes.length) {
          const { bytesRead } = await file.read(bytes, count, bytes.length - count, count)
          if (!bytesRead) break
          count += bytesRead
        }
        if (BigInt(count) !== before.size || !sameRevision(before, await file.stat({ bigint: true }))) return fail('path-unavailable', 'This file changed while it was being read. Refresh Files and try again.')
        bytes = bytes.subarray(0, count)
        await this.verify(workspace, request.path, target, true)
      } finally { await file.close() }
      const base = { workspace: workspace.value, path: request.path, name: basename(request.path), size: bytes.length }
      const image = rasterImage(bytes)
      if (image) {
        if (!image.width || !image.height || image.width > 16_384 || image.height > 16_384 || image.width * image.height > 40_000_000) return fail('too-large', 'This image exceeds the preview dimensions limit.')
        return { ...base, content: { kind: 'image', mime: image.mime, dataUrl: `data:${image.mime};base64,${bytes.toString('base64')}` } }
      }
      if (bytes.length > FILES_MAX_TEXT_BYTES) return fail('too-large', 'Text previews are limited to 512 KiB.')
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { return fail('binary', 'This file is not supported UTF-8 text or a raster image.') }
      // eslint-disable-next-line no-control-regex -- Binary sniffing deliberately checks control bytes.
      if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return fail('binary', 'Binary files cannot be previewed as text.')
      return { ...base, content: { kind: ['.md', '.markdown', '.mdown'].includes(extname(request.path).toLowerCase()) ? 'markdown' : 'text', text } }
    })
  }

  private pathAction(payload: unknown, action: 'copyPath' | 'reveal'): Promise<FilesResult<FilePath>> {
    return this.run(async () => {
      const parsed = fileRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'Refresh the workspace and select a path.')
      const request = parsed.data
      const workspace = await this.workspace(request.threadId, request.workspaceId)
      const target = await this.target(workspace, request.path)
      if (!target.stats.isFile() && !target.stats.isDirectory()) return fail('path-unavailable', 'Select a regular file or directory.')
      await this.verify(workspace, request.path, target)
      this.dependencies[action](target.absolutePath)
      return { workspace: workspace.value, path: request.path, absolutePath: target.absolutePath }
    })
  }
  copyPath(payload: unknown): Promise<FilesResult<FilePath>> { return this.pathAction(payload, 'copyPath') }
  reveal(payload: unknown): Promise<FilesResult<FilePath>> { return this.pathAction(payload, 'reveal') }
}
