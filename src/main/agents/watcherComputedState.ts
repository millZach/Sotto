import { pullRequestAddress, pullRequestKey } from '../../shared/gitPullRequests'
import { type WatcherKeptState, type WatcherMergeQueueItem, type WatcherPullRequestSummary, type WatcherStaleNote,
  type WatcherThreadTarget } from '../../shared/watcher'

/**
 * What read_state computes from live data at each read (#1274). After a compaction, notes Watcher kept by hand still
 * described threads that had finished and a failure that had moved on, and missed the merge queue. The facts that change
 * are now Sotto's to say, from its own records, and a kept note that names something those records say is over is
 * flagged, so a stale note is seen rather than trusted. Every sentence here is Sotto's; nothing a thread said reaches it.
 */

/** One open pull request of a watched thread, with what the merge queue reads of it; `draft` undefined when Sotto cannot say. */
export interface WatcherOpenPullRequest { readonly summary: WatcherPullRequestSummary; readonly draft: boolean | undefined; readonly checksPassedAt?: string }

/**
 * The merge queue: every open pull request of a watched thread that is not a draft and whose checks passed, in the order
 * Sotto first saw them pass, oldest first, by number when two passed at once. One not known to be a draft or not is left out.
 */
export function watcherMergeQueue(threads: readonly { readonly target: WatcherThreadTarget; readonly title: string; readonly open: readonly WatcherOpenPullRequest[] }[]): WatcherMergeQueueItem[] {
  return threads.flatMap(thread => thread.open.flatMap(pr => pr.summary.state === 'open' && pr.summary.checks === 'passed' && pr.draft === false && pr.checksPassedAt
    ? [{ target: thread.target, title: thread.title, pullRequest: pr.summary, checksPassedAt: pr.checksPassedAt }] : []))
    .sort((a, b) => Date.parse(a.checksPassedAt) - Date.parse(b.checksPassedAt) || (a.pullRequest.number ?? 0) - (b.pullRequest.number ?? 0))
}

const numbered = (url: string) => { const number = pullRequestAddress(url)?.number; return number ? `#${number}` : 'its link' }
const listed = (items: readonly string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * What a watched thread whose work is otherwise done waits on before Settle finished threads settles it: its open pull
 * requests merging or closing, or else Watcher hearing its news and resting. Watcher is in a turn whenever it reads this.
 */
export function watcherSettlesWhen(hold: { readonly pullRequests: readonly string[]; readonly unheard: boolean }): string {
  if (hold.pullRequests.length === 1) return `Its pull request ${numbered(hold.pullRequests[0]!)} merges or closes.`
  if (hold.pullRequests.length) return `Its pull requests ${listed(hold.pullRequests.slice(0, 10).map(numbered))} merge or close.`
  return hold.unheard ? 'Watcher is told its news and rests.' : 'Watcher’s turn ends and it rests.'
}

/** A thread a kept note may name: who it is, what it is called, and whether it is settled or watched. */
export interface WatcherKnownThread { readonly target: WatcherThreadTarget; readonly title: string; readonly settled: boolean; readonly watched: boolean }
/** A pull request a kept note may name, as Sotto last read it. */
export interface WatcherKnownPullRequest { readonly url: string; readonly number: number; readonly state: 'open' | 'closed' | 'merged' }

/**
 * A one-word title shorter than this, or the stand-in a thread has before it is named, says too little to be told apart in
 * a note; a title of two words or more, as "Fix CI", is named whatever its length.
 */
const TITLE_MIN = 8
const STAND_IN_TITLES: ReadonlySet<string> = new Set(['new thread'])
const ID_MIN = 8
const TITLE_SHOWN_MAX = 80
const fold = (text: string) => text.toLowerCase().replace(/\s+/gu, ' ').trim()
const WORD = /[\p{L}\p{N}]/u
/** Whether `phrase` stands in `text` as words of its own, not inside a longer word. */
function names(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    const before = text[at - 1], after = text[at + phrase.length]
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) return true
  }
  return false
}
const URLS = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/giu
const NUMBERS = /(?:#|\b(?:pr|pull request)\s*#?\s*)(\d+)\b/giu
const shown = (title: string) => title.length > TITLE_SHOWN_MAX ? `${title.slice(0, TITLE_SHOWN_MAX - 1)}…` : title

/**
 * The kept notes that name a settled or unwatched thread, by its title or ID, or a merged or closed pull request, by its
 * link or number, and why. A title two threads share is said of the one that is watched and not settled when there is
 * one, so it flags nothing; a number two pull requests share flags only when neither is open.
 */
export function watcherStaleNotes(kept: Pick<WatcherKeptState, 'decisions' | 'rules' | 'issues'>, threads: readonly WatcherKnownThread[],
  pullRequests: readonly WatcherKnownPullRequest[]): WatcherStaleNote[] {
  const live = new Set(threads.filter(thread => thread.watched && !thread.settled).map(thread => fold(thread.title)))
  const over = threads.filter(thread => thread.settled || !thread.watched)
  const byKey = new Map<string, WatcherKnownPullRequest>(), byNumber = new Map<number, WatcherKnownPullRequest[]>()
  for (const pr of pullRequests) {
    const prKey = pullRequestKey(pr.url) ?? pr.url
    if (byKey.has(prKey)) continue
    byKey.set(prKey, pr); byNumber.set(pr.number, [...byNumber.get(pr.number) ?? [], pr])
  }
  const notes: WatcherStaleNote[] = []
  for (const list of ['decisions', 'rules', 'issues'] as const) kept[list].forEach((note, index) => {
    const text = fold(note), reasons: string[] = []
    for (const thread of over) {
      const title = fold(thread.title)
      const byTitle = (title.length >= TITLE_MIN || title.includes(' ')) && !STAND_IN_TITLES.has(title) && !live.has(title) && names(text, title)
      const byId = thread.target.threadId.length >= ID_MIN && text.includes(thread.target.threadId.toLowerCase())
      if (byTitle || byId) reasons.push(`Names the thread “${shown(thread.title)}”, which ${thread.settled ? 'is settled' : 'Watcher does not watch'}.`)
    }
    // A link names one pull request; a number its link already named, or said once, is not read again.
    const linked = new Set<string>(), numbers = new Set<number>()
    for (const match of note.matchAll(URLS)) {
      const prKey = pullRequestKey(match[0]) ?? match[0], pr = byKey.get(prKey), number = pullRequestAddress(match[0])?.number
      if (number !== undefined) numbers.add(number)
      if (!pr || linked.has(prKey)) continue
      linked.add(prKey)
      if (pr.state !== 'open') reasons.push(`Names pull request #${pr.number}, which is ${pr.state}.`)
    }
    for (const match of note.matchAll(NUMBERS)) {
      const number = Number(match[1]), known = byNumber.get(number) ?? []
      if (numbers.has(number) || !known.length || known.some(pr => pr.state === 'open')) continue
      numbers.add(number)
      reasons.push(`Names pull request #${number}, which is ${known.every(pr => pr.state === 'merged') ? 'merged' : known.every(pr => pr.state === 'closed') ? 'closed' : 'merged or closed'}.`)
    }
    if (reasons.length) notes.push({ list, index, reasons: reasons.slice(0, 5) })
  })
  return notes
}
