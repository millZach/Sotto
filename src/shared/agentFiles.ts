import { z } from 'zod'
import { fileRelativePathSchema } from './files'
import { hasMentionToken, PATH_MENTION_CLOSERS } from './mentions'

/** How a written file mention starts. Every provider reads the working-copy path after `@`. */
export const FILE_SIGIL = '@'

/**
 * A file the user mentioned in a prompt, identified only by its path relative to the thread's
 * working copy. Nothing absolute and nothing outside the working copy can be expressed here:
 * the Files boundary owns which paths exist at all.
 */
export const agentFileReferenceSchema = z.object({
  path: fileRelativePathSchema.refine(path => path !== '', 'Mention a file inside the working copy.'),
}).strict()
export const agentFileReferencesSchema = z.array(agentFileReferenceSchema).max(32)
  .refine(files => new Set(files.map(file => file.path)).size === files.length, 'Mention each file once.')
export type AgentFileReference = z.infer<typeof agentFileReferenceSchema>

/** The token written in the prompt, which is also what the provider reads. */
export function fileMentionToken(path: string): string { return `${FILE_SIGIL}${path}` }

/** A literal `@path` at token boundaries, the same check main makes before dispatch. */
export function hasFileMention(text: string, path: string): boolean {
  return hasMentionToken(text, fileMentionToken(path), PATH_MENTION_CLOSERS)
}
