import { pullRequestKey } from '../../shared/gitPullRequests'
import type { WatcherEvidence, WatcherPullRequestSummary, WatcherThreadTarget, WatcherToolInput, WatcherToolName, WatcherToolOutput } from '../../shared/watcher'

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
export function watcherPullRequestSummaries(evidence: readonly WatcherEvidence[]): WatcherPullRequestSummary[] {
  return [...summariesByKey(evidence).values()]
}

type Rows = Extract<WatcherToolOutput<'list_threads'>, { status: 'ok' }>['rows']
type FullRow = Extract<Rows[number], { evidence: unknown }>
/**
 * A roster row as list_threads' slim detail gives it: who it is, where it stands, what it waits on, whether Watcher watches
 * it, and its open pull requests' summaries in place of every evidence fact.
 */
export function watcherSlimRow(row: FullRow, watched: boolean) {
  const said = summariesByKey(row.evidence)
  const open = row.pullRequests.filter(pr => pr.state === 'open').slice(0, 50)
    .map(pr => ({ ...said.get(prKey(pr.url)) ?? { stale: true as const }, number: pr.number, state: said.get(prKey(pr.url))?.state ?? pr.state }))
  return { target: row.target, title: row.title, projectId: row.projectId, status: row.status, group: row.group, waitsOn: row.waitsOn,
    watched, ...row.standingWatch ? { standingWatchId: row.standingWatch.id } : {}, connected: row.connected,
    ...row.protected ? { protected: true as const } : {}, pullRequests: open }
}

const isOk = (result: unknown): result is { status: 'ok' } & Record<string, unknown> =>
  typeof result === 'object' && result !== null && (result as { status?: unknown }).status === 'ok'

/**
 * What Watcher is given of a read's full result, from what its call asked (#1191). Refusals and other tools pass as they
 * are. `watched` says which threads Watcher watches. A paired host's page is filtered here, since the host is not asked to.
 */
export function watcherSlimRead(name: WatcherToolName, input: unknown, result: unknown, watched: (target: WatcherThreadTarget) => boolean): unknown {
  if (!isOk(result)) return result
  if (name === 'list_threads') {
    const asked = input as WatcherToolInput<'list_threads'>, rows = (result.rows as FullRow[]).filter(row => !asked.watchedOnly || watched(row.target))
    return { ...result, rows: asked.detail === 'full' ? rows : rows.map(row => watcherSlimRow(row, watched(row.target))) }
  }
  if (name === 'read_thread') {
    const asked = input as WatcherToolInput<'read_thread'>, evidence = result.evidence as WatcherEvidence[]
    return asked.evidence === 'full' ? result : { ...result, evidence: [], pullRequests: watcherPullRequestSummaries(evidence) }
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
