/**
 * The cap every request that carries a Git diff shares. Sotto sends a diff to
 * the writing model only to describe it, so a large branch is cut rather than
 * sent whole: the cut is at a line boundary, the excerpt says it was cut, and
 * the caller learns the same fact so a surface can say so too.
 */
export const DIFF_EXCERPT_CHARACTERS = 20_000

export interface DiffExcerpt {
  /** The diff as it will be sent, with the truncation note when there is one. */
  readonly text: string
  readonly truncated: boolean
}

export function diffExcerpt(diff: string, maxCharacters: number = DIFF_EXCERPT_CHARACTERS): DiffExcerpt {
  const text = diff.trim()
  if (text.length <= maxCharacters) return { text, truncated: false }
  const cut = text.slice(0, maxCharacters)
  const boundary = cut.lastIndexOf('\n')
  const kept = (boundary > maxCharacters / 2 ? cut.slice(0, boundary) : cut).trimEnd()
  return { text: `${kept}\n\n[The diff was longer than this and was cut here. Describe only what is above.]`, truncated: true }
}
