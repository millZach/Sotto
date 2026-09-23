/**
 * The cap every request that carries a Git diff shares. Sotto sends a diff to
 * the thread's provider only to describe it, so a large branch is cut rather than
 * sent whole: the cut is at a line boundary, the excerpt says it was cut, and
 * the caller learns the same fact so a surface can say so too.
 */
export const DIFF_EXCERPT_CHARACTERS = 20_000

const TRUNCATION_NOTE = '[The diff was longer than this and was cut here. Describe only what is above.]'

export interface DiffExcerpt {
  /** The diff as it will be sent, with the truncation note when there is one. Never longer than the cap. */
  readonly text: string
  readonly truncated: boolean
}

export function diffExcerpt(diff: string, maxCharacters: number = DIFF_EXCERPT_CHARACTERS): DiffExcerpt {
  const text = diff.replace(/\r\n/gu, '\n').trim()
  if (text.length <= maxCharacters) return { text, truncated: false }
  const room = maxCharacters - TRUNCATION_NOTE.length - 2
  const cut = text.slice(0, room)
  const boundary = cut.lastIndexOf('\n')
  const kept = (boundary > room / 2 ? cut.slice(0, boundary) : cut).trimEnd()
  return { text: `${kept}\n\n${TRUNCATION_NOTE}`, truncated: true }
}
