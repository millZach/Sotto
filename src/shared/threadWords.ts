import { z } from 'zod'

/**
 * Search threads' look through what was said (Zach's picks of November 19, 2026, `docs/prototypes/thread-word-search-prototype.html`):
 * the threads whose messages hold the words searched, read from each computer's thread store. Only the user's messages and
 * the agents' replies are searched, never a step's command or output, and never a wake-up, which is Sotto's. Each thread
 * found carries one quote of its newest matching message, so a search costs a page of quotes rather than the words.
 */
export const AGENT_THREAD_WORDS = 'sotto:agents:thread-words'

/** The longest search a read takes; a longer one is cut to it, as the iPhone cuts its settled search. */
export const THREAD_WORDS_QUERY = 200
/** How much of a matching message a quote carries: some words before the match and the rest after it. */
export const THREAD_WORDS_BEFORE = 48
export const THREAD_WORDS_QUOTE = 180
/** The most threads one read names, those whose match is newest first; a search of a common word stops there. */
export const THREAD_WORDS_MOST = 200
/** The most other matching messages a thread's count says; more says this many. */
export const THREAD_WORDS_MORE = 999

const id = z.string().min(1).max(512)
export const agentThreadWordsRequestSchema = z.object({ query: z.string().trim().min(1).max(THREAD_WORDS_QUERY) }).strict()
export type AgentThreadWordsRequest = z.infer<typeof agentThreadWordsRequestSchema>
export const threadWordMatchSchema = z.object({
  threadId: id,
  messageId: id,
  /** Whose words matched: the user's, or the agent's reply. */
  role: z.enum(['user', 'assistant']),
  /** The match with some words around it, on one line, an ellipsis where the message goes on. */
  quote: z.string().max(THREAD_WORDS_QUOTE + 2),
  /** How many other messages of the thread match too. */
  more: z.number().int().min(0).max(THREAD_WORDS_MORE),
}).strict()
export type ThreadWordMatch = z.infer<typeof threadWordMatchSchema>
/** One host's answer. */
export const agentThreadWordsSchema = z.object({ found: z.array(threadWordMatchSchema).max(THREAD_WORDS_MOST) }).strict()
export type AgentThreadWords = z.infer<typeof agentThreadWordsSchema>
/**
 * The most hosts whose answers the desktop joins for its window: this computer and its paired hosts, of which a desktop
 * keeps at most 20 (`remote-hosts.json`), with room to spare.
 */
export const THREAD_WORDS_HOSTS = 32
/**
 * How long the desktop waits for one host's answer before it shows the others without it: a stalled socket would
 * otherwise hold every computer's matches for its own two-minute deadline.
 */
export const THREAD_WORDS_HOST_WAIT_MS = 3_000
/** The desktop's answer to its window: every host's threads found, joined. */
export const joinedThreadWordsSchema = z.object({ found: z.array(threadWordMatchSchema).max(THREAD_WORDS_MOST * THREAD_WORDS_HOSTS) }).strict()

/**
 * Where a quote shows the search, which the quote may hold with its spaces run together: the start and length of the
 * match in `quote`, or undefined when the quote does not show it (cut off before it, or a match only the case of a letter
 * outside ASCII would make).
 */
export function threadWordHit(quote: string, query: string): { readonly start: number; readonly length: number } | undefined {
  const needle = query.trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
  const lower = quote.toLocaleLowerCase()
  if (needle === '' || lower.length !== quote.length) return undefined
  const start = lower.indexOf(needle)
  return start < 0 ? undefined : { start, length: needle.length }
}

/** A search as the store matches it: trimmed, cut to the longest it takes, never ending on half a character. */
export function threadWordsQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length <= THREAD_WORDS_QUERY) return trimmed
  const code = trimmed.charCodeAt(THREAD_WORDS_QUERY - 1)
  return trimmed.slice(0, code >= 0xd800 && code <= 0xdbff ? THREAD_WORDS_QUERY - 1 : THREAD_WORDS_QUERY).trim()
}

/**
 * The quote a matching message shows: its words from a little before the match, on one line, with an ellipsis at each
 * end it was cut. `text` is the stretch the store read, starting `from` characters into the message (0 at its start);
 * `whole` says whether the stretch reaches the message's end. Never starts or ends on half a character.
 */
export function threadWordQuote(text: string, from: number, whole: boolean): string {
  let line = text.replace(/\s+/gu, ' ')
  if (/^[\uDC00-\uDFFF]/u.test(line)) line = line.slice(1)
  let cutEnd = !whole
  if (line.length > THREAD_WORDS_QUOTE) {
    const code = line.charCodeAt(THREAD_WORDS_QUOTE - 1)
    line = line.slice(0, code >= 0xd800 && code <= 0xdbff ? THREAD_WORDS_QUOTE - 1 : THREAD_WORDS_QUOTE)
    cutEnd = true
  }
  return `${from > 0 ? '…' : ''}${line.trim()}${cutEnd ? '…' : ''}`
}
