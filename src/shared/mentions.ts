/**
 * The one token rule every composer sigil follows: a literal mention stands alone.
 *
 * A mention counts only where its sigil opens a token and the token ends the word, so ordinary
 * prose that merely contains the same characters is never read as a selection. Each sigil chooses
 * what may close its token: a skill name ends at sentence punctuation, while a file path keeps its
 * dots and brackets.
 */
export const MENTION_CLOSERS = /\s|[.,;!?()[\]{}]/u
/** A path owns `.`, `(`, `[` and `{`, so only whitespace and trailing punctuation close a file mention. */
export const PATH_MENTION_CLOSERS = /\s|[,;!?)\]}]/u

export function hasMentionToken(text: string, token: string, closers: RegExp = MENTION_CLOSERS): boolean {
  let offset = text.indexOf(token)
  while (offset !== -1) {
    const before = text[offset - 1]
    const after = text[offset + token.length]
    if ((!before || /\s/u.test(before)) && (!after || closers.test(after))) return true
    offset = text.indexOf(token, offset + token.length)
  }
  return false
}
