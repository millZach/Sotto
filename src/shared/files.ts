import { z } from 'zod'

export const FILES_LIST = 'sotto:files:list'
export const FILES_PREVIEW = 'sotto:files:preview'
export const FILES_COPY_PATH = 'sotto:files:copy-path'
export const FILES_REVEAL = 'sotto:files:reveal'
export const FILES_MAX_ENTRIES = 1_000
export const FILES_MAX_TEXT_BYTES = 512 * 1024
export const FILES_MAX_IMAGE_BYTES = 8 * 1024 * 1024

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

export const fileWorkspaceSchema = z.object({
  threadId: z.string(), projectId: z.string(), workingDirectory: z.string(), workspaceId: workspaceIdSchema,
}).strict()
export type FileWorkspace = z.infer<typeof fileWorkspaceSchema>
const fileEntrySchema = z.object({ name: z.string(), path: fileRelativePathSchema, kind: z.enum(['directory', 'file', 'unavailable']) }).strict()
export const fileListingSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema,
  entries: z.array(fileEntrySchema).max(FILES_MAX_ENTRIES), truncated: z.boolean() }).strict()
export type FileListing = z.infer<typeof fileListingSchema>
export const filePreviewSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema,
  name: z.string(), size: z.number().int().nonnegative().max(FILES_MAX_IMAGE_BYTES),
  content: z.union([
    z.object({ kind: z.enum(['text', 'markdown']), text: z.string().max(FILES_MAX_TEXT_BYTES) }).strict(),
    z.object({ kind: z.literal('image'), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      dataUrl: z.string().max(Math.ceil(FILES_MAX_IMAGE_BYTES / 3) * 4 + 64)
        .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  ]),
}).strict()
export type FilePreview = z.infer<typeof filePreviewSchema>
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
export interface FilesBridge {
  list(request: FileListRequest): Promise<FilesResult<FileListing>>
  preview(request: FileRequest): Promise<FilesResult<FilePreview>>
  copyPath(request: FileRequest): Promise<FilesResult<FilePath>>
  reveal(request: FileRequest): Promise<FilesResult<FilePath>>
}
