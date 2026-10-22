import { describe, expect, it } from 'vitest'

import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { WatcherEvidence, WatcherOperation, WatcherThreadTarget } from '../../../src/shared/watcher'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'
import { watcherOverview } from '../../../src/shared/watcherOverview'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import type { OverviewEntry } from '../../../src/renderer/src/watcher/WatcherOverview'
import { blobTag, buildPicture, edgePoints, layoutPicture, nodeActivity, pictureMessages, PICTURE_TWO_SIDES_MIN, targetKey,
  type PictureMergeTurns } from '../../../src/renderer/src/watcher/constellation'
import { threadsStateFixture } from '../../fixtures/agentState'

const NOW = Date.parse('2026-10-22T18:00:00.000Z')
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const REQUEST = '2b8f3c1d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const at = (minutesAgo = 0) => new Date(NOW - minutesAgo * 60_000).toISOString()
const target = (threadId: string): WatcherThreadTarget => ({ hostId: HOST, threadId })
const pr = (number: number, state: 'open' | 'merged' | 'closed' = 'open') => ({ number, url: `https://github.com/millZach/Sotto/pull/${number}`, title: `PR ${number}`, state, draft: false, source: 'linked' as const, linkedAt: at(60) })
let ids = 0
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`

function thread(id: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, hostId: HOST, projectId: 'workshop', title: id, modelId: 'codex:gpt', providerId: 'codex', status: 'idle', requests: [], messages: [], ...patch } as AgentThread
}
function stateWith(threads: AgentThread[]): AgentState {
  const state = threadsStateFixture()
  state.host.threads = threads
  return state
}
function entriesOf(state: AgentState): Map<string, OverviewEntry> {
  const rows = new Map(describeThreads(state, NOW).map(row => [row.thread.id, row] as const))
  return new Map(watcherOverview(state, NOW).map(overview => [overview.thread.id, { overview, facts: rows.get(overview.thread.id)! }] as const))
}
function row(id: string, patch: Partial<WatcherRoomState['watchedThreads'][number]> = {}): WatcherRoomState['watchedThreads'][number] {
  return { target: target(id), title: id, watched: true, status: 'idle', connected: true, settled: false, backgroundWorkCount: 0, waitsOn: [], participation: [], ...patch }
}
function checks(id: string, number: number, checksState: WatcherEvidence['checksState'], minutesAgo = 1): WatcherEvidence {
  return { id: uuid(), source: 'github', observedAt: at(minutesAgo), target: target(id), freshness: 'fresh', availability: 'available', fact: 'checks-passed',
    url: `https://github.com/millZach/Sotto/pull/${number}`, checksState, pullRequestState: 'open' }
}
function receipt(id: string, patch: Partial<WatcherOperation> = {}): WatcherOperation {
  return { id: uuid(), requestId: REQUEST, retryKey: uuid(), digest: 'a'.repeat(64), action: 'send', target: target(id), generation: 0, delivery: 'now',
    deliveryState: 'accepted', createdAt: at(5), updatedAt: at(5), receiptId: uuid(), cardId: uuid(), ...patch }
}
function room(rows: WatcherRoomState['watchedThreads'], patch: Partial<WatcherRoomState> = {}): WatcherRoomState {
  return { current: null, currentOptions: null, history: [], requests: [], watchedThreads: rows, receipts: [], recoveryNotice: null, observedAt: at(), ...patch }
}
function picture(state: AgentState, roomState: WatcherRoomState, merge: PictureMergeTurns | null = null, showSettled = false) {
  return buildPicture({ room: roomState, state, entries: entriesOf(state), idOf: t => t.threadId, merge, showSettled })
}

describe("Watcher's picture", () => {
  it('draws the threads Watcher watches by project and computer, settled ones only when asked, each where All threads says it stands', () => {
    const state = stateWith([
      thread('room-copies', { title: 'Room copies per update', status: 'running' }),
      thread('linux-tray', { title: 'Linux tray on Omarchy', requests: [{ id: 'ask', kind: 'permission', text: 'Run npm ci in the worktree.' } as AgentThread['requests'][number]] }),
      thread('testflight', { title: 'TestFlight 0.48', remoteHost: true, hostLabel: 'studio-mac' }),
      thread('old', { title: 'Host update waits for clients' }),
      thread('not-watched', { title: 'Not watched' }),
    ])
    const roomState = room([row('room-copies'), row('linux-tray'), row('testflight'), row('old', { settled: true })])
    const model = picture(state, roomState)
    expect(model.nodes.size).toBe(4)
    expect(model.settled).toBe(1)
    expect(model.waiting).toBe(1)
    expect(model.clusters.map(cluster => [cluster.computer, cluster.nodes.map(node => node.title)])).toEqual([
      ['This computer', ['Linux tray on Omarchy', 'Room copies per update']],
      ['studio-mac', ['TestFlight 0.48']],
    ])
    const tray = model.nodes.get(targetKey(target('linux-tray')))!
    expect(tray).toMatchObject({ tone: 'needs', waits: 'permission', threadId: 'linux-tray' })
    expect(picture(state, roomState, null, true).clusters[0]!.nodes.map(node => node.title)).toContain('Host update waits for clients')
  })

  it('reads the merge turns: the queue as READY, a merge turn Watcher gave as GO, and the two merged last, in that order', () => {
    const state = stateWith([
      thread('a', { title: 'Watched tab keyboard order', pullRequests: [pr(1288, 'merged')] }),
      thread('b', { title: 'Room copies per update', pullRequests: [pr(1291)] }),
      thread('c', { title: 'Visual gate flake', pullRequests: [pr(1295)] }),
      thread('d', { title: 'Release notes', pullRequests: [pr(1299)] }),
    ])
    const go = receipt('b', { createdAt: at(2), updatedAt: at(2) })
    const roomState = room([
      row('a', { evidence: [{ ...checks('a', 1288, 'passed', 20), fact: 'merge-observed', pullRequestState: 'merged' }] }),
      row('b', { evidence: [checks('b', 1291, 'passed', 10)] }), row('c', { evidence: [checks('c', 1295, 'passed', 4)] }), row('d', { evidence: [checks('d', 1299, 'pending')] }),
    ], { receipts: [go] })
    const merge: PictureMergeTurns = {
      queue: [{ target: target('b'), title: 'b', pullRequest: { number: 1291, state: 'open', checks: 'passed' }, checksPassedAt: at(10) },
        { target: target('c'), title: 'c', pullRequest: { number: 1295, state: 'open', checks: 'passed' }, checksPassedAt: at(4) }],
      turns: [{ operationId: go.id, target: target('b'), pullRequest: 1291, at: at(2) }],
    }
    const model = picture(state, roomState, merge)
    expect(model.turns.map(turn => [turn.number, turn.step])).toEqual([[1288, 'merged'], [1291, 'go'], [1295, 'ready']])
    expect(model.nodes.get(targetKey(target('d')))!.pullRequest).toEqual({ number: 1299, state: 'open', checks: 'pending', step: null })
    // A merge turn whose send never reached the thread was never given.
    const failed = picture(state, { ...roomState, receipts: [{ ...go, deliveryState: 'failed' }] }, merge)
    expect(failed.turns.map(turn => [turn.number, turn.step])).toEqual([[1288, 'merged'], [1291, 'ready'], [1295, 'ready']])
  })

  it('moves nothing on its first look, then what Watcher sent, what came back, a card for the user and a pull request that joined the queue', () => {
    const state = stateWith([thread('a', { pullRequests: [pr(7)] }), thread('b')])
    const sent = receipt('a', { deliveryState: 'dispatching' })
    const first = room([row('a'), row('b')], { receipts: [sent] })
    const model = picture(state, first, { queue: [], turns: [] })
    const look = pictureMessages(null, first, model, new Set())
    expect(look.messages).toEqual([])
    // The send is delivered and answered, b asks the user, and a's pull request joins the merge queue.
    const next = room([row('a'), row('b')], { receipts: [{ ...sent, deliveryState: 'accepted', outcome: 'answered' }],
      news: [{ id: 'n1', kind: 'needs-user', requestId: REQUEST, target: target('b'), generation: 0, observedAt: at() },
        { id: 'n2', kind: 'turn-finished', requestId: REQUEST, target: target('a'), generation: 0, observedAt: at() }] })
    const merge: PictureMergeTurns = { queue: [{ target: target('a'), title: 'a', pullRequest: { number: 7, state: 'open', checks: 'passed' }, checksPassedAt: at() }], turns: [] }
    const after = pictureMessages(look.seen, next, picture(state, next, merge), new Set([sent.id]))
    expect(after.messages.map(message => [message.kind, message.direction, message.key === targetKey(target('a')) ? 'a' : 'b', message.pullRequest])).toEqual([
      ['go', 'out', 'a', 7], ['reply', 'in', 'a', undefined], ['ready', 'in', 'a', 7], ['card', 'you', 'b', undefined],
    ])
    // Nothing moves twice.
    expect(pictureMessages(after.seen, next, picture(state, next, merge), new Set([sent.id])).messages).toEqual([])
    // Main's first merge read only says where each stood: a pull request already queued does not move.
    const before = pictureMessages(null, first, picture(state, first), new Set(), false)
    expect(pictureMessages(before.seen, first, picture(state, first, merge), new Set()).messages).toEqual([])
    expect(blobTag({ kind: 'go', pullRequest: 7 })).toBe('GO MERGE #7')
    expect(blobTag({ kind: 'card' }, 'permission')).toBe('Permission')
    expect(blobTag({ kind: 'steer' })).toBeNull()
  })

  it('keeps every pull request of a thread in the merge turns, and takes GitHub’s merged over a link that has not caught up', () => {
    const state = stateWith([thread('a', { pullRequests: [pr(7), pr(8), pr(9)] })])
    const roomState = room([row('a', { evidence: [checks('a', 8, 'passed', 6), { ...checks('a', 9, 'passed', 3), fact: 'merge-observed', pullRequestState: 'merged' }] })])
    const merge: PictureMergeTurns = { turns: [], queue: [{ target: target('a'), title: 'a', pullRequest: { number: 8, state: 'open', checks: 'passed' }, checksPassedAt: at(6) }] }
    const model = picture(state, roomState, merge)
    const node = model.nodes.get(targetKey(target('a')))!
    // The line's chip is the lowest open one; the card and the merge turns have all three.
    expect(node.pullRequest?.number).toBe(7)
    expect(node.pullRequests.map(item => [item.number, item.state, item.step])).toEqual([[7, 'open', null], [8, 'open', 'ready'], [9, 'merged', 'merged']])
    expect(model.turns.map(turn => [turn.number, turn.step])).toEqual([[9, 'merged'], [8, 'ready']])
  })

  it('moves a pull request’s news back to Watcher, once, when it is not a step the merge turns already moved', () => {
    const state = stateWith([thread('a', { pullRequests: [pr(7)] }), thread('b', { pullRequests: [pr(9)] })])
    const empty: PictureMergeTurns = { queue: [], turns: [] }
    const first = room([row('a'), row('b')])
    const look = pictureMessages(null, first, picture(state, first, empty), new Set())
    const news = (id: string, threadId: string) => ({ id, kind: 'evidence-changed' as const, requestId: REQUEST, target: target(threadId), generation: 0, observedAt: at() })
    const next = room([row('a'), row('b')], { news: [news('n1', 'a'), news('n2', 'b')] })
    const queued: PictureMergeTurns = { turns: [], queue: [{ target: target('a'), title: 'a', pullRequest: { number: 7, state: 'open', checks: 'passed' }, checksPassedAt: at() }] }
    const after = pictureMessages(look.seen, next, picture(state, next, queued), new Set())
    expect(after.messages.map(message => [message.kind, message.key === targetKey(target('a')) ? 'a' : 'b'])).toEqual([['ready', 'a'], ['news', 'b']])
  })

  it('says what Watcher last did with a thread from its receipts, newest first', () => {
    const go = receipt('a', { updatedAt: at(1) })
    const roomState = room([row('a')], { receipts: [
      receipt('a', { action: 'start', outcome: 'answered', updatedAt: at(30) }),
      receipt('a', { delivery: 'steer', deliveryState: 'uncertain', updatedAt: at(10) }),
      receipt('b'), go,
    ] })
    expect(nodeActivity(roomState, targetKey(target('a')), new Set([go.id])).map(item => `${item.did}: ${item.went}`)).toEqual([
      'Gave it its merge turn: Delivered', 'Steered its turn: Not confirmed', 'Started it: Answered',
    ])
  })
})

describe("the picture's layout", () => {
  const clustersOf = (sizes: number[]) => sizes.map((size, index) => ({ key: `c${index}`, project: `P${index}`, computer: 'This computer',
    nodes: Array.from({ length: size }, (_, at) => ({ key: `c${index}-${at}` })) })) as unknown as Parameters<typeof layoutPicture>[0]

  it('puts Watcher in the middle with every dot facing it, the left side mirrored', () => {
    const layout = layoutPicture(clustersOf([5, 3, 2]), 1280, 600)
    expect(layout.oneColumn).toBe(false)
    expect(layout.owl.x).toBe(640)
    for (const node of layout.at.values()) {
      expect(node.mirror).toBe(node.x < layout.owl.x)
      expect(Math.abs(node.x - layout.owl.x)).toBeGreaterThan(50)
    }
  })

  it('keeps twenty threads of one project on the screen at the smallest window, one line each', () => {
    const layout = layoutPicture(clustersOf([20, 2]), 820, 330)
    expect(layout.height).toBe(330)
    const ys = [...layout.at.values()].map(node => node.y)
    expect(Math.min(...ys)).toBeGreaterThan(0)
    expect(Math.max(...ys)).toBeLessThan(330)
    // No two lines of the same cluster share a place.
    const places = [...layout.at.values()].map(node => `${Math.round(node.x)}:${Math.round(node.y)}`)
    expect(new Set(places).size).toBe(places.length)
  })

  it('stacks the clusters under Watcher when the pane is narrow, and scrolls rather than squeezing', () => {
    const layout = layoutPicture(clustersOf([6, 6, 6]), PICTURE_TWO_SIDES_MIN - 1, 300)
    expect(layout.oneColumn).toBe(true)
    expect(layout.owl.y).toBeLessThan(Math.min(...[...layout.at.values()].map(node => node.y)))
    expect(layout.height).toBeGreaterThan(300)
    const path = edgePoints(layout.owl, layout.at.get('c0-0')!, true)
    expect(path[0]).toEqual(layout.owl)
    expect(path.at(-1)).toEqual({ x: layout.at.get('c0-0')!.x, y: layout.at.get('c0-0')!.y })
  })
})
