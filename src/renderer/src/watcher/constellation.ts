import type { AgentState, AgentThread } from '../../../shared/agents'
import type { WatcherMergeQueueItem, WatcherThreadTarget } from '../../../shared/watcher'
import type { WatcherMergeTurn, WatcherRoomState } from '../../../shared/watcherRoom'
import { statusWord, TONES, waitKind, type OverviewEntry } from './WatcherOverview'
import { unlistedStatus } from './WatcherWatched'
import { watchedRows } from './watcherRoom'

/**
 * Watcher's picture (#1339, Zach's pick on October 22, 2026: A, the constellation): what it is built from, where each
 * part goes, and which messages move. Pure, so it is tested without a window. Everything comes from what the window
 * already holds, the room's state and the threads' own facts, and from the merge turns main reads only while the
 * picture shows; nothing a thread or the user said is read here.
 */

export type PictureTone = 'needs' | 'ready' | 'working' | 'landing' | 'quiet' | 'idle'
export type PictureRing = PictureTone | 'failed'
/** Where a pull request stands in the merge turns: in the queue (READY TO MERGE), given its turn (GO MERGE), or merged. */
export type MergeStep = 'ready' | 'go' | 'merged'
export type PictureChecks = 'passed' | 'failed' | 'pending' | 'unknown'

export interface PicturePullRequest {
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
  readonly waits: 'question' | 'permission' | 'failed' | null
  readonly provider: string | undefined
  readonly project: string
  readonly computer: string
  /** Its open pull request, or else the one it merged last; null when it has none. */
  readonly pullRequest: PicturePullRequest | null
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

/** A thread's linked pull requests and its branch's, each once by number. */
function pullRequestsOf(thread: AgentThread | undefined): readonly { readonly number: number; readonly url: string; readonly state: 'open' | 'closed' | 'merged' }[] {
  if (thread === undefined) return []
  const seen = new Set<number>()
  return [...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []]
    .filter(pr => !seen.has(pr.number) && Boolean(seen.add(pr.number)))
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
  const queued = new Set((merge?.queue ?? []).map(item => `${targetKey(item.target)}#${item.pullRequest.number ?? pullNumber(item.pullRequest.url) ?? 0}`))
  const given = merge?.turns ?? []
  const went = sendsThatWent(room.receipts, new Set(given.map(turn => turn.operationId)))
  const goes = new Map<string, WatcherMergeTurn>()
  for (const turn of given) if (went.has(turn.operationId)) goes.set(`${targetKey(turn.target)}#${turn.pullRequest}`, turn)
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
    // The checks GitHub last reported for each of its pull requests, and when Sotto saw one merge.
    const checks = new Map<number, PictureChecks>()
    for (const fact of row.evidence ?? []) {
      const number = fact.source === 'github' ? pullNumber(fact.url) : undefined
      if (number === undefined) continue
      if (fact.checksState !== undefined) checks.set(number, fact.checksState)
      if (fact.pullRequestState === 'merged' || fact.fact === 'merge-observed') mergedAt.set(`${key}#${number}`, Date.parse(fact.observedAt))
    }
    const prs = pullRequestsOf(thread)
    const open = prs.filter(pr => pr.state === 'open').sort((a, b) => a.number - b.number)[0]
    const merged = prs.filter(pr => pr.state === 'merged').sort((a, b) => b.number - a.number)[0]
    const shown = open ?? merged
    const turnKey = shown === undefined ? '' : `${key}#${shown.number}`
    const step: MergeStep | null = shown === undefined ? null : shown.state === 'merged' ? 'merged' : goes.has(turnKey) ? 'go' : queued.has(turnKey) ? 'ready' : null
    if (shown?.state === 'merged' && !mergedAt.has(turnKey)) {
      const turn = goes.get(turnKey)
      if (turn !== undefined) mergedAt.set(turnKey, Date.parse(turn.at))
    }
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
      pullRequest: shown === undefined ? null : { number: shown.number, state: shown.state, checks: checks.get(shown.number), step },
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
  // The merge turns: the two merged last, then the turn given, then the queue, oldest pass first.
  const turnOf = (node: PictureNode, step: MergeStep): PictureTurn => ({ key: node.key, number: node.pullRequest!.number, step, title: node.title })
  const mergedTurns = nodes.filter(node => node.pullRequest?.step === 'merged' && mergedAt.has(`${node.key}#${node.pullRequest.number}`))
    .sort((a, b) => mergedAt.get(`${a.key}#${a.pullRequest!.number}`)! - mergedAt.get(`${b.key}#${b.pullRequest!.number}`)!).slice(-2).map(node => turnOf(node, 'merged'))
  const goTurns = nodes.filter(node => node.pullRequest?.step === 'go')
    .sort((a, b) => Date.parse(goes.get(`${a.key}#${a.pullRequest!.number}`)!.at) - Date.parse(goes.get(`${b.key}#${b.pullRequest!.number}`)!.at)).map(node => turnOf(node, 'go'))
  const readyTurns = (merge?.queue ?? []).flatMap(item => {
    const node = byKey.get(targetKey(item.target))
    const number = item.pullRequest.number ?? pullNumber(item.pullRequest.url)
    return node?.pullRequest != null && node.pullRequest.number === number && node.pullRequest.step === 'ready' ? [turnOf(node, 'ready')] : []
  })
  const live = nodes.filter(node => !node.settled)
  return {
    clusters: ordered, turns: [...mergedTurns, ...goTurns, ...readyTurns], nodes: byKey,
    settled: nodes.length - live.length,
    waiting: live.filter(node => node.tone === 'needs').length,
    working: live.filter(node => node.tone === 'working' || node.tone === 'landing').length,
  }
}

// ---------- Layout ----------

/** One line per thread (Watcher's pick for the build): this tall, and at least this wide a column. */
export const PICTURE_ROW = 26
const CLUSTER_HEAD = 26
const CLUSTER_PAD = 8
const CELL_MIN = 150
/** A node narrower than this leaves its pull request to the merge turns and its card. */
export const PICTURE_CHIP_MIN = 190
const MARGIN = 14
const CLUSTER_GAP = 14
/** Room kept under the stacked clusters for You, when Watcher is at the top. */
const YOU_BAND = 40
/** Watcher's mark, its name and You stand together in the middle column, You this far under Watcher. */
const YOU_UNDER_OWL = 74
/** Below this the picture is one column, Watcher at the top: a thread is open beside Watcher, or the window is narrow. */
export const PICTURE_TWO_SIDES_MIN = 640

export interface PlacedNode { readonly key: string; readonly x: number; readonly y: number; readonly width: number; readonly mirror: boolean }
export interface PlacedCluster { readonly key: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly mirror: boolean; readonly nodes: readonly PlacedNode[] }
export interface PictureLayout {
  readonly width: number
  readonly height: number
  readonly owl: { readonly x: number; readonly y: number }
  readonly you: { readonly x: number; readonly y: number }
  readonly oneColumn: boolean
  readonly clusters: readonly PlacedCluster[]
  /** Every placed node by key, for lines and blobs. */
  readonly at: ReadonlyMap<string, PlacedNode>
}

const clusterHeight = (count: number, columns: number) => CLUSTER_HEAD + Math.ceil(count / columns) * PICTURE_ROW + CLUSTER_PAD

/**
 * Where everything goes. Watcher sits in the middle with the clusters to either side, those on the left drawn mirrored
 * so every thread's dot faces Watcher and its line never crosses its own title. A cluster takes as many columns of
 * threads as it needs to fit the height, so fifteen or twenty threads in one project still read at the smallest window;
 * past that the picture scrolls. Narrower than PICTURE_TWO_SIDES_MIN, Watcher goes to the top and the clusters stack under it.
 */
export function layoutPicture(clusters: readonly PictureCluster[], width: number, viewHeight: number): PictureLayout {
  const at = new Map<string, PlacedNode>()
  const placeNodes = (cluster: PictureCluster, x: number, y: number, boxWidth: number, columns: number, mirror: boolean): PlacedNode[] => {
    const rows = Math.ceil(cluster.nodes.length / columns), cell = boxWidth / columns
    return cluster.nodes.map((node, index) => {
      // Column by column from the one nearest Watcher, so the threads that need the user sit closest to it.
      const near = Math.floor(index / rows), row = index % rows
      const dot = mirror ? x + boxWidth - 12 - near * cell : x + 12 + near * cell
      const placed = { key: node.key, x: dot, y: y + CLUSTER_HEAD + row * PICTURE_ROW + PICTURE_ROW / 2, width: cell - 22, mirror }
      at.set(node.key, placed)
      return placed
    })
  }
  if (width < PICTURE_TWO_SIDES_MIN) {
    const owl = { x: width / 2, y: 40 }
    const boxWidth = Math.max(120, width - MARGIN * 2), columns = Math.max(1, Math.floor(boxWidth / CELL_MIN))
    let y = 92
    const placed = clusters.map(cluster => {
      const height = clusterHeight(cluster.nodes.length, columns)
      const box = { key: cluster.key, x: MARGIN, y, width: boxWidth, height, mirror: false, nodes: placeNodes(cluster, MARGIN, y, boxWidth, columns, false) }
      y += height + CLUSTER_GAP
      return box
    })
    const height = Math.max(viewHeight, y + YOU_BAND)
    return { width, height, owl, you: { x: width / 2, y: height - 20 }, oneColumn: true, clusters: placed, at }
  }
  const gap = Math.min(96, Math.max(64, width * 0.07))
  const centre = width / 2
  const sideWidth = Math.max(CELL_MIN, centre - gap - MARGIN)
  const most = Math.max(1, Math.floor(sideWidth / CELL_MIN))
  const room = viewHeight - MARGIN * 2
  // The fewest columns that let both sides fit, the clusters shared out to keep the sides even.
  const share = (columns: number) => {
    const sides: { clusters: PictureCluster[]; height: number }[] = [{ clusters: [], height: 0 }, { clusters: [], height: 0 }]
    for (const cluster of [...clusters].sort((a, b) => b.nodes.length - a.nodes.length)) {
      const side = sides[0]!.height <= sides[1]!.height ? sides[0]! : sides[1]!
      side.height += (side.clusters.length ? CLUSTER_GAP : 0) + clusterHeight(cluster.nodes.length, columns)
      side.clusters.push(cluster)
    }
    // Each side keeps the clusters' own order, biggest first.
    for (const side of sides) side.clusters.sort((a, b) => clusters.indexOf(a) - clusters.indexOf(b))
    return sides
  }
  let columns = 1, sides = share(1)
  while (columns < most && Math.max(sides[0]!.height, sides[1]!.height) > room) sides = share(++columns)
  const tallest = Math.max(sides[0]!.height, sides[1]!.height)
  const height = Math.max(viewHeight, tallest + MARGIN * 2)
  // Watcher, its name and You as one group in the middle of the height; the clusters centre on Watcher.
  const owl = { x: centre, y: Math.max(36, height / 2 - YOU_UNDER_OWL / 2) }
  const placed: PlacedCluster[] = []
  sides.forEach((side, index) => {
    const mirror = index === 0
    const x = mirror ? MARGIN : centre + gap
    let y = Math.min(Math.max(MARGIN, height / 2 - side.height / 2), height - MARGIN - side.height)
    for (const cluster of side.clusters) {
      const clusterH = clusterHeight(cluster.nodes.length, columns)
      placed.push({ key: cluster.key, x, y, width: sideWidth, height: clusterH, mirror, nodes: placeNodes(cluster, x, y, sideWidth, columns, mirror) })
      y += clusterH + CLUSTER_GAP
    }
  })
  return { width, height, owl, you: { x: centre, y: owl.y + YOU_UNDER_OWL }, oneColumn: false, clusters: placed, at }
}

/** The line from Watcher to a thread's dot, as an SVG path and as points a blob travels through. */
export function edgePath(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, oneColumn: boolean): string {
  if (oneColumn) {
    const midY = (from.y + to.y) / 2
    return `M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`
  }
  const c1 = from.x + (to.x - from.x) * 0.45, c2 = to.x - (to.x - from.x) * 0.25
  return `M${from.x},${from.y} C${c1},${from.y} ${c2},${to.y} ${to.x},${to.y}`
}
/** Points along the same curve as `edgePath`, from `from` to `to`, for a blob's path. */
export function edgePoints(from: { readonly x: number; readonly y: number }, to: { readonly x: number; readonly y: number }, oneColumn: boolean, steps = 16): { x: number; y: number }[] {
  const [p1, p2] = oneColumn
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
const NEWS_KINDS: ReadonlySet<string> = new Set(['turn-finished', 'needs-user', 'turn-failed', 'quiet', 'taken-over', 'work-settled'])

/**
 * The messages that moved since the picture last looked: sends Sotto confirmed delivered, replies, news, a question or
 * permission now waiting, and pull requests that joined the merge queue or merged. The first look moves nothing, and
 * neither does the first look with main's merge turns in hand (`stepsKnown`), which only says where each stood. `goes`
 * are the sends Watcher marked as merge turns.
 */
export function pictureMessages(seen: PictureSeen | null, room: WatcherRoomState, model: PictureModel, goes: ReadonlySet<string>, stepsKnown = true): { readonly messages: PictureMessage[]; readonly seen: PictureSeen } {
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
        ...(go ? { pullRequest: model.nodes.get(key)?.pullRequest?.number } : {}) })
    }
    if (receipt.outcome === 'answered' && before?.outcome !== 'answered') {
      replied.add(key)
      messages.push({ id: `${receipt.id}:answered`, key, direction: 'in', kind: 'reply' })
    }
  }
  const news = new Set<string>()
  for (const event of room.news ?? []) {
    news.add(event.id)
    const key = targetKey(event.target)
    if (seen === null || seen.news.has(event.id) || !NEWS_KINDS.has(event.kind) || !model.nodes.has(key)) continue
    if (event.kind === 'needs-user') messages.push({ id: `news:${event.id}`, key, direction: 'you', kind: 'card' })
    // A finished turn that answered a send already moved as its reply.
    else if (!(event.kind === 'turn-finished' && replied.has(key))) messages.push({ id: `news:${event.id}`, key, direction: 'in', kind: 'news' })
  }
  const steps = new Map<string, MergeStep | null>()
  for (const node of model.nodes.values()) {
    const step = node.pullRequest?.step ?? null
    steps.set(node.key, step)
    if (seen === null || !seen.stepsKnown || !stepsKnown || !seen.steps.has(node.key) || seen.steps.get(node.key) === step) continue
    if (step === 'ready' || step === 'merged') messages.push({ id: `${node.key}:${step}:${node.pullRequest!.number}`, key: node.key, direction: 'in', kind: step, pullRequest: node.pullRequest!.number })
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
function didWords(receipt: Receipt, goes: ReadonlySet<string>): string {
  switch (receipt.action) {
    case 'start': return 'Started it'
    case 'stop': return 'Stopped it'
    case 'settle': return 'Settled it'
    default: return goes.has(receipt.id) ? 'Gave it its merge turn' : receipt.delivery === 'steer' ? 'Steered its turn' : 'Sent to it'
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
export function nodeActivity(room: WatcherRoomState, key: string, goes: ReadonlySet<string>, limit = 5): PictureActivity[] {
  const found: PictureActivity[] = []
  for (let at = room.receipts.length - 1; at >= 0 && found.length < limit; at--) {
    const receipt = room.receipts[at]!
    if (targetKey(receipt.target) !== key) continue
    found.push({ id: receipt.id, did: didWords(receipt, goes), went: wentWords(receipt), at: Date.parse(receipt.updatedAt || receipt.createdAt),
      messageId: receipt.messageId, replyMessageId: receipt.replyMessageId })
  }
  return found
}
