import { randomUUID } from 'node:crypto'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RequestDraftOwner } from '../../src/shared/requestDrafts'
import type { WatcherOperation, WatcherRecord, WatcherRequest, WatcherThreadTarget } from '../../src/shared/watcher'

/**
 * The owner's history on October 20, 2026, as counts only: about 250 threads on this computer, one connected remote host
 * with about 40 threads that held answered questions, 256 answer retirements (40 of them on that host) and 4 Watcher
 * owners in request-drafts.json, and a Watcher record with about 150 operations, 160 requests and 5 standing watches.
 * Nothing built from it is anyone's words. `tests/fixtures/ownerScalePipeline.ts` builds main with it for the work
 * budget, and `tests/e2e/main-freeze.spec.ts` builds the app with it for the nightly timing run.
 */
export const OWNER_SCALE = { threads: 250, remoteThreads: 40, retirements: 256, remoteRetirements: 40, watcherOwners: 4,
  operations: 150, requests: 160, watches: 5 } as const
export type OwnerScaleCounts = { -readonly [K in keyof typeof OWNER_SCALE]: number }

/**
 * How much of the owner's world to build: `threads` scales this computer's threads, and `history` scales everything the
 * owner accumulated besides them: the remote host's answered threads, the answer retirements and Watcher owners, and
 * Watcher's requests, operations and watches. The work budget grows each on its own, so a failure can say which grew.
 */
export interface OwnerScale { readonly threads: number; readonly history: number }

/** The owner's counts at `scale`, at least one of each. A number scales both the threads and the history. */
export function ownerScaleCounts(scale: number | OwnerScale): OwnerScaleCounts {
  const { threads, history } = typeof scale === 'number' ? { threads: scale, history: scale } : scale
  return Object.fromEntries(Object.entries(OWNER_SCALE).map(([name, count]) => [name, Math.max(1, Math.round(count * (name === 'threads' ? threads : history)))])) as OwnerScaleCounts
}

const AT = '2026-10-20T12:00:00.000Z'
const digest = (index: number): string => index.toString(16).padStart(64, '0')

/**
 * Watcher's past work, added to `record`: `requests` requests, each with two threads that took part, one still
 * participating and one relinquished, and `operations` starts and sends to them, every one long answered. `targets` are
 * the threads that took part, round robin; a thread that streams or is typed in should not be one. With `letGo`, the
 * thread each request relinquished is one of those in turn instead, which may stream: Watcher let it go, so nothing it
 * does reaches Watcher, and its row in the room carries that history (#1450). The requests are the current Watcher's, or
 * `watcher`'s when the record has none.
 */
export function addWatcherHistory(record: WatcherRecord, targets: readonly WatcherThreadTarget[], counts: Pick<OwnerScaleCounts, 'requests' | 'operations'>,
  watcher: WatcherThreadTarget | undefined = record.current?.target, letGo: readonly WatcherThreadTarget[] = []): void {
  if (!watcher) throw new Error('Name the Watcher whose history this is.')
  const requests: WatcherRequest[] = Array.from({ length: counts.requests }, (_, index) => {
    const id = randomUUID()
    // The thread each request let go is one of `letGo` in turn, when there are any, so the record is the same size.
    const taking = [targets[(index * 2) % targets.length]!, letGo.length ? letGo[index % letGo.length]! : targets[(index * 2 + 1) % targets.length]!]
    return { id, watcher, rootUserMessageId: `watcher-prompt-${index}`, state: 'closed', createdAt: AT, closedAt: AT,
      participants: taking.map((target, position) => ({ target, requestId: id, startedBy: 'watcher' as const, generation: 0,
        state: position === 0 ? 'participating' as const : 'relinquished' as const, lastUserMessageId: null, promptCount: 1 })) }
  })
  const operations: WatcherOperation[] = Array.from({ length: counts.operations }, (_, index) => {
    const request = requests[index % requests.length]!
    return { id: randomUUID(), requestId: request.id, retryKey: randomUUID(), digest: digest(index + 1), action: index % 3 === 0 ? 'start' : 'send',
      target: request.participants[0]!.target, generation: 0, deliveryState: 'accepted', createdAt: AT, updatedAt: AT,
      receiptId: `receipt-${index}`, cardId: `card-${index}`, outcome: 'answered', outcomeAt: AT }
  })
  record.requests.push(...requests)
  record.operations.push(...operations)
}

/**
 * The contents of request-drafts.json with the owner's answered questions: no drafts, `retirements` retirements, the
 * first `remoteRetirements` on the remote host's threads and the rest on this computer's `local` threads, and
 * `watcherOwners` Watcher owners. Thread IDs are as each host names them.
 */
export function ownerRequestDrafts(local: readonly string[], remote: { readonly hostId: string; readonly threadIds: readonly string[] },
  counts: Pick<OwnerScaleCounts, 'retirements' | 'remoteRetirements' | 'watcherOwners'>): string {
  const owner = (ownerId: string): RequestDraftOwner => ({ kind: 'thread', ownerId, providerId: 'claude' })
  const retirements = Array.from({ length: counts.retirements }, (_, index) => ({
    owner: owner(index < counts.remoteRetirements ? hostEntityKey(remote.hostId, remote.threadIds[index % remote.threadIds.length]!) : local[index % local.length]!),
    requestId: `answered-${index}`, questionsDigest: digest(index + 1), decisionId: `decision-${index}`, revision: 1 }))
  return JSON.stringify({ version: 2, drafts: [], retirements,
    watcherOwners: Array.from({ length: counts.watcherOwners }, (_, index) => owner(local[local.length - 1 - index]!)) })
}
