import { z } from 'zod'

const id = z.string().min(1).max(512)
export const GIT_CHANGED_FILES_MAX = 2_000

/** One changed file of a working copy, the way the commit dialog lists it: its path, what happened to it, and its line counts against HEAD. */
export const gitChangedFileSchema = z.object({
  /** The repository-relative path, with forward slashes; for a rename, the new path. */
  path: z.string().min(1).max(4_096),
  originalPath: z.string().min(1).max(4_096).optional(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'type-changed']),
  /** Lines added and removed against HEAD; null for a binary file, or one whose size Sotto did not count. */
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
}).strict()
export type GitChangedFile = z.infer<typeof gitChangedFileSchema>

/** What the commit dialog asks of the host: the changed files of one thread's folder, read once when the dialog opens. */
export const gitChangedFilesRequestSchema = z.object({ threadId: id }).strict()
export type GitChangedFilesRequest = z.infer<typeof gitChangedFilesRequestSchema>

export const gitChangedFilesSchema = z.object({
  isRepository: z.boolean(),
  files: z.array(gitChangedFileSchema).max(GIT_CHANGED_FILES_MAX),
  /** Git reported more files than the list carries. */
  truncated: z.boolean(),
}).strict()
export type GitChangedFiles = z.infer<typeof gitChangedFilesSchema>

export const AGENT_GIT_CHANGED_FILES = 'sotto:agents:git-changed-files'
