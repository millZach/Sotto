import type { AppSettings } from '../../shared/settings'

/** The settings that shape commit and pull request text; absent, the repository's own conventions apply. */
export type GitWritingStyleSettings = Pick<AppSettings, 'gitWritingStyle' | 'gitWritingInstructions'>

/**
 * What the chosen style overrides, said once so the model is never left with two rules: the example in the
 * instruction, the recent subjects and whatever the repository's AGENTS.md says about the same thing. The
 * repository's context is still sent; it just no longer decides the style.
 */
const PRECEDENCE = {
  commit: 'This takes precedence over the example subject above, the recent commit subjects and anything the repository\'s AGENTS.md says about commit message style; use those only for what this leaves open.',
  'pull-request': 'This takes precedence over the title and section rules above and anything the repository\'s AGENTS.md says about pull request style; use those only for what this leaves open.',
} as const

const CONVENTIONAL = {
  commit: 'Write the subject in the Conventional Commits form, "type(scope): summary", with a lowercase type such as feat, fix, docs, refactor, test or chore, an optional scope, and an imperative summary.',
  'pull-request': 'Write the title in the Conventional Commits form, "type(scope): summary", with a lowercase type such as feat, fix, docs, refactor, test or chore, an optional scope, and an imperative summary.',
} as const

/**
 * The instruction the Commit and pull request style adds to a commit or pull request request (T3 Code's
 * three styles): nothing for Repository conventions, which the recent subjects and `AGENTS.md` already carry;
 * the Conventional Commits form; or the user's own instructions. Either of the last two takes precedence over
 * the repository's own style. Custom with nothing written falls back to Repository conventions.
 */
export function gitWritingStyleInstruction(settings: GitWritingStyleSettings | undefined, kind: 'commit' | 'pull-request'): string | null {
  if (!settings || settings.gitWritingStyle === 'repository') return null
  if (settings.gitWritingStyle === 'conventional') return `${CONVENTIONAL[kind]} ${PRECEDENCE[kind]}`
  const instructions = settings.gitWritingInstructions.trim()
  if (!instructions) return null
  return `The user's own instructions for ${kind === 'commit' ? 'commit messages' : 'pull request text'} follow. ${PRECEDENCE[kind]} They never override answering with the text alone and inventing nothing:\n${instructions}`
}
