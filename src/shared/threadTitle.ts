/** A sidebar row and a pane heading both have to hold the whole title. */
export const THREAD_TITLE_MAX_CHARACTERS = 60

/**
 * A thread's first-message title: the opening words of its first message, on one line, cut at a word so the
 * whole name fits a sidebar row and ending in an ellipsis when it was cut. Null for a message with no words.
 */
export function firstMessageTitle(prompt: string): string | null {
  const text = prompt.replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return null
  if (text.length <= THREAD_TITLE_MAX_CHARACTERS) return text
  // One character is left for the ellipsis. A word that ends exactly there is kept whole.
  const room = THREAD_TITLE_MAX_CHARACTERS - 1
  const boundary = text[room] === ' ' ? room : text.lastIndexOf(' ', room)
  // A long unbroken run is cut mid-word, never between the halves of an emoji's surrogate pair.
  const cut = boundary > THREAD_TITLE_MAX_CHARACTERS / 2 ? text.slice(0, boundary) : text.slice(0, room).replace(/[\uD800-\uDBFF]$/u, '')
  return `${cut.trimEnd()}…`
}
