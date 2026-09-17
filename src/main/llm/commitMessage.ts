import type { AppSettings } from '../../shared/settings'
import type { DiffExcerpt } from './diffExcerpt'
import { settingsGatedWriter, trimToLine, type ShortTextRequest, type ShortTextWriter } from './shortTextWriter'

/** The subject line every reader of `git log --oneline` sees whole. */
export const COMMIT_SUBJECT_MAX_CHARACTERS = 72

/** Subject and the short body together; anything longer is the model rambling. */
export const COMMIT_MESSAGE_MAX_CHARACTERS = 1_000

/**
 * The staged diff is the only material, and a large one is cut here rather than
 * sent: a commit message is written from what changed, not from every line of it.
 * Tighter than the pull request cap because a commit is one change, not a branch.
 */
export const COMMIT_DIFF_MAX_CHARACTERS = 12_000

const INSTRUCTION = [
  'You write the commit message for a staged Git change.',
  'Answer with the message alone: no quotes, no code fence, no preamble.',
  `Line one is an imperative subject under ${COMMIT_SUBJECT_MAX_CHARACTERS} characters with no trailing period, as in "Add the commit draft to the Changes panel".`,
  'Add a body only when the change needs one: leave a blank line after the subject, then at most three short lines saying why.',
  'Describe only what the diff shows. Never invent an issue number, a ticket or a co-author.',
].join(' ')

/**
 * The commit request: the staged diff (already capped by `diffExcerpt`, which
 * says so in the text when it cut anything) and nothing else, so no part of the
 * thread transcript can reach OpenRouter through a commit message.
 */
export function commitMessageRequest(excerpt: DiffExcerpt): ShortTextRequest {
  return {
    purpose: 'commit-message',
    instruction: INSTRUCTION,
    material: `Staged diff:\n${excerpt.text}`,
    maxCharacters: COMMIT_MESSAGE_MAX_CHARACTERS,
    maxTokens: 300,
    shape: 'text',
  }
}

/**
 * A model asked for a commit message sometimes labels the subject, ends it with
 * a period or runs it long. The draft the user sees is a subject that fits
 * `git log --oneline`, a blank line, and whatever body was written.
 */
export function shapeCommitMessage(message: string | null): string | null {
  if (message === null) return null
  const lines = message.split('\n')
  const subject = trimToLine((lines.shift() ?? '').replace(/^(?:subject|commit message|message)\s*:\s*/iu, ''), COMMIT_SUBJECT_MAX_CHARACTERS)
  if (subject === null) return null
  const body = lines.join('\n').trim()
  return body.length === 0 ? subject : `${subject}\n\n${body}`
}

/** What the Changes panel calls to draft a commit message; see `settingsGatedWriter` for the off switch. */
export function commitMessageWriter(
  writer: Pick<ShortTextWriter, 'write'>,
  getSettings: () => AppSettings | Promise<AppSettings>,
): (excerpt: DiffExcerpt) => Promise<string | null> {
  return settingsGatedWriter(writer, getSettings, {
    enabled: settings => settings.commitMessages,
    worthAsking: excerpt => excerpt.text.trim().length > 0,
    request: commitMessageRequest,
    shape: shapeCommitMessage,
  })
}
