import { pullRequestKey } from '../../shared/gitPullRequests'
import { WATCHER_READ_BYTES_MAX, type WatcherEvidence, WatcherPullRequestSummary, WatcherThreadTarget, WatcherToolInput, WatcherToolName, WatcherToolOutput } from '../../shared/watcher'

/**
 * Watcher's read tools, slim by default (#1191). Every result stays in Watcher's conversation and is read again on each of
 * its calls, and a roster row's evidence repeated the same pull request facts on every row. The tools still build their
 * full results, as a paired host answers them; the desktop slims what Watcher is given, last, from what was asked.
 */

/** The keys only the desktop reads. A paired host on any version is sent the call without them, and answers in full. */
const DESKTOP_KEYS: Partial<Record<WatcherToolName, readonly string[]>> = {
  list_threads: ['watchedOnly', 'detail'], read_thread: ['evidence'], list_projects: ['projectId', 'query', 'includeModels'],
}
export function watcherHostInput<T extends object>(name: WatcherToolName, input: T): T {
  const keys = DESKTOP_KEYS[name]
  if (!keys?.some(key => key in input)) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key))) as T
}

const NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/u
/** A pull request's number from its address, which is how a slim read names it; the address only when it has none. */
const named = (url: string): Pick<WatcherPullRequestSummary, 'number' | 'url'> => {
  const number = NUMBER.exec(url)?.[1]
  return number ? { number: Number(number) } : { url }
}
const prKey = (url: string) => pullRequestKey(url) ?? url
/**
 * Each pull request a thread's evidence speaks of, by its key, as one summary: its state and checks as GitHub last said
 * them, approval and auto-merge when on, and stale when any of it is. A fact Sotto has not read is left out, never guessed.
 */
function summariesByKey(evidence: readonly WatcherEvidence[]): Map<string, WatcherPullRequestSummary> {
  const byPr = new Map<string, WatcherEvidence[]>()
  for (const item of evidence) if (item.source === 'github' && item.url) byPr.set(prKey(item.url), [...byPr.get(prKey(item.url)) ?? [], item])
  return new Map([...byPr].slice(-50).map(([key, facts]) => {
    const summary: WatcherPullRequestSummary = named(facts[0]!.url!)
    for (const item of facts) {
      if (item.pullRequestState !== undefined) summary.state = item.pullRequestState
      if (item.checksState !== undefined) summary.checks = item.checksState
      if (item.githubReviewApproved !== undefined) { if (item.githubReviewApproved) summary.approved = true; else delete summary.approved }
      if (item.githubAutoMergeEnabled !== undefined) { if (item.githubAutoMergeEnabled) summary.autoMerge = true; else delete summary.autoMerge }
    }
    if (facts.some(item => item.freshness !== 'fresh')) summary.stale = true
    return [key, summary]
  }))
}
/**
 * A read's pull request summaries, each with its address as well as its number: a read sees only the evidence's newest
 * facts, so another of the thread's pull requests with the same number may not be among them to tell it apart from.
 */
export function watcherPullRequestSummaries(evidence: readonly WatcherEvidence[]): WatcherPullRequestSummary[] {
  const urls = new Map<string, string>()
  for (const item of evidence) if (item.source === 'github' && item.url && !urls.has(prKey(item.url))) urls.set(prKey(item.url), item.url)
  return [...summariesByKey(evidence)].map(([key, summary]) => summary.url === undefined ? { ...summary, url: urls.get(key) ?? key } : summary)
}
/**
 * Pull requests of one thread that share a number, as `api#42` and `ui#42` can, keep their addresses as well, so Watcher
 * can tell which one a summary is of.
 */
function addressShared(items: readonly { url: string; summary: WatcherPullRequestSummary }[]): WatcherPullRequestSummary[] {
  const counts = new Map<number, number>()
  for (const { summary } of items) if (summary.number !== undefined) counts.set(summary.number, (counts.get(summary.number) ?? 0) + 1)
  return items.map(({ url, summary }) => summary.number !== undefined && counts.get(summary.number)! > 1 && summary.url === undefined ? { ...summary, url } : summary)
}

/**
 * A thread's open pull requests as its links list them, each with its summary from what the evidence says, its address
 * kept when another shares its number: the open pull requests of a slim roster row and of read_state (#1274).
 */
export function watcherOpenPullRequests<P extends { readonly number: number; readonly url: string; readonly state: 'open' | 'closed' | 'merged' }>(
  pullRequests: readonly P[], evidence: readonly WatcherEvidence[]): { pr: P; summary: WatcherPullRequestSummary }[] {
  const said = summariesByKey(evidence), open = pullRequests.filter(pr => stateOf(pr, said) === 'open').slice(0, 50)
  const summaries = addressShared(open.map(pr => ({ url: pr.url, summary: { ...said.get(prKey(pr.url)) ?? { stale: true as const }, number: pr.number, state: 'open' as const } })))
  return open.map((pr, index) => ({ pr, summary: summaries[index]! }))
}
/**
 * A pull request's state as GitHub last gave it to Sotto, else as its link holds it: a link keeps the state it was last
 * read in, which may be long before a merge (#1147).
 */
const stateOf = (pr: { readonly url: string; readonly state: 'open' | 'closed' | 'merged' }, said: ReadonlyMap<string, WatcherPullRequestSummary>) =>
  said.get(prKey(pr.url))?.state ?? pr.state
/** How many of a thread's pull requests are merged and how many closed, each said only when there are any (#1147). */
function endedCounts(states: readonly ('open' | 'closed' | 'merged' | undefined)[]): { mergedPullRequests?: number; closedPullRequests?: number } {
  const merged = states.filter(state => state === 'merged').length, closed = states.filter(state => state === 'closed').length
  return { ...merged ? { mergedPullRequests: merged } : {}, ...closed ? { closedPullRequests: closed } : {} }
}
/** The pull requests a thread's evidence says are merged or closed, by key, for what a later slim read leaves out (#1147). */
export function watcherEndedPullRequests(evidence: readonly WatcherEvidence[]): Set<string> {
  return new Set([...summariesByKey(evidence)].filter(([, summary]) => summary.state === 'merged' || summary.state === 'closed').map(([key]) => key))
}

type Rows = Extract<WatcherToolOutput<'list_threads'>, { status: 'ok' }>['rows']
type FullRow = Extract<Rows[number], { evidence: unknown }>
/**
 * A roster row as list_threads' slim detail gives it: who it is, where it stands, what it waits on, whether Watcher watches
 * it, and its open pull requests' summaries in place of every evidence fact.
 */
export function watcherSlimRow(row: FullRow, watched: boolean, turnFailed = false, prototypeReady = false) {
  const open = watcherOpenPullRequests(row.pullRequests, row.evidence).map(item => item.summary)
  const said = summariesByKey(row.evidence)
  // Why it needs the user or is not watched: its last turn's failure, and its newest participation's takeover or stop.
  const latest = row.participation.at(-1)
  return { target: row.target, title: row.title, projectId: row.projectId, status: row.status, group: row.group, waitsOn: row.waitsOn,
    watched, ...row.standingWatch ? { standingWatchId: row.standingWatch.id } : {}, connected: row.connected,
    ...turnFailed ? { turnFailed: true as const } : {}, ...latest?.state === 'taken-over' ? { takenOver: true as const } : {},
    ...latest?.automationStopped ? { automationStopped: true as const } : {}, ...prototypeReady ? { prototypeReady: true as const } : {},
    ...row.protected ? { protected: true as const } : {}, pullRequests: open, ...endedCounts(row.pullRequests.map(pr => stateOf(pr, said))) }
}

const isOk = (result: unknown): result is { status: 'ok' } & Record<string, unknown> =>
  typeof result === 'object' && result !== null && (result as { status?: unknown }).status === 'ok'

/** What the desktop knows of each thread that a slim read says beside the read's own result. */
export interface WatcherSlimLookups {
  /**
   * Whether a thread's last turn failed, from the thread itself: its turn facts cannot, as a paired host's sits beside the
   * desktop's own and either can be the older.
   */
  readonly turnFailed?: (target: WatcherThreadTarget) => boolean
  /**
   * Whether a prototype the thread made waits for the user's review (ADR-0108), from the thread too, so a paired host never
   * sends a field an older desktop refuses.
   */
  readonly prototypeReady?: (target: WatcherThreadTarget) => boolean
  /** The pull requests the last read of the thread given to this Watcher conversation held merged or closed (#1147). */
  readonly endedBefore?: (target: WatcherThreadTarget) => ReadonlySet<string> | undefined
}
/**
 * What Watcher is given of a read's full result, from what its call asked (#1191). Refusals and other tools pass as they
 * are. `watched` says which threads Watcher watches. A paired host's page is filtered here, since the host is not asked to.
 */
export function watcherSlimRead(name: WatcherToolName, input: unknown, result: unknown, watched: (target: WatcherThreadTarget) => boolean,
  lookups: WatcherSlimLookups = {}): unknown {
  const { turnFailed = () => false, prototypeReady = () => false, endedBefore = () => undefined } = lookups
  if (!isOk(result)) return result
  if (name === 'list_threads') {
    const asked = input as WatcherToolInput<'list_threads'>, rows = (result.rows as FullRow[]).filter(row => !asked.watchedOnly || watched(row.target))
    // A paired host's page is filtered here, so its counts are counted again from what is left.
    const counts = asked.watchedOnly ? Object.fromEntries(Object.keys(result.counts as Record<string, number>).map(group => [group, rows.filter(row => row.group === group).length])) : result.counts
    return { ...result, counts, rows: asked.detail === 'full' ? rows.map(row => ({ ...row, watched: watched(row.target), ...prototypeReady(row.target) ? { prototypeReady: true as const } : {} }))
      : rows.map(row => watcherSlimRow(row, watched(row.target), turnFailed(row.target), prototypeReady(row.target))) }
  }
  if (name === 'read_thread') {
    const asked = input as WatcherToolInput<'read_thread'>, evidence = result.evidence as WatcherEvidence[]
    const read = prototypeReady(result.target as WatcherThreadTarget) ? { ...result, prototypeReady: true as const } : result
    // Only the pull request facts are summed up; the thread's own facts, a failed turn, a takeover or a receipt, are few and stay.
    if (asked.evidence === 'full') return read
    // A merged or closed pull request is summed up only when it became so since Watcher's last read of the thread; the
    // others are counted. Before a first read, every one is counted: the news told each merge or close as it came (#1147).
    const before = endedBefore(result.target as WatcherThreadTarget), summaries = watcherPullRequestSummaries(evidence)
    const ended = (summary: WatcherPullRequestSummary) => summary.state === 'merged' || summary.state === 'closed'
    const pullRequests = summaries.filter(summary => !ended(summary) || before !== undefined && !before.has(prKey(summary.url!)))
    const left = endedCounts(summaries.filter(summary => !pullRequests.includes(summary)).map(summary => summary.state))
    const slim = { ...read, evidence: evidence.filter(fact => fact.source !== 'github'), ...pullRequests.length ? { pullRequests } : {}, ...left }
    // The full read was cut to the read bound. A slim one is almost always smaller; one that is not is given in full.
    return Buffer.byteLength(JSON.stringify(slim)) > WATCHER_READ_BYTES_MAX ? read : slim
  }
  if (name === 'list_projects') {
    const asked = input as WatcherToolInput<'list_projects'>, query = asked.query?.toLowerCase()
    type Project = Extract<WatcherToolOutput<'list_projects'>, { status: 'ok' }>['projects'][number]
    const projects = (result.projects as Project[]).filter(project => (!asked.projectId || project.target.projectId === asked.projectId)
      && (!query || project.title.toLowerCase().includes(query) || project.displayRoot.toLowerCase().includes(query)))
    return { ...result, projects: asked.includeModels ? projects : projects.map(({ workers: _workers, ...project }) => { void _workers; return project }) }
  }
  return result
}
