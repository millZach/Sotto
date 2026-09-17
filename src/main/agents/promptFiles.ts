import { agentFileReferencesSchema, fileMentionToken, hasFileMention, type AgentFileReference } from '../../shared/agentFiles'

/**
 * Check a prompt's file mentions before it is dispatched, for every provider.
 *
 * All three read `@path`, so the token the composer wrote is already the provider-facing form and no
 * host rewrites the text. What main owns is the promise behind it: each reference is a space-free
 * relative path inside the thread's working copy (the schema admits nothing else) and it is still
 * written in this exact prompt, so a mention the user deleted is refused instead of travelling as a
 * stale path. Throws on the first reference that fails; returns nothing, because the text is the text.
 */
export function verifyFileMentions(text: string, files: readonly AgentFileReference[] = []): void {
  for (const file of agentFileReferencesSchema.parse(files)) {
    if (!hasFileMention(text, file.path)) {
      throw new Error(`The mentioned file ${fileMentionToken(file.path)} is no longer in this prompt. Remove its mention or restore it.`)
    }
  }
}
