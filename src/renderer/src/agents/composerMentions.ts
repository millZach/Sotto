/** The token at the caret that opened a composer picker. */
export interface MentionTrigger {
  readonly query: string
  readonly start: number
  readonly end: number
}

/**
 * The `sigil`-led token the caret sits in, whatever the sigil means. A token runs back to the
 * previous whitespace, holds exactly one sigil (its first character), and never opens over a
 * selection range. `$` skills and `@` files share this one rule, so what counts as a mention
 * while typing is the same question for both.
 */
/**
 * How well a value answers what was typed, nearest first: 0 exact, 1 prefix, 2 the prefix of a word
 * inside it, 3 anywhere in it, and null for no match at all. Skills and files rank the same way;
 * only what counts as a word boundary differs.
 */
export function mentionMatchScore(value: string, query: string, separators = /[-_/:.\s]+/u): 0 | 1 | 2 | 3 | null {
  if (value === query) return 0
  if (value.startsWith(query)) return 1
  if (value.split(separators).some(part => part.startsWith(query))) return 2
  return value.includes(query) ? 3 : null
}

export function detectMentionTrigger(text: string, selectionStart: number, selectionEnd: number, sigil: string): MentionTrigger | null {
  if (selectionStart !== selectionEnd) return null
  const caret = Math.max(0, Math.min(text.length, selectionStart))
  let start = caret
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1
  const token = text.slice(start, caret)
  if (!token.startsWith(sigil) || token.slice(sigil.length).includes(sigil)) return null
  return { query: token.slice(sigil.length), start, end: caret }
}
