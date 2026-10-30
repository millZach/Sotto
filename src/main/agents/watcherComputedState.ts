import { pullRequestAddress, pullRequestKey } from '../../shared/gitPullRequests'
import { WATCHER_KEPT_LISTS, WATCHER_KEPT_UNTOUCHED_MS, type WatcherKeptState, type WatcherMergeQueueItem, type WatcherPullRequestSummary,
  type WatcherStaleNote, type WatcherThreadTarget } from '../../shared/watcher'

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
const QUALIFIED = /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/giu
const NUMBERS = /(?:#|\b(?:pr|pull request)\s*#?\s*)(\d+)\b/giu
const WORDED_NUMBERS = /\b(?:pr|pull request)\s*#?\s*(\d+)\b/giu
const shown = (title: string) => title.length > TITLE_SHOWN_MAX ? `${title.slice(0, TITLE_SHOWN_MAX - 1)}…` : title

const DAY_MS = 24 * 60 * 60 * 1_000
/**
 * The open kept lines that may be done, by ID, and why: one that names a settled or unwatched thread, by its title or ID,
 * or a merged or closed pull request, by its link or number, and one not added or edited in WATCHER_KEPT_UNTOUCHED_MS,
 * so an old line is looked at again rather than carried on (October 24, 2026). A title two threads share is said of the
 * one that is watched and not settled when there is one, so it flags nothing; a number two pull requests share flags only
 * when neither is open. A closed line is done already, and flags nothing.
 */
export function watcherStaleNotes(kept: Pick<WatcherKeptState, 'decisions' | 'rules' | 'issues'>, threads: readonly WatcherKnownThread[],
  pullRequests: readonly WatcherKnownPullRequest[], now: number): WatcherStaleNote[] {
  const live = new Set(threads.filter(thread => thread.watched && !thread.settled).map(thread => fold(thread.title)))
  const over = threads.filter(thread => thread.settled || !thread.watched)
  const byKey = new Map<string, WatcherKnownPullRequest>(), byNumber = new Map<number, WatcherKnownPullRequest[]>()
  for (const pr of pullRequests) {
    const prKey = pullRequestKey(pr.url) ?? pr.url
    if (byKey.has(prKey)) continue
    byKey.set(prKey, pr); byNumber.set(pr.number, [...byNumber.get(pr.number) ?? [], pr])
  }
  const notes: WatcherStaleNote[] = []
  for (const list of WATCHER_KEPT_LISTS) for (const line of kept[list]) {
    if (line.closedAt !== undefined) continue
    const note = line.text, text = fold(note), reasons: string[] = []
    for (const thread of over) {
      const title = fold(thread.title)
      const byTitle = (title.length >= TITLE_MIN || title.includes(' ')) && !STAND_IN_TITLES.has(title) && !live.has(title) && names(text, title)
      const byId = thread.target.threadId.length >= ID_MIN && text.includes(thread.target.threadId.toLowerCase())
      if (byTitle || byId) reasons.push(`Names the thread “${shown(thread.title)}”, which ${thread.settled ? 'is settled' : 'Watcher does not watch'}.`)
    }
    // A link or an `owner/repo#N` names one pull request in its own repository; a number one of them already named, or said
    // once, is not read again. The issues list numbers issues the same way, so there a bare number counts only as "PR 12".
    const linked = new Set<string>(), numbers = new Set<number>()
    const named = [...[...note.matchAll(URLS)].map(match => ({ prKey: pullRequestKey(match[0]) ?? match[0], number: pullRequestAddress(match[0])?.number })),
      ...[...note.matchAll(QUALIFIED)].map(match => ({ prKey: `${match[1]}/${match[2]}#${match[3]}`.toLowerCase(), number: Number(match[3]) }))]
    for (const { prKey, number } of named) {
      const pr = byKey.get(prKey)
      if (number !== undefined) numbers.add(number)
      if (!pr || linked.has(prKey)) continue
      linked.add(prKey)
      if (pr.state !== 'open') reasons.push(`Names pull request #${pr.number}, which is ${pr.state}.`)
    }
    for (const match of note.replace(URLS, ' ').replace(QUALIFIED, ' ').matchAll(list === 'issues' ? WORDED_NUMBERS : NUMBERS)) {
      const number = Number(match[1]), known = byNumber.get(number) ?? []
      if (numbers.has(number) || !known.length || known.some(pr => pr.state === 'open')) continue
      numbers.add(number)
      reasons.push(`Names pull request #${number}, which is ${known.every(pr => pr.state === 'merged') ? 'merged' : known.every(pr => pr.state === 'closed') ? 'closed' : 'merged or closed'}.`)
    }
    const untouched = now - Date.parse(line.touchedAt)
    if (untouched >= WATCHER_KEPT_UNTOUCHED_MS) {
      reasons.splice(5)
      reasons.push(`Not added or edited for ${Math.floor(untouched / DAY_MS)} days. If it is done, close it; if it still stands, edit it, with the same words if they still fit; if it is wrong, drop it.`)
    }
    if (reasons.length) notes.push({ list, id: line.id, reasons: reasons.slice(0, 6) })
  }
  return notes
}
