import { createHash } from 'node:crypto'
import type { AgentThread } from '../../shared/agents'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { watcherEvidenceSchema, type WatcherEvidence, type WatcherThreadTarget } from '../../shared/watcher'

export const observationDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const targetKey = (target: WatcherThreadTarget): string => JSON.stringify([target.hostId, target.threadId])
export interface PullRequestObservation {
  url: string; observedAt: string; head: string | null; state?: 'open' | 'closed' | 'merged'
  availability: 'available' | 'unavailable'; reason?: 'read-failed' | 'rate-limited'
  checks?: 'passed' | 'failed' | 'pending' | 'unknown'; checkCount?: number; reviewApproved?: boolean
  autoMerge?: boolean
}
export interface CheckpointObservation {
  threadId: string; checkpointId: string; observedAt: string; turnId?: string; changedFiles?: number
  availability: 'available' | 'unavailable' | 'unsupported'; reason?: 'capture-unavailable' | 'shared-checkout' | 'unsupported'
}
/** Bounded in-memory facts only. Never keep raw errors, file paths, tool inputs, output or review bodies. */
export class WatcherEvidenceStore {
  private readonly entries = new Map<string, Map<string, WatcherEvidence>>()
  put(slot: string, input: Omit<WatcherEvidence, 'id'>): boolean {
    const id = observationDigest([slot, input.target, { ...input, observedAt: undefined }])
    const parsed = watcherEvidenceSchema.safeParse({ ...input, id })
    if (!parsed.success) return false
    const item = parsed.data
    const key = targetKey(item.target), entries = this.entries.get(key) ?? new Map<string, WatcherEvidence>()
    const previous = entries.get(slot)
    entries.delete(slot); entries.set(slot, item)
    while (entries.size > 100) entries.delete(entries.keys().next().value!)
    this.entries.set(key, entries)
    return previous?.id !== id
  }
  read(target: WatcherThreadTarget, connected = true, now = Date.now()): WatcherEvidence[] {
    return [...this.entries.get(targetKey(target))?.values() ?? []].map(item => ({ ...item,
      ...connected ? (['github', 'working-copy'].includes(item.source) && now - Date.parse(item.observedAt) > 5 * 60_000 ? { freshness: 'stale' as const } : {})
        : { freshness: 'stale' as const, availability: 'unavailable' as const, reason: 'disconnected' as const } }))
  }
  removeMissing(targets: ReadonlySet<string>): void { for (const key of this.entries.keys()) if (!targets.has(key)) this.entries.delete(key) }
  observeThread(thread: AgentThread, target: WatcherThreadTarget, observedAt: string): boolean {
    let changed = false
    const turn = thread.lastTurn
    if (thread.status !== 'running' && turn && (turn.status === 'completed' || turn.status === 'failed')) {
      changed = this.put('turn', { target, source: 'native-turn', observedAt, freshness: 'fresh', availability: 'available',
        turnId: turn.id, fact: turn.status === 'failed' ? 'turn-failed' : 'turn-finished',
        ...(turn.status === 'failed' ? { failureCategory: 'provider-turn-failed' as const } : {}) }) || changed
    }
    const git = thread.worktree?.git
    if (git) changed = this.put('working-copy', { target, source: 'working-copy', observedAt: git.readAt,
      freshness: 'fresh', availability: 'available', fact: 'files-changed', branch: git.branch,
      changedFiles: git.changedFiles, insertions: git.insertions, deletions: git.deletions, fetchedAt: git.fetchedAt }) || changed
    const prs = [...thread.pullRequests ?? [], ...git?.pullRequest ? [git.pullRequest] : []]
    const links = new Set(prs.map(pr => pullRequestKey(pr.url)))
    const entries = this.entries.get(targetKey(target))
    for (const slot of entries?.keys() ?? []) if (slot.startsWith('pr:') && !links.has(slot.slice(3))) { entries!.delete(slot); changed = true }
    for (const pr of prs) {
      const slot = `pr:${pullRequestKey(pr.url)}`
      const branchObserved = !!git?.pullRequest && pullRequestKey(git.pullRequest.url) === pullRequestKey(pr.url)
      // A saved link proves an association; only a read proves checks. Preserve a more detailed observer snapshot.
      if (!entries?.has(slot) || entries.get(slot)?.pullRequestState !== pr.state && Date.parse(git?.readAt ?? '') > Date.parse(entries.get(slot)!.observedAt)) {
        changed = this.put(slot, { target, source: 'github', observedAt: git?.readAt ?? ('linkedAt' in pr && typeof pr.linkedAt === 'string' ? pr.linkedAt : observedAt),
          freshness: branchObserved ? 'fresh' : 'unknown', availability: branchObserved ? 'available' : 'unavailable', reason: 'checks-unavailable', url: pr.url,
          pullRequestState: pr.state, fact: branchObserved && pr.state === 'merged' ? 'merge-observed' : 'pull-request-observed' }) || changed
      }
    }
    return changed
  }
  pullRequest(target: WatcherThreadTarget, read: PullRequestObservation): boolean {
    const available = read.availability === 'available'
    const fact = read.state === 'merged' ? 'merge-observed' : read.autoMerge ? 'auto-merge-observed' : read.checks === 'failed' ? 'checks-failed'
      : read.checks === 'passed' ? 'checks-passed' : read.reviewApproved ? 'review-approved' : 'pull-request-observed'
    return this.put(`pr:${pullRequestKey(read.url)}`, { target, source: 'github', observedAt: read.observedAt,
      freshness: available ? 'fresh' : 'stale', availability: read.availability, fact, url: read.url,
      ...(read.head ? { headId: read.head } : {}), ...(read.state ? { pullRequestState: read.state } : {}),
      ...(read.reason ? { reason: read.reason } : read.checks === 'unknown' ? { reason: 'checks-unavailable' as const } : {}),
      ...(read.checks ? { checksState: read.checks } : {}), ...(read.reviewApproved !== undefined ? { githubReviewApproved: read.reviewApproved } : {}),
      ...(read.checkCount !== undefined ? { checkCount: read.checkCount } : {}) })
  }
  checkpoint(target: WatcherThreadTarget, read: CheckpointObservation): boolean {
    return this.put('checkpoint', { target, source: 'checkpoint', observedAt: read.observedAt, freshness: 'fresh',
      availability: read.availability, fact: 'files-changed', checkpointId: read.checkpointId,
      ...(read.turnId ? { turnId: read.turnId } : {}), ...(read.changedFiles !== undefined && read.availability === 'available' ? { changedFiles: read.changedFiles } : {}),
      ...(read.reason ? { reason: read.reason } : {}) })
  }
}
