import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { FILES_DOWNLOAD_PART_BYTES, FILES_MAX_CONCURRENT_REQUESTS, FILES_MAX_ENTRIES, FILES_MAX_IMAGE_BYTES, FILES_MAX_TEXT_BYTES, fileLinkRequestSchema, fileListRequestSchema, fileRelativePathSchema, fileRequestSchema, isMarkdownFileName, isProgramFileName, linkedFileRequestSchema, withDriveFirst, withoutLinkLocation,
  type FileLink, type FileLinkOpened, type FileLinkPreview, type FileListing, type FilePath, type FilePreview, type FileWorkspace, type FilesError, type FilesResult, type LinkedFile } from '../../shared/files'
import { rasterImage } from './imagePreview'

export interface FilesBinding { threadId: string; projectId: string; workingDirectory: string; previewOnly?: boolean }
export interface FilesDependencies {
  /** Resolve from current main-owned thread state, never a renderer-provided root. */
  resolveBinding(threadId: string): FilesBinding | null
  copyPath(path: string): void | Promise<void>
  reveal(path: string): void
  /** Opens a file in its own app, or a folder in the file manager. Absent on a host's own reads, which open nothing. */
  open?(path: string): Promise<void>
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
/** A file's whole contents, refused when it changed during the read. */
async function wholeFile(file: FileHandle, before: BigIntStats): Promise<Buffer> {
  const bytes = Buffer.alloc(Number(before.size) + 1)
  let count = 0
  while (count < bytes.length) {
    const { bytesRead } = await file.read(bytes, count, bytes.length - count, count)
    if (!bytesRead) break
    count += bytesRead
  }
  if (BigInt(count) !== before.size || !sameRevision(before, await file.stat({ bigint: true }))) return fail('path-unavailable', 'This file changed while it was being read. Refresh Files and try again.')
  return bytes.subarray(0, count)
}
/** UTF-8 text, or a refusal for anything that reads as binary. */
function textOf(bytes: Buffer): string {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return fail('binary', 'This file is not supported UTF-8 text or a raster image.') }
  // eslint-disable-next-line no-control-regex -- Binary sniffing deliberately checks control bytes.
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return fail('binary', 'Binary files cannot be previewed as text.')
  return text
}
/** What a preview shows of a file's bytes: a raster picture, or text within the text limit. */
function previewContent(bytes: Buffer, name: string): FilePreview['content'] {
  const image = rasterImage(bytes)
  if (image) {
    if (!image.width || !image.height || image.width > 16_384 || image.height > 16_384 || image.width * image.height > 40_000_000) return fail('too-large', 'This image exceeds the preview dimensions limit.')
    return { kind: 'image', mime: image.mime, dataUrl: `data:${image.mime};base64,${bytes.toString('base64')}` }
  }
  if (bytes.length > FILES_MAX_TEXT_BYTES) return fail('too-large', 'Text previews are limited to 512 KiB.')
  return { kind: isMarkdownFileName(name) ? 'markdown' : 'text', text: textOf(bytes) }
}
/** A file's own name, whichever separator its path is written with. */
const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
/**
 * Whether a file starts as a program does: a Windows, Linux or Mac executable, or a script that names its interpreter.
 * Read from the file itself, since a name can say anything. A file that cannot be read is taken for one, so it is never opened.
 */
async function startsAsProgram(path: string): Promise<boolean> {
  let file: FileHandle
  try { file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)) } catch { return true }
  try {
    const head = Buffer.alloc(4)
    const { bytesRead } = await file.read(head, 0, 4, 0)
    const magic = head.subarray(0, bytesRead).toString('hex')
    return magic.startsWith('4d5a') || magic === '7f454c46' || magic.startsWith('2321')
      || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)
  } catch { return true } finally { await file.close().catch(() => undefined) }
}
interface Workspace { value: FileWorkspace; root: string }
interface LocatedLink { absolutePath: string; stats: BigIntStats; written: string; relativeToThread: boolean }
interface Target { absolutePath: string; stats: BigIntStats }

/**
 * Where a link's path leads. An absolute or `~/` path may name anything on this machine; a relative one is read from the
 * thread's folder, and its caller holds it inside. The path as written wins, then with the drive first for a Windows path
 * written `/D:/...`, then each of those without a trailing location.
 */
async function locateLink(root: string, path: string): Promise<LocatedLink | null> {
  const located = async (candidate: string): Promise<LocatedLink | null> => {
    const relativeToThread = !/^~(?:[\\/]|$)/u.test(candidate) && !isAbsolute(candidate)
    const absolute = relativeToThread ? resolve(root, candidate) : /^~/u.test(candidate) ? resolve(homedir(), candidate.slice(2)) : candidate
    try {
      const absolutePath = await realpath(absolute)
      return { absolutePath, stats: await stat(absolutePath, { bigint: true }), written: candidate, relativeToThread }
    } catch { return null }
  }
  const bare = withoutLinkLocation(path)
  for (const candidate of new Set([path, withDriveFirst(path), bare, withDriveFirst(bare)])) {
    const found = candidate ? await located(candidate) : null
    if (found) return found
  }
  return null
}

export class FilesService {
  private active = 0
  constructor(private readonly dependencies: FilesDependencies) {}

  /** Shared main-owned identity boundary for terminal, browser and Git tools. */
  resolveWorkspace(threadId: string, expected?: string): Promise<FilesResult<FileWorkspace>> {
    return this.run(async () => (await this.workspace(threadId, expected, false)).value)
  }

  /**
   * Whether Sotto still lists the thread, read from its binding alone: no folder is looked at, so a thread file page can
   * ask it on every request (ADR-0085, October 27 amendment).
   */
  hasThread(threadId: string): boolean {
    try { return this.dependencies.resolveBinding(threadId)?.threadId === threadId } catch { return false }
  }

  private async run<T>(operation: () => Promise<T>): Promise<FilesResult<T>> {
    if (this.active >= FILES_MAX_CONCURRENT_REQUESTS) return { ok: false, error: { code: 'busy', message: 'Files is busy. Try again shortly.' } }
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

  private async workspace(threadId: string, expected?: string, allowPreview = true): Promise<Workspace> {
    let binding: FilesBinding | null
    try { binding = this.dependencies.resolveBinding(threadId) }
    catch { return fail('workspace-unavailable', 'The thread working directory is not ready. Retry its setup, then refresh Files.') }
    if (!binding || binding.threadId !== threadId) return fail('thread-unavailable', 'This thread is unavailable. Select a thread and refresh Files.')
    if (binding.previewOnly && !allowPreview) return fail('workspace-unavailable', 'This worktree will be created on the first send. Send a prompt or choose Project folder before using these tools.')
    if (!isAbsolute(binding.workingDirectory)) return fail('workspace-unavailable', 'The thread working directory is unavailable.')
    let root: string, info: BigIntStats
    try {
      root = await realpath(binding.workingDirectory)
      info = await stat(root, { bigint: true })
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch { return fail('workspace-unavailable', 'The thread working directory is unavailable. Restore the folder and refresh Files.') }
    const workspaceId = createHash('sha256').update(JSON.stringify([binding.threadId, binding.projectId, binding.workingDirectory, root, info.dev.toString(), info.ino.toString(), info.birthtimeNs.toString(), binding.previewOnly ?? false])).digest('hex')
    const latest = this.dependencies.resolveBinding(threadId)
    if (!latest || latest.threadId !== binding.threadId || latest.projectId !== binding.projectId || latest.workingDirectory !== binding.workingDirectory || Boolean(latest.previewOnly) !== Boolean(binding.previewOnly)) return fail('workspace-changed', 'The thread working directory changed. Refresh Files.')
    if (expected !== undefined && expected !== workspaceId) return fail('workspace-changed', 'The thread working directory changed. Refresh Files before selecting a path.')
    return { root, value: { threadId: binding.threadId, projectId: binding.projectId, workingDirectory: binding.workingDirectory, workspaceId } }
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
          if (!fileRelativePathSchema.safeParse(path).success) {
            if (path.length <= 4096) entries.push({ name: entry.name, path, kind: 'unavailable' })
            else truncated = true
            continue
          }
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
        bytes = await wholeFile(file, before)
        await this.verify(workspace, request.path, target, true)
      } finally { await file.close() }
      return { workspace: workspace.value, path: request.path, name: basename(request.path), size: bytes.length, content: previewContent(bytes, request.path) }
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
      await this.dependencies[action](target.absolutePath)
      return { workspace: workspace.value, path: request.path, absolutePath: target.absolutePath }
    })
  }
  copyPath(payload: unknown): Promise<FilesResult<FilePath>> { return this.pathAction(payload, 'copyPath') }
  reveal(payload: unknown): Promise<FilesResult<FilePath>> { return this.pathAction(payload, 'reveal') }

  /**
   * Shows a file a thread's message links to. An absolute or `~/` path may point anywhere on this computer, since
   * showing a file in its folder selects it and opens nothing; a relative one is read from the thread's working folder
   * and must stay inside it, as in Files. The path as written wins; failing that, without a trailing location such as
   * `:12`, `#L12` or `#page=2`.
   */
  revealLink(payload: unknown): Promise<FilesResult<FileLink>> {
    return this.run(async () => {
      const parsed = fileLinkRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'This link is not a file path. Nothing was opened.')
      const { threadId, path } = parsed.data
      // Only a live thread on this computer may show files, whatever form the path takes.
      const workspace = await this.workspace(threadId)
      const found = await locateLink(workspace.root, path)
      if (!found) return fail('path-unavailable', 'This file is not on this computer, or it has moved. Nothing was opened.')
      if (found.relativeToThread && !inside(workspace.root, found.absolutePath)) return fail('path-outside-workspace', 'This link points outside the thread’s folder. Nothing was opened.')
      if (!found.stats.isFile() && !found.stats.isDirectory()) return fail('path-unavailable', 'This link is not a file or folder. Nothing was opened.')
      await this.dependencies.reveal(found.absolutePath)
      return {}
    })
  }

  /**
   * Reads a Markdown file a thread's message links to, for the side panel (ADR-0120, November 3 amendment), on the machine
   * the thread runs on. The paths are as for showing a file, and both the path as written and the file it really is must
   * be Markdown, so a link named `notes.md` that leads to a key is refused. It answers the file's text and the link's own
   * name, never where the path led.
   */
  previewLink(payload: unknown): Promise<FilesResult<FileLinkPreview>> {
    return this.run(async () => {
      const parsed = fileLinkRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'This link is not a file path. Nothing was opened.')
      const { threadId, path } = parsed.data
      const workspace = await this.workspace(threadId)
      const found = await locateLink(workspace.root, path)
      if (!found) return fail('path-unavailable', 'This file is not on the computer this thread runs on, or it has moved. Nothing was opened.')
      if (found.relativeToThread && !inside(workspace.root, found.absolutePath)) return fail('path-outside-workspace', 'This link points outside the thread’s folder. Nothing was opened.')
      if (!found.stats.isFile()) return fail('not-file', 'This link is not a file. Nothing was opened.')
      if (!isMarkdownFileName(found.written) || !isMarkdownFileName(found.absolutePath)) return fail('invalid-request', 'This link does not lead to a Markdown file. Nothing was opened.')
      if (found.stats.size > BigInt(FILES_MAX_TEXT_BYTES)) return fail('too-large', 'Markdown files open here up to 512 KB. Nothing was opened.')
      const file = await open(found.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile() || !sameRevision(before, found.stats)) return fail('path-unavailable', 'This file changed. Read it again.')
        const bytes = await wholeFile(file, before)
        return { name: nameOf(found.written), size: bytes.length, text: textOf(bytes) }
      } finally { await file.close() }
    })
  }

  /** Where a link's path leads on this machine, held inside the thread's folder when it is written relative to it. */
  private async linked(threadId: string, path: string): Promise<{ workspace: Workspace; found: LocatedLink }> {
    const workspace = await this.workspace(threadId)
    const found = await locateLink(workspace.root, path)
    if (!found) return fail('path-unavailable', 'This file is not on the computer this thread runs on, or it has moved. Nothing was opened.')
    if (found.relativeToThread && !inside(workspace.root, found.absolutePath)) return fail('path-outside-workspace', 'This link points outside the thread’s folder. Nothing was opened.')
    if (!found.stats.isFile() && !found.stats.isDirectory()) return fail('path-unavailable', 'This link is not a file or folder. Nothing was opened.')
    return { workspace, found }
  }

  /**
   * Opens a file a thread's message links to in its own app, and a folder in the file manager (ADR-0120, November 12
   * amendment). The paths are as for showing a file. A program, installer, shortcut or script is never opened, so a link
   * cannot start one: by the name the link wrote, by the name of the file it really is, by how the file starts, and for a
   * folder by a Mac's app bundle endings. It is shown in its folder instead, and the answer says so.
   */
  openLink(payload: unknown): Promise<FilesResult<FileLinkOpened>> {
    return this.run(async () => {
      const parsed = fileLinkRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'This link is not a file path. Nothing was opened.')
      const { found } = await this.linked(parsed.data.threadId, parsed.data.path)
      return this.openOrShow(found.absolutePath, found.stats, found.written)
    })
  }

  /**
   * Opens a file this computer holds, as a link's file opens: a download Sotto saved, by main's own path to it. The file
   * it really is, once links are followed, is judged too, so a saved name since replaced by a link to a program is shown.
   */
  openHere(path: string): Promise<FilesResult<FileLinkOpened>> {
    return this.run(async () => {
      const real = await realpath(path)
      return this.openOrShow(real, await stat(real, { bigint: true }), path)
    })
  }

  private async openOrShow(absolutePath: string, stats: BigIntStats, written = absolutePath): Promise<FileLinkOpened> {
    const open = this.dependencies.open
    if (!open) return fail('unavailable', 'Files cannot be opened from here. Nothing was opened.')
    const program = isProgramFileName(written) || isProgramFileName(absolutePath) || (stats.isFile() ? await startsAsProgram(absolutePath) : !stats.isDirectory())
    if (program) { await this.dependencies.reveal(absolutePath); return { did: 'shown' } }
    try { await open(absolutePath) } catch { return fail('unavailable', 'This computer has no app set to open this file. Nothing was opened.') }
    return { did: 'opened' }
  }

  /**
   * A file a thread's message links to, for Files on another computer (ADR-0120, November 12 amendment): where it is, its
   * preview within Files' own limits, or one part of its bytes for a download. The paths are as for showing a file. It
   * reads and writes nothing else, and a file that changed between two parts is refused rather than saved in halves.
   */
  linkedFile(payload: unknown): Promise<FilesResult<LinkedFile>> {
    return this.run(async (): Promise<LinkedFile> => {
      const parsed = linkedFileRequestSchema.safeParse(payload)
      if (!parsed.success) return fail('invalid-request', 'This link is not a file path. Nothing was opened.')
      const request = parsed.data
      const { workspace, found } = await this.linked(request.threadId, request.path)
      // The link's own name, as a linked Markdown file's is; where the path led stays here.
      const name = nameOf(found.written.replace(/[\\/]+$/u, '')) || basename(found.absolutePath)
      if (request.want === 'place') {
        const within = inside(workspace.root, found.absolutePath) ? relative(workspace.root, found.absolutePath).split(sep).join('/') : null
        // A place Files cannot name, such as one its listing would show as unavailable, is shown alone as a file outside is.
        return { is: 'place', name, kind: found.stats.isDirectory() ? 'directory' : 'file', size: found.stats.isFile() ? Number(found.stats.size) : 0,
          inside: within !== null && fileRelativePathSchema.safeParse(within).success ? { workspace: workspace.value, path: within } : null }
      }
      if (!found.stats.isFile()) return fail('not-file', 'This link is not a file. Nothing was opened.')
      if (request.want === 'preview' && found.stats.size > BigInt(FILES_MAX_IMAGE_BYTES)) return fail('too-large', 'This file exceeds the 8 MiB preview limit.')
      const file = await open(found.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const before = await file.stat({ bigint: true })
        if (!before.isFile() || !sameRevision(before, found.stats)) return fail('path-unavailable', 'This file changed. Read it again.')
        if (request.want === 'preview') {
          const bytes = await wholeFile(file, before)
          return { is: 'preview', name, size: bytes.length, content: previewContent(bytes, name) }
        }
        const revision = createHash('sha256').update([before.dev, before.ino, before.birthtimeNs, before.size, before.mtimeNs, before.ctimeNs].join(':')).digest('hex')
        if (request.revision !== undefined && request.revision !== revision) return fail('path-unavailable', 'This file changed while it was being downloaded. Nothing was saved.')
        const size = Number(before.size)
        if (request.offset > size) return fail('invalid-request', 'This part is past the end of the file. Nothing was saved.')
        const bytes = Buffer.alloc(Math.min(FILES_DOWNLOAD_PART_BYTES, size - request.offset))
        let count = 0
        while (count < bytes.length) {
          const { bytesRead } = await file.read(bytes, count, bytes.length - count, request.offset + count)
          if (!bytesRead) break
          count += bytesRead
        }
        if (count !== bytes.length || !sameRevision(before, await file.stat({ bigint: true }))) return fail('path-unavailable', 'This file changed while it was being downloaded. Nothing was saved.')
        return { is: 'part', name, size, offset: request.offset, data: bytes.toString('base64'), revision }
      } finally { await file.close() }
    })
  }
}
