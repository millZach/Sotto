import type { AppSettings } from '../../shared/settings'
import type { ShortTextRequest, ShortTextWriter } from './shortTextWriter'

/** The subject line every reader of `git log --oneline` sees whole. */
export const COMMIT_SUBJECT_MAX_CHARACTERS = 72

/** Subject and the short body together; anything longer is the model rambling. */
export const COMMIT_MESSAGE_MAX_CHARACTERS = 1_000

/**
 * The staged diff is the only material, and a large one is cut here rather than
 * sent: a commit message is written from what changed, not from every line of it.
 */
export const COMMIT_DIFF_MAX_CHARACTERS = 12_000

/** The staged diff as it is sent, and whether the cap cut anything off it. */
export interface StagedDiffExcerpt {
  readonly diff: string
  readonly truncated: boolean
}

const TRUNCATION_NOTE = 'The staged diff continues past this point and was cut; describe only what is shown.'

const INSTRUCTION = [
  'You write the commit message for a staged Git change.',
  'Answer with the message alone: no quotes, no code fence, no preamble.',
  `Line one is an imperative subject under ${COMMIT_SUBJECT_MAX_CHARACTERS} characters with no trailing period, as in "Add the commit draft to the Changes panel".`,
  'Add a body only when the change needs one: leave a blank line after the subject, then at most three short lines saying why.',
  'Describe only what the diff shows. Never invent an issue number, a ticket or a co-author.',
].join(' ')

/** Cuts an oversized staged diff at a line boundary and says so. */
export function stagedDiffExcerpt(patch: string, maxCharacters = COMMIT_DIFF_MAX_CHARACTERS): StagedDiffExcerpt {
  const diff = patch.replace(/\r\n/gu, '\n').trimEnd()
  if (diff.length <= maxCharacters) return { diff, truncated: false }
  const cut = diff.slice(0, maxCharacters)
  const boundary = cut.lastIndexOf('\n')
  return { diff: (boundary > maxCharacters / 2 ? cut.slice(0, boundary) : cut).trimEnd(), truncated: true }
}

/**
 * The commit request: the staged diff and nothing else, so no part of the thread
 * transcript can reach OpenRouter through a commit message.
 */
export function commitMessageRequest(excerpt: StagedDiffExcerpt): ShortTextRequest {
  return {
    purpose: 'commit-message',
    instruction: INSTRUCTION,
    material: [`Staged diff:\n${excerpt.diff}`, ...(excerpt.truncated ? [TRUNCATION_NOTE] : [])].join('\n\n'),
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
  const first = (lines.shift() ?? '')
    .replace(/^(?:subject|commit message|message)\s*:\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.]+$/u, '')
    .trim()
  if (first.length === 0) return null
  const subject = first.length <= COMMIT_SUBJECT_MAX_CHARACTERS ? first : cutAtWord(first)
  const body = lines.join('\n').trim()
  return body.length === 0 ? subject : `${subject}\n\n${body}`
}

/**
 * What the Changes panel calls to draft a commit message. The off switch is read
 * for every draft, so turning generation off stops the next one without a
 * restart, and nothing is asked of OpenRouter while it is off.
 */
export function commitMessageWriter(
  writer: Pick<ShortTextWriter, 'write'>,
  getSettings: () => AppSettings | Promise<AppSettings>,
): (excerpt: StagedDiffExcerpt) => Promise<string | null> {
  return async excerpt => {
    let settings: AppSettings
    try { settings = await getSettings() }
    catch { return null }
    if (!settings.commitMessages) return null
    if (excerpt.diff.trim().length === 0) return null
    return shapeCommitMessage(await writer.write(commitMessageRequest(excerpt)))
  }
}

function cutAtWord(subject: string): string {
  const cut = subject.slice(0, COMMIT_SUBJECT_MAX_CHARACTERS)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > COMMIT_SUBJECT_MAX_CHARACTERS / 2 ? cut.slice(0, boundary) : cut).trim()
}
