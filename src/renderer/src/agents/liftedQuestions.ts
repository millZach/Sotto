/**
 * The questions a reply asked on the way (#1019). A finished turn folds every reply but its last, and a question a
 * model wrote into an earlier reply before it kept working would fold away with it, so the fold quotes these under
 * its line instead. They are picked by punctuation: a sentence ending in a question mark, outside code, headings,
 * tables and quotes. A lifted question is something for the user to read; it is not a request and answers nothing.
 */

/** The most questions quoted from one reply; Show where it asked reaches the rest. */
export const MOST_LIFTED = 4
const LONGEST = 400
/** Fewer words than this is an aside ("Why?") more often than a question for the user. */
const FEWEST_WORDS = 3

const FENCE = /^ {0,3}(`{3,}|~{3,})/u
/** Headings, block quotes and table rows. */
const NOT_PROSE = /^ {0,3}(?:#{1,6}(?:\s|$)|>|\|)/u
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/u
const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/gu
/** Where a span of inline code was set aside, marked with private-use characters no reply writes. */
const CODE_MARK = /(\d+)/gu
const SENTENCE_END = /(?<=[.!?…]["'”’)\]]*)\s+/u
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx)\.$/iu
const ASKS = /\?["'”’)\]]*$/u

/** One line of prose as it reads: links to their words, emphasis and tags gone. Its code is still set aside. */
function plain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/gu, '$1')
    .replace(/<\/?[a-z][^>]*>/giu, '')
    .replace(/\*\*|__|~~|\*/gu, '')
    .replace(/(?<![\p{L}\p{N}])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, '$1')
}

/** The sentences in `markdown` that ask something, in the order they were written, each once. */
export function questionsIn(markdown: string): string[] {
  const found: string[] = []
  let fence: string | null = null
  for (const raw of markdown.split(/\r?\n/u)) {
    const marker = FENCE.exec(raw)?.[1]
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !raw.slice(raw.indexOf(marker) + marker.length).trim()) fence = null
      continue
    }
    if (marker) { fence = marker; continue }
    if (NOT_PROSE.test(raw)) continue
    const code: string[] = []
    // A question mark inside code is the code's, so code is set aside before the sentences are found; emphasis
    // goes first too, so a bold question still ends at its question mark.
    const line = plain(raw.replace(LIST_MARKER, '').replace(INLINE_CODE, (_, _ticks: string, body: string) => `${code.push(body.trim()) - 1}`))
    const sentences: string[] = []
    for (const piece of line.split(SENTENCE_END)) {
      // "e.g." and its kind end a word, not a sentence.
      if (sentences.length && ABBREVIATION.test(sentences.at(-1)!)) sentences[sentences.length - 1] += ` ${piece}`
      else sentences.push(piece)
    }
    for (const sentence of sentences) {
      const text = sentence.replace(CODE_MARK, (_, index: string) => code[Number(index)] ?? '').replace(/\s+/gu, ' ').trim()
      if (!ASKS.test(text) || text.split(' ').length < FEWEST_WORDS) continue
      const quoted = text.length > LONGEST ? `${text.slice(0, LONGEST - 1).trimEnd()}…` : text
      if (!found.includes(quoted)) found.push(quoted)
    }
  }
  return found
}
