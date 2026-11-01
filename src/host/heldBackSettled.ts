import type { AgentProject, AgentThread } from '../shared/agents'
import { isThreadSettled, isWorkspaceThreadSettled } from '../shared/threadActivity'

/**
 * Settled threads a phone is not sent with its list (`settled-threads-on-request`, ADR-0028's November 1 amendment, part
 * 2). The iPhone shows settled threads only on its Settled shelf, and on the owner's laptop they were 584 of 632 threads:
 * 1.4 MB of every hello. A phone that accepts the feature is sent the threads settled in the last `SETTLED_KEPT_MS`, so
 * what was just settled stays on it and Undo never waits, and reads the rest with `settled-threads` when the user opens
 * them or searches.
 *
 * Settled is read as the iPhone reads it (`ThreadGroups.isSettled`): the thread's or its project's workspace grouping, an
 * archive, or the provider's own settlement unless the thread was made active again. A thread is held back only when it
 * was settled before the window, asks the user nothing, is not open on the phone, and is not a thread one that asks the
 * user something was delegated from, so Needs you and an open thread read as before. One settled with no time named is
 * taken as settled long ago.
 */
export const SETTLED_KEPT_MS = 7 * 24 * 60 * 60 * 1000

/** The most threads one `settled-threads` read returns, and how many it returns when it names none. */
export const SETTLED_PAGE_MAX = 50
export const SETTLED_PAGE_DEFAULT = 30

/** When `thread` was settled, in ms, the latest time any of its settlements names; -Infinity when none names one; null when open. */
export function settledSince(thread: AgentThread, project: Pick<AgentProject, 'workspaceSettledAt'> | undefined): number | null {
  const workspace = isWorkspaceThreadSettled(thread, project), archived = typeof thread.archivedAt === 'string' && Number.isFinite(Date.parse(thread.archivedAt))
  const provider = isThreadSettled(thread)
  if (!workspace && !archived && !provider) return null
  const times = [workspace ? thread.workspaceSettledAt : undefined, workspace ? project?.workspaceSettledAt : undefined,
    archived ? thread.archivedAt : undefined, provider ? thread.settledAt : undefined]
    .map(value => typeof value === 'string' ? Date.parse(value) : Number.NaN).filter(Number.isFinite)
  return times.length ? Math.max(...times) : Number.NEGATIVE_INFINITY
}

/** The IDs of the threads a phone is not sent: settled before the window, and none of the threads it must keep. */
export function heldBackSettled(threads: readonly AgentThread[], projects: readonly AgentProject[], { now, kept }: { now: number; kept: ReadonlySet<string> }): Set<string> {
  const byProject = new Map(projects.map(project => [project.id, project]))
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const keep = new Set(kept)
  // A thread that asks the user something, and every thread above it in its delegation, so Needs you shows it where it was.
  for (const thread of threads) {
    if (!thread.requests.length) continue
    let at: AgentThread | undefined = thread
    while (at && !keep.has(at.id)) { keep.add(at.id); at = at.delegatedBy ? byId.get(at.delegatedBy) : undefined }
  }
  const held = new Set<string>()
  for (const thread of threads) {
    if (keep.has(thread.id)) continue
    const since = settledSince(thread, byProject.get(thread.projectId))
    if (since !== null && since < now - SETTLED_KEPT_MS) held.add(thread.id)
  }
  return held
}

/**
 * One page of `held`, the threads a phone was not sent, newest settled first: those after `after` (the `next` of the
 * page before), matching `query` in their title or project when there is one. `next` names the last thread returned when
 * more follow. A cursor names a place in the order, so a page after a thread that has since been restored or reopened
 * starts where that thread was.
 */
export function settledPage(held: readonly AgentThread[], projects: readonly AgentProject[], { after, query, limit = SETTLED_PAGE_DEFAULT }: { after?: string | undefined; query?: string | undefined; limit?: number | undefined }): { threads: AgentThread[]; next: string | null } {
  const byProject = new Map(projects.map(project => [project.id, project]))
  const words = query?.trim().toLocaleLowerCase()
  const cursor = after ? readCursor(after) : undefined
  const size = Math.min(Math.max(1, limit), SETTLED_PAGE_MAX)
  // One pass keeps the page and the one after it in order, so a read costs the same per thread however many are held back.
  const best: { thread: AgentThread; since: number }[] = []
  for (const thread of held) {
    const since = settledSince(thread, byProject.get(thread.projectId)) ?? Number.NEGATIVE_INFINITY
    if (cursor && !follows(since, thread.id, cursor)) continue
    if (words && !`${thread.title} ${byProject.get(thread.projectId)?.title ?? ''} ${thread.providerId ?? ''}`.toLocaleLowerCase().includes(words)) continue
    if (best.length > size && !precedes(since, thread.id, best[size]!)) continue
    let at = best.length
    while (at > 0 && precedes(since, thread.id, best[at - 1]!)) at--
    best.splice(at, 0, { thread, since })
    if (best.length > size + 1) best.pop()
  }
  const page = best.slice(0, size), last = page.at(-1)
  return { threads: page.map(({ thread }) => thread), next: last && best.length > size ? writeCursor(last.since, last.thread.id) : null }
}

/** Whether a thread settled at `since` comes before `other` in the order: newest settled first, then by ID. */
const precedes = (since: number, id: string, other: { thread: AgentThread; since: number }): boolean =>
  since > other.since || (since === other.since && id < other.thread.id)
/** Whether a thread comes after the place `cursor` names. */
const follows = (since: number, id: string, cursor: { since: number; id: string }): boolean =>
  since < cursor.since || (since === cursor.since && id > cursor.id)

/** A place in the order: when the thread was settled, and its ID for threads settled at the same time. */
const writeCursor = (since: number, id: string): string => `${Number.isFinite(since) ? since : '-'}:${id}`
function readCursor(text: string): { since: number; id: string } | undefined {
  const at = text.indexOf(':')
  if (at < 1) return undefined
  const head = text.slice(0, at), since = head === '-' ? Number.NEGATIVE_INFINITY : Number(head)
  return Number.isNaN(since) ? undefined : { since, id: text.slice(at + 1) }
}
