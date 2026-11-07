import { pullRequestAddress, pullRequestKey } from '../../shared/gitPullRequests'
import { WATCHER_KEPT_LISTS, WATCHER_KEPT_UNTOUCHED_MS, type WatcherKeptState, type WatcherMergeQueueItem, type WatcherPullRequestSummary,
  type WatcherStaleNote, type WatcherThreadTarget } from '../../shared/watcher'

/**
 * What read_state computes from live data at each read (#1274). After a compaction, notes Watcher kept by hand still
 * described threads that had finished and a failure that had moved on, and missed the merge queue. The facts that change
 * are now Sotto's to say, from its own records, and a kept note that names something those records say is over is
 * flagged, so a stale note is seen rather than trusted. Every sentence here is Sotto's; nothing a thread said reaches it.
 */

/**
 * One open pull request of a watched thread, with what the merge train reads of it; `draft` undefined when Sotto cannot
 * say. `head` is the commit Sotto last read it on, `pending` how many of its required and other checks were still to
 * finish on that head (#2116), and `train` since when it has been in the train and the newest READY TO MERGE its thread sent (#2229).
 */
export interface WatcherOpenPullRequest { readonly summary: WatcherPullRequestSummary; readonly draft: boolean | undefined; readonly checksPassedAt?: string
  readonly url?: string; readonly head?: string; readonly pending?: { readonly required: number; readonly optional: number }
  readonly train?: { readonly since: string; readonly ready?: { readonly head: string; readonly at: string } } }

/**
 * Where a pull request's required checks stand, as the train reads them: passed once every check passed, or once only
 * checks no merge waits on are still running; running while any other check runs, since without the rules' counts a
 * running check may be required; unknown when Sotto's read says nothing.
 */
export function requiredChecksOf(pr: Pick<WatcherOpenPullRequest, 'summary' | 'pending'>): WatcherMergeQueueItem['requiredChecks'] {
  const checks = pr.summary.checks
  if (checks === 'passed' || checks === 'failed') return checks
  if (checks === 'pending') return pr.pending?.required === 0 ? 'passed' : 'running'
  return 'unknown'
}

/**
 * The merge queue, which is Watcher's merge train (#2229): every open pull request of a watched thread that is not a draft
 * and that has joined the train, by its checks passing (#1274) or its thread's READY TO MERGE, in the order it joined,
 * oldest first, by number when two joined at once. It stays in the train while its checks run again after a push, so the
 * train says whose required checks are running, which a merge now would land in the middle of. One not known to be a
 * draft or not is left out, and so is one whose summary is stale (#2102) until Sotto reads it again.
 */
export function watcherMergeQueue(threads: readonly { readonly target: WatcherThreadTarget; readonly title: string; readonly open: readonly WatcherOpenPullRequest[] }[]): WatcherMergeQueueItem[] {
  return threads.flatMap(thread => thread.open.flatMap(pr => {
    const since = pr.train?.since ?? (pr.summary.checks === 'passed' ? pr.checksPassedAt : undefined)
    if (pr.summary.state !== 'open' || pr.summary.stale === true || pr.draft !== false || since === undefined) return []
    const ready = pr.train?.ready
    const url = pr.url ?? pr.summary.url
    return [{ target: thread.target, title: thread.title, pullRequest: pr.summary, ...url !== undefined ? { url } : {}, inTrainSince: since, requiredChecks: requiredChecksOf(pr),
      ...pr.checksPassedAt && pr.summary.checks === 'passed' ? { checksPassedAt: pr.checksPassedAt } : {},
      ...pr.head ? { head: pr.head } : {}, ...pr.pending ? { checksRunning: pr.pending } : {},
      ...ready ? { readyToMerge: { head: ready.head, at: ready.at, ...pr.head ? { onHead: pr.head === ready.head } : {} } } : {} }]
  })).sort((a, b) => Date.parse(a.inTrainSince) - Date.parse(b.inTrainSince) || (a.pullRequest.number ?? 0) - (b.pullRequest.number ?? 0))
}

/** The checks on the newest commit of the branch a pull request merges into, as GitHub reports them when a GO MERGE asks. */
export interface BaseBranchChecks { readonly branch: string; readonly head: string; readonly state: 'passed' | 'failed' | 'pending' | 'unknown' }

/**
 * What holds a GO MERGE for `url` (#2229): the other pull requests of the same repository in the train whose required
 * checks are running, which the merge would land in the middle of, and the base branch when its newest commit's checks
 * failed (AGENTS.md: a red run on main is fixed before anything else merges). Nothing holds it when both are clear; a
 * base branch GitHub could not be asked about holds nothing, and the GO MERGE says so.
 */
export function mergeTurnHolds(queue: readonly WatcherMergeQueueItem[], url: string, base: BaseBranchChecks | undefined): { readonly running: readonly WatcherMergeQueueItem[]; readonly baseFailed?: BaseBranchChecks } {
  const going = pullRequestAddress(url), goingKey = pullRequestKey(url)
  const sameRepository = (item: WatcherMergeQueueItem) => {
    const address = item.url !== undefined ? pullRequestAddress(item.url) : null
    return going !== null && address !== null && address.owner.toLowerCase() === going.owner.toLowerCase() && address.name.toLowerCase() === going.name.toLowerCase()
  }
  // A check that failed early leaves the rest running: required checks still running hold the turn whatever else failed.
  const running = queue.filter(item => (item.requiredChecks === 'running' || (item.checksRunning?.required ?? 0) > 0) && sameRepository(item) && pullRequestKey(item.url!) !== goingKey)
  return { running, ...base?.state === 'failed' ? { baseFailed: base } : {} }
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
