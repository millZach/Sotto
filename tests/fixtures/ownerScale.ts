import { randomUUID } from 'node:crypto'
import type { AgentSkillCatalog } from '../../src/shared/agentSkills'
import { MAX_DELIVERED_DRAFTS, type AgentDelivery } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RequestDraftOwner } from '../../src/shared/requestDrafts'
import { emptyWatcherRecord, type WatcherIdentity, type WatcherOperation, type WatcherPromptTurn, type WatcherRecord, type WatcherRequest, type WatcherThreadTarget } from '../../src/shared/watcher'

/**
 * The owner's history on October 20, 2026, as counts only: about 250 threads on this computer, one connected remote host
 * with about 40 threads that held answered questions, 256 answer retirements (40 of them on that host) and 4 Watcher
 * owners in request-drafts.json, a Watcher record with about 150 operations, 160 requests and 5 standing watches, and
 * 40 threads delegated from a thread Watcher does not watch (ADR-0081), which count as history.
 * Nothing built from it is anyone's words. `tests/fixtures/ownerScalePipeline.ts` builds main with it for the work
 * budget, and `tests/e2e/main-freeze.spec.ts` builds the app with it for the nightly timing run.
 */
export const OWNER_SCALE = { threads: 250, remoteThreads: 40, retirements: 256, remoteRetirements: 40, watcherOwners: 4,
  operations: 150, requests: 160, watches: 5, delegations: 40 } as const
export type OwnerScaleCounts = { -readonly [K in keyof typeof OWNER_SCALE]: number }

/**
 * How much of the owner's world to build: `threads` scales this computer's threads, and `history` scales everything the
 * owner accumulated besides them: the remote host's answered threads, the answer retirements and Watcher owners, and
 * Watcher's requests, operations and watches. The work budget grows each on its own, so a failure can say which grew.
 */
export interface OwnerScale {
  readonly threads: number
  readonly history: number
  /**
   * How much longer Watcher's own record is than the rest of the history makes it: its requests and operations are
   * scaled by `history` times this. A long-running Watcher thread grows them on its own, with every instruction it is
   * given (October 28, 2026: 1,255 requests and 1,126 operations, from 160 and 150 eight days before).
   */
  readonly watcher?: number
}

const WATCHER_RECORD = new Set(['requests', 'operations'])

/** The owner's counts at `scale`, at least one of each. A number scales both the threads and the history. */
export function ownerScaleCounts(scale: number | OwnerScale): OwnerScaleCounts {
  const { threads, history, watcher = 1 } = typeof scale === 'number' ? { threads: scale, history: scale } : scale
  return Object.fromEntries(Object.entries(OWNER_SCALE).map(([name, count]) => [name,
    Math.max(1, Math.round(count * (name === 'threads' ? threads : history * (WATCHER_RECORD.has(name) ? watcher : 1))))])) as OwnerScaleCounts
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
  // Each request began its own Watcher turn, at its message, so its receipts go under that message (#1759).
  const turns: WatcherPromptTurn[] = requests.map(request => ({ id: randomUUID(), watcher, createdAt: AT, rootUserMessageId: request.rootUserMessageId }))
  const operations: WatcherOperation[] = Array.from({ length: counts.operations }, (_, index) => {
    const request = requests[index % requests.length]!
    return { id: randomUUID(), requestId: request.id, retryKey: randomUUID(), digest: digest(index + 1), promptTurnId: turns[index % requests.length]!.id, action: index % 3 === 0 ? 'start' : 'send',
      target: request.participants[0]!.target, generation: 0, deliveryState: 'accepted', createdAt: AT, updatedAt: AT,
      receiptId: `receipt-${index}`, cardId: `card-${index}`, outcome: 'answered', outcomeAt: AT }
  })
  record.requests.push(...requests)
  record.operations.push(...operations)
  ;(record.promptTurns ??= []).push(...turns.filter((_, index) => index < counts.operations))
}

/**
 * What forge's host held besides its threads on November 10, 2026, as counts (the audit, findings 1 to 3, evidence in
 * `docs/perf/data/2026-11-10-audit/`): the laptop's Watcher's work there, 925 requests and 929 operations with 130 of the
 * host's threads taking part; the skill lists kept for threads whose skills were read, 115 KB; the delivery ledgers at
 * their limit; and follow-up receipts, 8 KB. How many skill lists and skills there were is not in the evidence: six
 * lists of forty skills make the size.
 */
export const HOST_SCALE = { pairedRequests: 925, pairedOperations: 929, pairedTargets: 130, skillCatalogs: 6, skillsPerCatalog: 40,
  deliveries: MAX_DELIVERED_DRAFTS, receipts: MAX_DELIVERED_DRAFTS, followupReceipts: 79 } as const

/**
 * A paired desktop's Watcher's work as a host holds it for that desktop: `counts` requests and operations, every request
 * closed and naming the desktop and the Watcher that made it (`remoteOrigin`), as forge's host held the laptop's. The
 * threads that took part are `targets`, round robin, as `addWatcherHistory` makes them, and `master` is the desktop's
 * Watcher; `clientId` is the desktop's pairing on the host. Nothing in it is anyone's words.
 */
export function pairedDesktopWatcherWork(targets: readonly WatcherThreadTarget[], counts: Pick<OwnerScaleCounts, 'requests' | 'operations'>,
  desktop: { readonly clientId: string; readonly master: WatcherIdentity }): { requests: WatcherRequest[]; operations: WatcherOperation[] } {
  const record = emptyWatcherRecord(), { clientId, master } = desktop
  addWatcherHistory(record, targets, counts, master.target)
  for (const request of record.requests) request.remoteOrigin = { clientId, master, creationOperationId: master.creationOperationId, ceiling: 'approval-required' }
  const roots = new Map(record.requests.map(request => [request.id, request.rootUserMessageId]))
  for (const operation of record.operations) {
    // A desktop sends an operation without its prompt turn, which stays in the desktop's own record.
    delete operation.promptTurnId
    // Each start or send as Watcher makes it: its own receipt, card, draft and message, the message it answers, and a
    // start's creation receipts and the digest of the choices it was given (`WatcherService`), then the command that sent it.
    const start = operation.action === 'start'
    Object.assign(operation, { anchorMessageId: roots.get(operation.requestId), receiptId: randomUUID(), cardId: randomUUID(), draftId: randomUUID(), messageId: randomUUID(),
      delivery: start ? 'now' : 'queue', commandId: randomUUID(), ...start ? { inputDigest: operation.digest, creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID() } : {} })
  }
  return { requests: record.requests, operations: record.operations }
}

/**
 * The delivery ledgers of `agents.json` at their limit, as a host that has sent many prompts keeps them: `deliveries`
 * accepted deliveries and as many delivered and set-aside draft revisions, round robin over `threadIds`. At forge's sizes:
 * 46 KB, 12.9 KB and 12.9 KB in a shell. Each identity is its own, as Sotto mints them, so a ledger compresses as a real
 * one does.
 */
export function hostScaleLedgers(threadIds: readonly string[], counts: Pick<typeof HOST_SCALE, 'deliveries' | 'receipts'> = HOST_SCALE):
  { deliveries: AgentDelivery[]; deliveredDrafts: { threadId: string; draftId: string }[]; obsoleteDrafts: { threadId: string; draftId: string }[] } {
  const thread = (index: number): string => threadIds[index % threadIds.length]!
  const deliveries = Array.from({ length: counts.deliveries }, (_, index): AgentDelivery => ({ threadId: thread(index), draftId: randomUUID(), createdAt: AT, status: 'accepted',
    updatedAt: AT, commandId: randomUUID(), messageId: randomUUID(), localFeedbackMs: 12 + index % 80, providerLatencyMs: 1_200 + index * 7 }))
  return {
    deliveries,
    deliveredDrafts: deliveries.slice(-counts.receipts).map(({ threadId, draftId }) => ({ threadId, draftId })),
    obsoleteDrafts: Array.from({ length: counts.receipts }, (_, index) => ({ threadId: thread(index + 1), draftId: randomUUID() })),
  }
}

/** The receipts of `followups.json`: follow-ups long delivered, round robin over `threadIds`. At forge's size: 8 KB in a shell. */
export function hostScaleFollowupReceipts(threadIds: readonly string[], count: number = HOST_SCALE.followupReceipts): { threadId: string; draftId: string }[] {
  return Array.from({ length: count }, (_, index) => ({ threadId: threadIds[index % threadIds.length]!, draftId: randomUUID() }))
}

/** Words for synthetic prose: a description made of them compresses about as English does, where one phrase repeated would not. */
const WORDS = ('use this skill when the user asks to make change check build test review read write run open show find fix keep send '
  + 'list name plan note page file folder thread project branch commit pull request issue release machine phone desktop host model '
  + 'agent prompt reply answer question picture video document drawing report table chart design prototype game scene audio before '
  + 'after each every first last only always never also then with from into about over under while until because so it its them').split(' ')

/** `length` characters of synthetic prose, the same for the same `seed` on every run. */
function prose(seed: number, length: number): string {
  let state = seed >>> 0, text = ''
  while (text.length < length) {
    // mulberry32: a small seeded generator, so the words and the size are the same every run.
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ state >>> 15, 1 | state)
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed)
    text += WORDS[((mixed ^ mixed >>> 14) >>> 0) % WORDS.length] + ' '
  }
  return text.slice(0, length)
}

/**
 * One thread's skill list as a provider answers it: `skills` skills, each with a description in prose. Each thread's
 * descriptions are its own, which makes a thread list push compress about as forge's did (60 KB on the wire for 210 KB);
 * how forge's 115 KB of lists split between skills every thread shares and skills of its own is not in the evidence.
 */
export function hostScaleSkillCatalog(threadId: string, cwd: string, skills: number = HOST_SCALE.skillsPerCatalog): AgentSkillCatalog {
  // FNV-1a of the thread's ID, so each thread's prose is its own and the same on every run.
  let seed = 0x811c9dc5
  for (const char of threadId) seed = Math.imul(seed ^ char.charCodeAt(0), 0x01000193)
  return { threadId, providerId: 'claude', cwd, status: 'ready', errors: [], skills: Array.from({ length: skills }, (_, index) => ({
    name: `synthetic-skill-${index}`, path: `/home/synthetic/.claude/skills/synthetic-skill-${index}/SKILL.md`, scope: 'user' as const, enabled: true, userInvocable: true,
    description: prose(seed + index, 300) })) }
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

/**
 * The most settled delegations on paired hosts the desktop keeps as history (#1316 part 2): the longest history its remote
 * delegation record can hold, which an outcome update must neither read nor write again.
 */
export const REMOTE_DELEGATION_HISTORY = 2_000

/** `count` long-answered delegations on `hostId` for `callerId`, as the desktop's record keeps them. Identities only. */
export function remoteDelegationHistory(hostId: string, callerId: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ id: randomUUID(), hostId, callerId, action: 'start', work: 'code-review', projectId: 'synthetic-project',
    delegation: randomUUID(), thread: `synthetic-child-${index}`, machine: 'the Mac', outcome: 'answered', told: 'answered', createdAt: AT, updatedAt: AT }))
}
