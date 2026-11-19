import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { threadWordsQuery, type ThreadWordMatch } from '../../../shared/threadWords'

/**
 * How long Search threads waits after the last key before it asks every computer what was said in its threads. A read is
 * about 0.1 s on the owner's store (November 19, 2026), so asking on every key would queue reads a typist has moved past.
 */
export const THREAD_WORDS_WAIT_MS = 200

/** The threads found by what was said in them, by thread, and the search they answer. */
export interface ThreadWords {
  readonly query: string
  readonly matches: ReadonlyMap<string, ThreadWordMatch>
}

const NONE: ReadonlyMap<string, ThreadWordMatch> = new Map()

/**
 * The threads whose messages hold `query` (Zach's picks of November 19, 2026): asked of main once typing pauses, which asks
 * every computer's thread store. While a longer search is on its way, the last answer's matches whose quote still holds it
 * stay, so a row found by its words does not drop out and come back with each key. Nothing is asked with no search, and an
 * answer to a search the field has since left is dropped.
 */
export function useThreadWords(query: string): ThreadWords | undefined {
  const needle = threadWordsQuery(query)
  const [answer, setAnswer] = useState<ThreadWords | undefined>(undefined)
  useEffect(() => {
    const ask = window.sotto?.agents?.threadWords
    if (needle === '' || !ask) return undefined
    let live = true
    const timer = window.setTimeout(() => {
      void ask({ query: needle }).then(read => {
        if (live) setAnswer({ query: needle, matches: new Map((read?.found ?? []).map(match => [match.threadId, match] as const)) })
      }, () => { if (live) setAnswer({ query: needle, matches: NONE }) })
    }, THREAD_WORDS_WAIT_MS)
    return () => { live = false; window.clearTimeout(timer) }
  }, [needle])
  return useMemo(() => {
    if (needle === '' || answer === undefined) return undefined
    if (answer.query === needle) return answer
    // An answer to an earlier search: only the matches its quotes show still hold the longer one.
    const lower = needle.toLocaleLowerCase()
    if (!lower.includes(answer.query.toLocaleLowerCase())) return undefined
    return { query: needle, matches: new Map([...answer.matches].filter(([, match]) => match.quote.toLocaleLowerCase().includes(lower))) }
  }, [answer, needle])
}

/** What a sidebar row reads to show its quote: the search, and the matches of the rows found only by what was said. */
export interface ThreadWordQuotes {
  readonly query: string
  readonly matches: ReadonlyMap<string, ThreadWordMatch>
  readonly wordOnly: ReadonlySet<string>
}

export const ThreadWordQuotesContext = createContext<ThreadWordQuotes | null>(null)

/** The quote a row shows under its name, when a search found its thread only by what was said in it. */
export function useThreadWordQuote(threadId: string): { readonly match: ThreadWordMatch; readonly query: string } | undefined {
  const quotes = useContext(ThreadWordQuotesContext)
  if (!quotes?.wordOnly.has(threadId)) return undefined
  const match = quotes.matches.get(threadId)
  return match === undefined ? undefined : { match, query: quotes.query }
}
