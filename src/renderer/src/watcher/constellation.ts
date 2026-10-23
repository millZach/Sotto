import type { AgentState, AgentThread } from '../../../shared/agents'
import { pullRequestKey } from '../../../shared/gitPullRequests'
import type { WatcherMergeQueueItem, WatcherThreadTarget } from '../../../shared/watcher'
import type { WatcherMergeTurn, WatcherRoomState } from '../../../shared/watcherRoom'
import { statusWord, TONES, waitKind, type OverviewEntry } from './WatcherOverview'
import { unlistedStatus } from './WatcherWatched'
import { watchedRows } from './watcherRoom'

/**
 * Watcher's picture (#1339): what it is built from, the path a message takes, and which messages move. Where each part
 * goes is `pictureGrove.ts`. Pure, so it is tested without a window. Everything comes from what the window
 * already holds, the room's state and the threads' own facts, and from the merge turns main reads only while the
 * picture shows; nothing a thread or the user said is read here.
 */

export type PictureTone = 'needs' | 'ready' | 'working' | 'landing' | 'quiet' | 'idle'
export type PictureRing = PictureTone | 'failed'
/** Where a pull request stands in the merge turns: in the queue (READY TO MERGE), given its turn (GO MERGE), or merged. */
export type MergeStep = 'ready' | 'go' | 'merged'
export type PictureChecks = 'passed' | 'failed' | 'pending' | 'unknown'

export interface PicturePullRequest {
  /** Which pull request this is: its repository and number, so two repositories' #7 stay apart; its number alone without an address. */
  readonly id: string
  readonly number: number
  readonly state: 'open' | 'closed' | 'merged'
  readonly checks: PictureChecks | undefined
  readonly step: MergeStep | null
}
export interface PictureNode {
  /** The owning host's address as one string; the same key names the thread's line, blobs and card. */
  readonly key: string
  readonly target: WatcherThreadTarget
  /** The window's own ID for the thread, or null when this window does not list it. */
  readonly threadId: string | null
  readonly title: string
  readonly tone: PictureTone
  readonly ring: PictureRing
  /** The Overview's own words for where it stands. */
  readonly word: string
  readonly settled: boolean
  /** What it waits on the user for, when it does. */
  readonly waits: 'question' | 'permission' | 'failed' | 'prototype' | null
  readonly provider: string | undefined
  readonly project: string
  readonly computer: string
  /** Its open pull request with the lowest number, or else the one it merged last: its line's chip. Null when it has none. */
  readonly pullRequest: PicturePullRequest | null
  /** Every pull request it has, open ones first by number, then the rest newest first: its card and the merge turns. */
  readonly pullRequests: readonly PicturePullRequest[]
}
export interface PictureCluster {
  readonly key: string
  readonly project: string
  readonly computer: string
  readonly nodes: readonly PictureNode[]
}
export interface PictureTurn {
  /** The node the turn belongs to. */
  readonly key: string
  readonly number: number
  readonly step: MergeStep
  readonly title: string
}
export interface PictureModel {
  readonly clusters: readonly PictureCluster[]
  /** The merge turns in the order they go: the two merged last, the turn given, then the queue. */
  readonly turns: readonly PictureTurn[]
  /** Every node, settled ones included, by key. */
  readonly nodes: ReadonlyMap<string, PictureNode>
  readonly settled: number
  /** Threads waiting on the user: a question, a permission or a failed turn. */
  readonly waiting: number
  readonly working: number
}
/** What main read for the picture: the merge queue (#1274) and the merge turns Watcher gave. */
export interface PictureMergeTurns {
  readonly queue: readonly WatcherMergeQueueItem[]
  readonly turns: readonly WatcherMergeTurn[]
}

export const targetKey = (target: WatcherThreadTarget): string => JSON.stringify([target.hostId, target.threadId])
const PULL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/u
const pullNumber = (url: string | undefined): number | undefined => {
  const found = url === undefined ? undefined : PULL_NUMBER.exec(url)?.[1]
  return found === undefined ? undefined : Number(found)
}
/** Needs you first, then what is landing or ready, then work, then the quiet and idle. */
const TONE_ORDER: Readonly<Record<PictureTone, number>> = { needs: 0, landing: 1, ready: 2, working: 3, quiet: 4, idle: 5 }
const OTHER_PROJECT = 'Other threads'
const UNLISTED = 'Not in this window'

/** A pull request's identity: its repository and number from its address, or its number alone without one. */
function pullRequestId(url: string | undefined, number: number | undefined): string | undefined {
  const keyed = url === undefined ? null : pullRequestKey(url)
  return keyed ?? (number === undefined ? undefined : `#${number}`)
}

/** A thread's linked pull requests and its branch's, each once. */
function pullRequestsOf(thread: AgentThread | undefined): readonly { readonly id: string; readonly number: number; readonly state: 'open' | 'closed' | 'merged' }[] {
  if (thread === undefined) return []
  const seen = new Set<string>()
  return [...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []]
    .map(pr => ({ id: pullRequestId(pr.url, pr.number)!, number: pr.number, state: pr.state }))
    .filter(pr => !seen.has(pr.id) && Boolean(seen.add(pr.id)))
}

/**
 * Whether each of these sends went, or is going, as Sotto's own receipt says: a merge turn whose send failed was never
 * given. Receipts are appended as Watcher acts, so the newest are read first and the search stops once all are found.
 */
function sendsThatWent(receipts: WatcherRoomState['receipts'], ids: ReadonlySet<string>): ReadonlySet<string> {
  const went = new Set<string>()
  let left = ids.size
  for (let at = receipts.length - 1; at >= 0 && left > 0; at--) {
    const receipt = receipts[at]!
    if (!ids.has(receipt.id)) continue
    left--
    if (receipt.deliveryState !== 'failed') went.add(receipt.id)
  }
  return went
}

/**
 * The picture's parts: the threads Watcher watches as nodes, in clusters by project and computer, with where each stands
 * as All threads says it, its pull request and its merge turn; and the merge turns in order. Settled threads are counted
 * and drawn only when `showSettled`.
 */
export function buildPicture(input: {
  readonly room: WatcherRoomState
  readonly state: AgentState
  /** All threads' entries by the window's thread ID. */
  readonly entries: ReadonlyMap<string, OverviewEntry>
  readonly idOf: (target: WatcherThreadTarget) => string | undefined
  readonly merge: PictureMergeTurns | null
  readonly showSettled: boolean
}): PictureModel {
  const { room, state, entries, idOf, merge } = input
  const threads = new Map(state.host.threads.map(thread => [thread.id, thread] as const))
  // The queue and the turns given, by thread: a queued pull request by its address when it has one, else by number, and a
  // turn by the number Watcher gave it.
  const queued = new Map<string, WatcherMergeQueueItem[]>()
  for (const item of merge?.queue ?? []) queued.set(targetKey(item.target), [...queued.get(targetKey(item.target)) ?? [], item])
  const given = merge?.turns ?? []
  const went = sendsThatWent(room.receipts, new Set(given.map(turn => turn.operationId)))
  const goes = new Map<string, WatcherMergeTurn>()
  for (const turn of given) if (went.has(turn.operationId)) goes.set(`${targetKey(turn.target)}#${turn.pullRequest}`, turn)
  const inQueue = (key: string, pr: { readonly id: string; readonly number: number }) => (queued.get(key) ?? []).some(item => item.pullRequest.url !== undefined
    ? pullRequestId(item.pullRequest.url, item.pullRequest.number) === pr.id : (item.pullRequest.number ?? pullNumber(item.pullRequest.url)) === pr.number)
  const nodes: PictureNode[] = []
  const mergedAt = new Map<string, number>()
  for (const row of watchedRows(room)) {
    const key = targetKey(row.target)
    const threadId = idOf(row.target) ?? null
    const thread = threadId === null ? undefined : threads.get(threadId)
    const entry = threadId === null ? undefined : entries.get(threadId)
    const group = entry?.overview.group ?? 'Idle'
    const tone = TONES[group] as PictureTone
    const failed = thread !== undefined && (thread.status === 'error' || thread.lastTurn?.status === 'failed')
    // What GitHub last reported of each of its pull requests, by identity: its checks, its state, and when Sotto first saw
    // it merged.
    const checks = new Map<string, PictureChecks>(), said = new Map<string, { number: number; state: 'open' | 'closed' | 'merged'; at: number }>()
    for (const fact of row.evidence ?? []) {
      const number = fact.source === 'github' ? pullNumber(fact.url) : undefined
      const id = number === undefined ? undefined : pullRequestId(fact.url, number)
      if (number === undefined || id === undefined) continue
      const at = Date.parse(fact.observedAt)
      if (fact.checksState !== undefined) checks.set(id, fact.checksState)
      const stateSaid = fact.fact === 'merge-observed' ? 'merged' : fact.pullRequestState
      if (stateSaid !== undefined && at >= (said.get(id)?.at ?? -Infinity)) said.set(id, { number, state: stateSaid, at })
      if (stateSaid === 'merged' && at < (mergedAt.get(`${key}#${id}`) ?? Infinity)) mergedAt.set(`${key}#${id}`, at)
    }
    // Its own links and what GitHub said: GitHub's merged or closed wins over a link that has not caught up, and a merged
    // link stays merged. A pull request only GitHub has spoken of is kept too.
    const states = new Map<string, { number: number; state: 'open' | 'closed' | 'merged' }>()
    for (const pr of pullRequestsOf(thread)) states.set(pr.id, { number: pr.number, state: pr.state })
    for (const [id, fact] of said) {
      const linked = states.get(id)?.state
      states.set(id, { number: fact.number, state: linked === 'merged' || fact.state === 'merged' ? 'merged' : linked === 'closed' || fact.state === 'closed' ? 'closed' : 'open' })
    }
    const stepOf = (pr: { readonly id: string; readonly number: number; readonly state: 'open' | 'closed' | 'merged' }): MergeStep | null =>
      pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? null : goes.has(`${key}#${pr.number}`) ? 'go' : inQueue(key, pr) ? 'ready' : null
    const pullRequests: PicturePullRequest[] = [...states].map(([id, pr]) => ({ id, number: pr.number, state: pr.state, checks: checks.get(id), step: stepOf({ id, ...pr }) }))
      .sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open') || (a.state === 'open' ? a.number - b.number : b.number - a.number))
    // A merge Sotto has no GitHub time for counts from the merge turn Watcher gave it.
    for (const pr of pullRequests) {
      const turn = goes.get(`${key}#${pr.number}`)
      if (pr.state === 'merged' && turn !== undefined && !mergedAt.has(`${key}#${pr.id}`)) mergedAt.set(`${key}#${pr.id}`, Date.parse(turn.at))
    }
    const shown = pullRequests.find(pr => pr.state === 'open') ?? pullRequests.find(pr => pr.state === 'merged')
    const remote = thread?.remoteHost === true
    nodes.push({
      key, target: row.target, threadId: thread === undefined ? null : threadId, title: thread?.title ?? row.title, tone,
      ring: failed ? 'failed' : tone,
      word: entry === undefined ? unlistedStatus(row) : statusWord(entry),
      settled: row.settled,
      waits: entry !== undefined && group === 'Needs you' ? waitKind(entry) : null,
      provider: entry?.facts.provider,
      project: thread === undefined ? UNLISTED : entry?.facts.project?.title ?? OTHER_PROJECT,
      computer: thread === undefined ? '' : remote ? thread.hostLabel ?? 'Paired computer' : 'This computer',
      pullRequest: shown ?? null, pullRequests,
    })
  }
  const byKey = new Map(nodes.map(node => [node.key, node] as const))
  const clusters = new Map<string, { project: string; computer: string; nodes: PictureNode[] }>()
  for (const node of nodes) {
    if (node.settled && !input.showSettled) continue
    const clusterKey = JSON.stringify([node.project, node.computer])
    const cluster = clusters.get(clusterKey) ?? clusters.set(clusterKey, { project: node.project, computer: node.computer, nodes: [] }).get(clusterKey)!
    cluster.nodes.push(node)
  }
  const ordered = [...clusters].map(([key, cluster]) => ({ key, ...cluster,
    nodes: cluster.nodes.sort((a, b) => Number(a.settled) - Number(b.settled) || TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.title.localeCompare(b.title)) }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.project.localeCompare(b.project) || a.computer.localeCompare(b.computer))
  // The merge turns, from every pull request of every thread: the two merged last, then the turns given, then the queue,
  // oldest pass first.
  const all = nodes.flatMap(node => node.pullRequests.map(pr => ({ node, pr, at: `${node.key}#${pr.id}`, given: `${node.key}#${pr.number}` })))
  const turnOf = ({ node, pr }: { readonly node: PictureNode; readonly pr: PicturePullRequest }, step: MergeStep): PictureTurn => ({ key: node.key, number: pr.number, step, title: node.title })
  const mergedTurns = all.filter(item => item.pr.step === 'merged' && mergedAt.has(item.at))
    .sort((a, b) => mergedAt.get(a.at)! - mergedAt.get(b.at)!).slice(-2).map(item => turnOf(item, 'merged'))
  const goTurns = all.filter(item => item.pr.step === 'go')
    .sort((a, b) => Date.parse(goes.get(a.given)!.at) - Date.parse(goes.get(b.given)!.at)).map(item => turnOf(item, 'go'))
  const readyTurns = (merge?.queue ?? []).flatMap(queuedItem => {
    const key = targetKey(queuedItem.target)
    const item = all.find(candidate => candidate.node.key === key && candidate.pr.step === 'ready' && (queuedItem.pullRequest.url !== undefined
      ? pullRequestId(queuedItem.pullRequest.url, queuedItem.pullRequest.number) === candidate.pr.id : (queuedItem.pullRequest.number ?? pullNumber(queuedItem.pullRequest.url)) === candidate.pr.number))
    return item === undefined ? [] : [turnOf(item, 'ready')]
  })
  const live = nodes.filter(node => !node.settled)
  return {
    clusters: ordered, turns: [...mergedTurns, ...goTurns, ...readyTurns], nodes: byKey,
    settled: nodes.length - live.length,
    waiting: live.filter(node => node.tone === 'needs').length,
    working: live.filter(node => node.tone === 'working' || node.tone === 'landing').length,
  }
}

// ---------- Paths ----------

/**
 * Points along a curve from `from` to `to`, for a message's path: leaving level and arriving level, or, `vertical`,
 * leaving and arriving upright.
 */
export function edgePoints(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, vertical: boolean, steps = 16): { x: number; y: number }[] {
  const [p1, p2] = vertical
    ? [{ x: from.x, y: (from.y + to.y) / 2 }, { x: to.x, y: (from.y + to.y) / 2 }]
    : [{ x: from.x + (to.x - from.x) * 0.45, y: from.y }, { x: to.x - (to.x - from.x) * 0.25, y: to.y }]
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps, u = 1 - t
    return { x: u * u * u * from.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * to.x,
      y: u * u * u * from.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * to.y }
  })
}

// ---------- Messages ----------

/**
 * What a moving blob stands for. Watcher to a thread: a start, a check-in or steer, a merge turn given (GO MERGE). A
 * thread to Watcher: a reply, news, its pull request ready to merge or merged. A thread to the user: a question or
 * permission waiting.
 */
export type BlobKind = 'start' | 'steer' | 'go' | 'reply' | 'news' | 'ready' | 'merged' | 'card'
export interface PictureMessage {
  readonly id: string
  readonly key: string
  readonly kind: BlobKind
  readonly direction: 'out' | 'in' | 'you'
  readonly pullRequest?: number | undefined
  /** The send a blob going to a thread stands for, so it can be told as a merge turn once main says it was one. */
  readonly operationId?: string | undefined
}
/** What the picture has already seen, so only what is new moves. */
export interface PictureSeen {
  readonly receipts: ReadonlyMap<string, { readonly delivery: string; readonly outcome: string | undefined }>
  readonly news: ReadonlySet<string>
  readonly steps: ReadonlyMap<string, MergeStep | null>
  /** Whether `steps` were read with main's merge turns in hand; before, a step only means none was read yet. */
  readonly stepsKnown: boolean
}
/** How many of the newest receipts are compared; older ones have long since settled. */
const RECEIPTS_COMPARED = 300
/** At most this many blobs set off at once, the newest, so a burst never floods the picture. */
export const BLOBS_AT_ONCE = 8
const NEWS_KINDS: ReadonlySet<string> = new Set(['turn-finished', 'needs-user', 'turn-failed', 'quiet', 'taken-over', 'work-settled', 'evidence-changed'])

/**
 * The messages that moved since the picture last looked: sends Sotto confirmed delivered, replies, news, a question or
 * permission now waiting, and pull requests that joined the merge queue or merged. The first look moves nothing, and
 * neither does the first look with main's merge turns in hand (`stepsKnown`), which only says where each stood. `goes`
 * are the sends Watcher marked as merge turns.
 */
export function pictureMessages(seen: PictureSeen | null, room: WatcherRoomState, model: PictureModel, goes: ReadonlyMap<string, number>, stepsKnown = true): { readonly messages: PictureMessage[]; readonly seen: PictureSeen } {
  const messages: PictureMessage[] = []
  const receipts = new Map<string, { delivery: string; outcome: string | undefined }>()
  const replied = new Set<string>()
  for (const receipt of room.receipts.slice(-RECEIPTS_COMPARED)) {
    receipts.set(receipt.id, { delivery: receipt.deliveryState, outcome: receipt.outcome })
    const before = seen?.receipts.get(receipt.id)
    if (seen === null || !model.nodes.has(targetKey(receipt.target))) continue
    const key = targetKey(receipt.target)
    if ((receipt.action === 'start' || receipt.action === 'send') && receipt.deliveryState === 'accepted' && before?.delivery !== 'accepted') {
      const go = receipt.action === 'send' && goes.has(receipt.id)
      messages.push({ id: `${receipt.id}:sent`, key, direction: 'out', kind: receipt.action === 'start' ? 'start' : go ? 'go' : 'steer', operationId: receipt.id,
        ...(go ? { pullRequest: goes.get(receipt.id) } : {}) })
    }
    if (receipt.outcome === 'answered' && before?.outcome !== 'answered') {
      replied.add(key)
      messages.push({ id: `${receipt.id}:answered`, key, direction: 'in', kind: 'reply' })
    }
  }
  // Each pull request's step, by thread and number: one joining the queue or merging moves back to Watcher.
  const steps = new Map<string, MergeStep | null>()
  const stepped = new Set<string>()
  for (const node of model.nodes.values()) for (const pr of node.pullRequests) {
    const at = `${node.key}#${pr.id}`
    steps.set(at, pr.step)
    // Once the picture has read the merge turns, a pull request it had not seen moves too, if it comes ready or merged.
    if (seen === null || !seen.stepsKnown || !stepsKnown || seen.steps.get(at) === pr.step) continue
    if (pr.step === 'ready' || pr.step === 'merged') {
      stepped.add(node.key)
      messages.push({ id: `${at}:${pr.step}`, key: node.key, direction: 'in', kind: pr.step, pullRequest: pr.number })
    }
  }
  const news = new Set<string>()
  for (const event of room.news ?? []) {
    news.add(event.id)
    const key = targetKey(event.target)
    if (seen === null || seen.news.has(event.id) || !NEWS_KINDS.has(event.kind) || !model.nodes.has(key)) continue
    if (event.kind === 'needs-user') messages.push({ id: `news:${event.id}`, key, direction: 'you', kind: 'card' })
    // A finished turn that answered a send already moved as its reply, and a pull request's news that joined the queue
    // or merged already moved as that.
    else if (!(event.kind === 'turn-finished' && replied.has(key)) && !(event.kind === 'evidence-changed' && stepped.has(key))) {
      messages.push({ id: `news:${event.id}`, key, direction: 'in', kind: 'news' })
    }
  }
  return { messages: messages.slice(-BLOBS_AT_ONCE), seen: { receipts, news, steps, stepsKnown } }
}

/** The words a blob's tag carries, when it carries one: the merge turns and a waiting card. */
export function blobTag(message: Pick<PictureMessage, 'kind' | 'pullRequest'>, waits?: PictureNode['waits']): string | null {
  const pr = message.pullRequest === undefined ? '' : ` #${message.pullRequest}`
  switch (message.kind) {
    case 'go': return `GO MERGE${pr}`
    case 'ready': return `READY${pr}`
    case 'merged': return `MERGED${pr}`
    case 'card': return waits === 'permission' ? 'Permission' : 'Question'
    default: return null
  }
}

// ---------- A thread's detail card ----------

export interface PictureActivity {
  readonly id: string
  /** What Watcher did, in Sotto's words. */
  readonly did: string
  /** How it went, from Sotto's receipt. */
  readonly went: string
  readonly at: number
  /** The message Watcher sent, when the window holds the thread's history and it is there. */
  readonly messageId: string | undefined
  readonly replyMessageId: string | undefined
}
type Receipt = WatcherRoomState['receipts'][number]
function didWords(receipt: Receipt, goes: ReadonlyMap<string, number>): string {
  switch (receipt.action) {
    case 'start': return 'Started it'
    case 'stop': return 'Stopped it'
    case 'settle': return 'Settled it'
    default: return goes.has(receipt.id) ? `Gave #${goes.get(receipt.id)} its merge turn` : receipt.delivery === 'steer' ? 'Steered its turn' : 'Sent to it'
  }
}
function wentWords(receipt: Receipt): string {
  if (receipt.deliveryState === 'failed') return 'Did not reach it'
  if (receipt.deliveryState === 'uncertain') return 'Not confirmed'
  if (receipt.deliveryState !== 'accepted') return 'Sending'
  switch (receipt.outcome) {
    case 'answered': return 'Answered'
    case 'working': return 'Working on it'
    case 'background': return 'Background work running'
    case 'failed': return 'Its turn failed'
    case 'stopped': return 'Stopped'
    case 'paused': return 'Waits for your turn there'
    case 'unknown': return 'Not confirmed'
    default: return 'Delivered'
  }
}
/** What Watcher last did with one thread, newest first, from Sotto's receipts alone. */
export function nodeActivity(room: WatcherRoomState, key: string, goes: ReadonlyMap<string, number>, limit = 5): PictureActivity[] {
  const found: PictureActivity[] = []
  for (let at = room.receipts.length - 1; at >= 0 && found.length < limit; at--) {
    const receipt = room.receipts[at]!
    if (targetKey(receipt.target) !== key) continue
    found.push({ id: receipt.id, did: didWords(receipt, goes), went: wentWords(receipt), at: Date.parse(receipt.updatedAt || receipt.createdAt),
      messageId: receipt.messageId, replyMessageId: receipt.replyMessageId })
  }
  return found
}
