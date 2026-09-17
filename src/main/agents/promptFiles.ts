import { agentFileReferencesSchema, fileMentionToken, hasFileMention, type AgentFileReference } from '../../shared/agentFiles'

/**
 * The working-copy paths a prompt's file mentions carry, verified against the prompt they travel with.
 *
 * Every provider reads `@path`, so the token the composer wrote is already the provider-facing form and
 * no host rewrites the text. What main owns is the promise behind it: each reference is a relative path
 * inside the thread's working copy (the schema admits nothing else), it is mentioned once in this exact
 * prompt, and a mention the user deleted is refused rather than sent as a stale path.
 */
export function filePromptPaths(text: string, files: readonly AgentFileReference[] = []): string[] {
  const references = agentFileReferencesSchema.parse(files)
  for (const file of references) {
    if (!hasFileMention(text, file.path)) {
      throw new Error(`The mentioned file ${fileMentionToken(file.path)} is no longer in this prompt. Remove its mention or restore it.`)
    }
  }
  return references.map(file => file.path)
}

/** The prompt each provider receives for a send carrying file mentions: the authored text, once verified. */
export function filePromptText(text: string, files: readonly AgentFileReference[] = []): string {
  filePromptPaths(text, files)
  return text
}
