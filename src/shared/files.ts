import { z } from 'zod'

export const FILES_LIST = 'sotto:files:list'
export const FILES_PREVIEW = 'sotto:files:preview'
export const FILES_COPY_PATH = 'sotto:files:copy-path'
export const FILES_REVEAL = 'sotto:files:reveal'
export const FILES_REVEAL_LINK = 'sotto:files:reveal-link'
export const FILES_PREVIEW_LINK = 'sotto:files:preview-link'
export const FILES_OPEN_LINK = 'sotto:files:open-link'
export const FILES_LINKED_FILE = 'sotto:files:linked-file'
export const FILES_DOWNLOAD = 'sotto:files:download'
export const FILES_DOWNLOAD_STOP = 'sotto:files:download-stop'
export const FILES_DOWNLOAD_SHOW = 'sotto:files:download-show'
export const FILES_DOWNLOAD_OPEN = 'sotto:files:download-open'
export const FILES_DOWNLOAD_PROGRESS = 'sotto:files:download-progress'
export const FILES_MAX_ENTRIES = 1_000
export const FILES_MAX_TEXT_BYTES = 512 * 1024
export const FILES_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const FILES_MAX_CONCURRENT_REQUESTS = 4
/** One part of a file a paired host sends for a download: about 5.6 MB as base64, well inside one frame. */
export const FILES_DOWNLOAD_PART_BYTES = 4 * 1024 * 1024

// Canonical slash-separated relative paths only. Reject Windows device names,
// alternate streams, drive-relative paths and normalization aliases on every OS.
export const fileRelativePathSchema = z.string().max(4096).refine(path => path === '' || (
  // eslint-disable-next-line no-control-regex -- File paths must reject NUL and control bytes.
  !/[\\\x00-\x1f\x7f:<>"|?*]/.test(path) && path.split('/').every(part =>
    part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
), 'Use a relative workspace path.')
const requestShape = { threadId: z.string().min(1).max(512), path: fileRelativePathSchema }
const workspaceIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const fileListRequestSchema = z.object({ ...requestShape, workspaceId: workspaceIdSchema.optional() }).strict()
  .refine(value => value.path === '' || value.workspaceId !== undefined, 'Refresh the workspace first.')
export const fileRequestSchema = z.object({ ...requestShape, workspaceId: workspaceIdSchema }).strict()
export type FileListRequest = z.infer<typeof fileListRequestSchema>
export type FileRequest = z.infer<typeof fileRequestSchema>
// Never a network share or device path (\\host\share, //host, \\?\): resolving one reaches the network. Nor drive-relative C:file.
// eslint-disable-next-line no-control-regex -- File paths must reject NUL and control bytes.
const fileLinkPathSchema = z.string().min(1).max(4096).refine(path => !/[\x00-\x1f\x7f]/.test(path) && !/^[\\/]{2}/.test(path) && !/^[a-z]:(?![\\/])/i.test(path))
const fileLinkShape = { threadId: z.string().min(1).max(512), path: fileLinkPathSchema }
/** A file a thread's message links to: absolute on this computer, under the home folder (`~/`), or relative to the thread's working folder. */
export const fileLinkRequestSchema = z.object(fileLinkShape).strict()
export type FileLinkRequest = z.infer<typeof fileLinkRequestSchema>
// Empty on purpose: the window learns only whether the file was shown, never where a path resolved to.
export const fileLinkSchema = z.object({}).strict()
export type FileLink = z.infer<typeof fileLinkSchema>
/**
 * A Markdown file a message links to, read only for the side panel (ADR-0120, November 3 amendment). The name is the link's
 * own: as with showing a file, the window never learns where a path led.
 */
export const fileLinkPreviewSchema = z.object({ name: z.string().max(4096), size: z.number().int().nonnegative().max(FILES_MAX_TEXT_BYTES), text: z.string().max(FILES_MAX_TEXT_BYTES) }).strict()
export type FileLinkPreview = z.infer<typeof fileLinkPreviewSchema>
/**
 * A path as a link wrote it, without a trailing location: a line such as `:12` or `#L12`, a page such as `#page=2`, or a
 * heading such as `#reading-a-failure`. A fragment holding a folder separator is part of a name, as in `C#/notes.md`.
 */
export const withoutLinkLocation = (path: string): string => path.replace(/(?:#[^#/\\]*|:\d+(?:[:-]\d+)?)$/u, '')
/** A Windows path with the drive first: a `file:` URL's path and Codex's links write `/D:/Projects/notes.md`. */
export const withDriveFirst = (path: string): string => /^\/[a-z]:[\\/]/iu.test(path) ? path.slice(1) : path
const MARKDOWN_ENDING = /\.(?:md|markdown|mdown)$/iu
/** Whether a real file's name ends as Markdown's do. */
export const isMarkdownFileName = (name: string): boolean => MARKDOWN_ENDING.test(name)
/** Whether a path a link wrote names a Markdown file, with or without a trailing location. */
export const isMarkdownPath = (path: string): boolean => isMarkdownFileName(path) || isMarkdownFileName(withoutLinkLocation(path))

/**
 * Endings of files a computer runs, installs or follows when it opens them, on Windows, a Mac or Linux: programs, installers,
 * shortcuts and the scripts a double click starts. A link never opens one (ADR-0120, November 12 amendment); it is shown in
 * its folder. Wider than any one system needs, since the same list is read on all three and a file made on one is opened on another.
 */
const PROGRAM_ENDING = new RegExp(`\\.(?:${[
  // Windows programs, installers, shortcuts and what its script hosts run.
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'ps1', 'psm1', 'psd1', 'ps1xml',
  'vbs', 'vbe', 'vb', 'js', 'jse', 'ws', 'wsf', 'wsc', 'wsh', 'hta', 'cpl', 'msc', 'reg', 'lnk', 'url', 'scf', 'inf', 'gadget', 'application', 'appref-ms',
  'settingcontent-ms', 'diagcab', 'chm', 'hlp', 'jar', 'jnlp', 'sct', 'shb', 'shs', 'website', 'search-ms', 'library-ms', 'xll', 'wll', 'ade', 'adp', 'mde',
  // A Mac's: an app or its kind of bundle, an installer, and what Terminal or Script Editor runs.
  'app', 'command', 'tool', 'terminal', 'workflow', 'action', 'pkg', 'mpkg', 'scpt', 'scptd', 'applescript', 'osax', 'prefpane', 'saver', 'qlgenerator',
  'kext', 'appex', 'plugin', 'bundle', 'wdgt', 'inetloc', 'webloc', 'fileloc', 'dmg',
  // Linux's: a launcher, a packaged program, a package, and shell scripts.
  'desktop', 'appimage', 'run', 'bin', 'elf', 'out', 'deb', 'rpm', 'flatpakref', 'snap', 'sh', 'bash', 'zsh', 'fish', 'csh', 'ksh',
  // Scripts whose interpreter takes the double click where it is installed.
  'py', 'pyw', 'pyc', 'pyz', 'pl', 'rb', 'php', 'tcl', 'lua', 'ahk', 'au3',
].join('|')})$`, 'iu')
/** Whether a file's name ends as a program, installer, shortcut or script does. Its contents are main's to judge as well. */
export const isProgramFileName = (name: string): boolean => PROGRAM_ENDING.test(name.replace(/[. ]+$/u, ''))
/** Whether a path a link wrote names a program by its ending, with or without a trailing location. */
export const isProgramPath = (path: string): boolean => isProgramFileName(path) || isProgramFileName(withoutLinkLocation(path))
/** What opening a linked file did: opened it in its own app, or showed it in its folder because it is a program. */
export const fileLinkOpenedSchema = z.object({ did: z.enum(['opened', 'shown']) }).strict()
export type FileLinkOpened = z.infer<typeof fileLinkOpenedSchema>

export const fileWorkspaceSchema = z.object({
  threadId: z.string(), projectId: z.string(), workingDirectory: z.string(), workspaceId: workspaceIdSchema,
}).strict()
export type FileWorkspace = z.infer<typeof fileWorkspaceSchema>
// Unavailable entries retain their observed name/path for display only. Requests
// still require a canonical path before any filesystem operation.
const fileEntrySchema = z.discriminatedUnion('kind', [
  z.object({ name: z.string(), path: fileRelativePathSchema, kind: z.enum(['directory', 'file']) }).strict(),
  z.object({ name: z.string(), path: z.string().max(4096), kind: z.literal('unavailable') }).strict(),
])
export const fileListingSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema,
  entries: z.array(fileEntrySchema).max(FILES_MAX_ENTRIES), truncated: z.boolean() }).strict()
export type FileListing = z.infer<typeof fileListingSchema>
const filePreviewContentSchema = z.union([
  z.object({ kind: z.enum(['text', 'markdown']), text: z.string().max(FILES_MAX_TEXT_BYTES) }).strict(),
  z.object({ kind: z.literal('image'), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    dataUrl: z.string().max(Math.ceil(FILES_MAX_IMAGE_BYTES / 3) * 4 + 64)
      .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/) }).strict(),
])
export const filePreviewSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema,
  name: z.string(), size: z.number().int().nonnegative().max(FILES_MAX_IMAGE_BYTES),
  content: filePreviewContentSchema,
}).strict()
export type FilePreview = z.infer<typeof filePreviewSchema>

/**
 * What is asked of a file a message links to, on the machine its thread runs on (ADR-0120, November 12 amendment):
 * `place`, where it is, so Files can show it; `preview`, its text or picture within Files' own limits; and `part`, one part of
 * its bytes from `offset`, for a download. `revision` is the one the first part answered, so a file that changed is refused.
 */
export const linkedFileRequestSchema = z.discriminatedUnion('want', [
  z.object({ ...fileLinkShape, want: z.literal('place') }).strict(),
  z.object({ ...fileLinkShape, want: z.literal('preview') }).strict(),
  z.object({ ...fileLinkShape, want: z.literal('part'), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
])
export type LinkedFileRequest = z.infer<typeof linkedFileRequestSchema>
/** What the window itself may ask: never a file's bytes, which main writes to Downloads without showing them to the window. */
export const linkedFileViewRequestSchema = z.object({ ...fileLinkShape, want: z.enum(['place', 'preview']) }).strict()
export type LinkedFileViewRequest = z.infer<typeof linkedFileViewRequestSchema>
const linkedFileSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/**
 * Where a linked file is. `inside` is its place in the thread's working folder, as Files lists it, and null for a file
 * anywhere else on that machine, which Files shows alone. The name is the file's own.
 */
export const linkedFilePlaceSchema = z.object({ is: z.literal('place'), name: z.string().max(4096), kind: z.enum(['file', 'directory']), size: linkedFileSize,
  inside: z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema }).strict().nullable() }).strict()
export type LinkedFilePlace = z.infer<typeof linkedFilePlaceSchema>
export const linkedFilePreviewSchema = z.object({ is: z.literal('preview'), name: z.string().max(4096), size: linkedFileSize.max(FILES_MAX_IMAGE_BYTES), content: filePreviewContentSchema }).strict()
export type LinkedFilePreview = z.infer<typeof linkedFilePreviewSchema>
export const linkedFilePartSchema = z.object({ is: z.literal('part'), name: z.string().max(4096), size: linkedFileSize, offset: linkedFileSize,
  data: z.string().max(Math.ceil(FILES_DOWNLOAD_PART_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type LinkedFilePart = z.infer<typeof linkedFilePartSchema>
export const linkedFileSchema = z.discriminatedUnion('is', [linkedFilePlaceSchema, linkedFilePreviewSchema, linkedFilePartSchema])
export type LinkedFile = z.infer<typeof linkedFileSchema>
export const linkedFileViewSchema = z.discriminatedUnion('is', [linkedFilePlaceSchema, linkedFilePreviewSchema])
export type LinkedFileView = z.infer<typeof linkedFileViewSchema>

/** A download of a file on a paired host to this computer's Downloads folder, named by the thread and the path the window asked with. */
export const fileDownloadRequestSchema = z.object(fileLinkShape).strict()
export type FileDownloadRequest = z.infer<typeof fileDownloadRequestSchema>
/** A finished download: main's own handle for the saved file and the name it was saved under, never where it is. */
export const fileDownloadSchema = z.object({ downloadId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().max(255), size: linkedFileSize }).strict()
export type FileDownload = z.infer<typeof fileDownloadSchema>
export const fileDownloadHandleSchema = z.object({ downloadId: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
export type FileDownloadHandle = z.infer<typeof fileDownloadHandleSchema>
export const fileDownloadProgressSchema = z.object({ ...fileLinkShape, received: linkedFileSize, size: linkedFileSize }).strict()
export type FileDownloadProgress = z.infer<typeof fileDownloadProgressSchema>
export const fileDownloadStoppedSchema = z.object({ stopped: z.boolean() }).strict()
export type FileDownloadStopped = z.infer<typeof fileDownloadStoppedSchema>
export const filePathSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema, absolutePath: z.string() }).strict()
export type FilePath = z.infer<typeof filePathSchema>
export const filesErrorSchema = z.object({ code: z.enum([
  'invalid-request', 'thread-unavailable', 'workspace-unavailable', 'workspace-changed', 'path-unavailable',
  'path-outside-workspace', 'not-directory', 'not-file', 'binary', 'too-large', 'busy', 'unavailable',
]), message: z.string() }).strict()
export type FilesError = z.infer<typeof filesErrorSchema>
export type FilesResult<T> = { ok: true; value: T } | { ok: false; error: FilesError }
export function filesResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: filesErrorSchema }).strict()])
}
/** Files' reads and path actions. A thread on a paired host gets one without `reveal`: its folder is on that host. */
export interface FilesBridge {
  list(request: FileListRequest): Promise<FilesResult<FileListing>>
  preview(request: FileRequest): Promise<FilesResult<FilePreview>>
  copyPath(request: FileRequest): Promise<FilesResult<FilePath>>
  reveal?(request: FileRequest): Promise<FilesResult<FilePath>>
  /** Shows a file a message links to in Finder or File Explorer. */
  revealLink?(request: FileLinkRequest): Promise<FilesResult<FileLink>>
  /** Reads a Markdown file a message links to, for the side panel, on the machine the thread runs on. */
  previewLink?(request: FileLinkRequest): Promise<FilesResult<FileLinkPreview>>
  /** Opens a file a message links to in its own app, or its folder; a program is shown in its folder instead (ADR-0120, November 12 amendment). */
  openLink?(request: FileLinkRequest): Promise<FilesResult<FileLinkOpened>>
  /** Where a linked file is on the machine its thread runs on, or its preview. */
  linkedFile?(request: LinkedFileViewRequest): Promise<FilesResult<LinkedFileView>>
  /** Saves a file on a paired host to this computer's Downloads folder. Resolves once it is saved, stopped or refused. */
  download?(request: FileDownloadRequest): Promise<FilesResult<FileDownload>>
  stopDownload?(request: FileDownloadRequest): Promise<FilesResult<FileDownloadStopped>>
  /** Shows a saved download in its folder, and opens it as a link's file opens. */
  showDownload?(request: FileDownloadHandle): Promise<FilesResult<FileLink>>
  openDownload?(request: FileDownloadHandle): Promise<FilesResult<FileLinkOpened>>
  onDownloadProgress?(listener: (progress: FileDownloadProgress) => void): () => void
}
