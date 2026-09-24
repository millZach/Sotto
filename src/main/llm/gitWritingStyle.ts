import type { AppSettings } from '../../shared/settings'

/** The settings that shape commit and pull request text; absent, the repository's own conventions apply. */
export type GitWritingStyleSettings = Pick<AppSettings, 'gitWritingStyle' | 'gitWritingInstructions'>

const CONVENTIONAL = {
  commit: 'Write the subject in the Conventional Commits form, "type(scope): summary", with a lowercase type such as feat, fix, docs, refactor, test or chore, an optional scope, and an imperative summary. This form takes precedence over the example above and over the recent subjects.',
  'pull-request': 'Write the title in the Conventional Commits form, "type(scope): summary", with a lowercase type such as feat, fix, docs, refactor, test or chore, an optional scope, and an imperative summary.',
} as const

/**
 * The sentence the writing style adds to a commit or pull request instruction (T3 Code's three styles):
 * nothing for the repository's own conventions, which the recent subjects and `AGENTS.md` already carry;
 * the Conventional Commits form; or the user's own instructions, which win over the house style. Custom
 * with nothing written falls back to the repository's conventions.
 */
export function gitWritingStyleInstruction(settings: GitWritingStyleSettings | undefined, kind: 'commit' | 'pull-request'): string | null {
  if (!settings || settings.gitWritingStyle === 'repository') return null
  if (settings.gitWritingStyle === 'conventional') return CONVENTIONAL[kind]
  const instructions = settings.gitWritingInstructions.trim()
  if (!instructions) return null
  return `The user's own instructions for ${kind === 'commit' ? 'commit messages' : 'pull request text'} follow; they take precedence over the house style above, but never over answering with the text alone and inventing nothing:\n${instructions}`
}
