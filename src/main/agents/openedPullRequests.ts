import type { AgentActivity } from '../../shared/agentActivity'
import { pullRequestAddress, pullRequestKey } from '../../shared/gitPullRequests'

/**
 * The pull requests a thread's turn opened, found as the turn ends, so a thread that opens one from its own shell has it
 * linked as one it created, as Create PR links one (#2307): read_state, the merge queue and Watcher's pull
 * request news all read a thread's links and its branch's own, and a lane whose branch is not the one it pushed, or
 * that nobody has open, had neither. Two signals, each a link only once GitHub confirms the pull request exists:
 *
 * - a `gh pr create` the turn ran: the URLs its output prints, which is the pull request it opened, or the one that
 *   already existed for its branch;
 * - the turn's reply: a GitHub pull request URL it names, only if GitHub says that pull request was opened after the
 *   turn began, so a reply that cites another thread's pull request, or an old one, links nothing.
 *
 * Reads only the ended turn's records and reply, never the thread's history, at most OPENED_PULL_REQUESTS_MAX each.
 */
export const OPENED_PULL_REQUESTS_MAX = 5
/** How much earlier than the turn's start GitHub's clock may say a pull request the turn opened was opened. */
export const OPENED_CLOCK_SLACK_MS = 2 * 60_000

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/u
const PULL_REQUEST_URLS = /https:\/\/github\.com\/[^/\s?#)\]"'`<>]+\/[^/\s?#)\]"'`<>]+\/pull\/\d+/giu

/** Each GitHub pull request URL in `text`, once by its key, in the order they appear, at most OPENED_PULL_REQUESTS_MAX. */
export function pullRequestUrlsIn(text: string | undefined): string[] {
  if (!text) return []
  const seen = new Set<string>(), urls: string[] = []
  for (const match of text.matchAll(PULL_REQUEST_URLS)) {
    const key = pullRequestKey(match[0]), address = pullRequestAddress(match[0])
    if (!key || !address || seen.has(key)) continue
    seen.add(key)
    urls.push(`https://github.com/${address.owner}/${address.name}/pull/${address.number}`)
    if (urls.length >= OPENED_PULL_REQUESTS_MAX) break
  }
  return urls
}

/** The newest turn's records and when it began, from the records a thread holds as its turn ends. */
export function endedTurn(activities: readonly AgentActivity[] | undefined): { readonly records: readonly AgentActivity[]; readonly startedAt: number | undefined } {
  if (!activities?.length) return { records: [], startedAt: undefined }
  let turn: AgentActivity | undefined
  for (const record of activities) if (record.kind === 'turn' && (!turn || record.sequence >= turn.sequence)) turn = record
  const turnId = turn?.turnId ?? activities.at(-1)!.turnId
  const records = activities.filter(record => record.turnId === turnId)
  const started = turn?.startedAt ?? records.reduce<string | undefined>((first, record) => record.startedAt !== undefined && (first === undefined || record.startedAt < first) ? record.startedAt : first, undefined)
  const startedAt = started === undefined ? undefined : Date.parse(started)
  return { records, startedAt: Number.isFinite(startedAt) ? startedAt : undefined }
}

/** The pull request URLs the `gh pr create` commands among `records` printed. */
export function createdPullRequestUrls(records: readonly AgentActivity[]): string[] {
  const text = records.filter(record => record.kind === 'command' && record.command !== undefined && GH_PR_CREATE.test(record.command))
    .map(record => `${record.output ?? ''}\n${record.error ?? ''}`).join('\n')
  return pullRequestUrlsIn(text)
}

/** Whether a pull request GitHub says was opened at `createdAt` was opened during a turn that began at `turnStartedAt`. */
export function openedDuringTurn(createdAt: string | undefined, turnStartedAt: number | undefined): boolean {
  if (createdAt === undefined || turnStartedAt === undefined) return false
  const opened = Date.parse(createdAt)
  return Number.isFinite(opened) && opened >= turnStartedAt - OPENED_CLOCK_SLACK_MS
}
