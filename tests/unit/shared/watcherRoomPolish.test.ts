import { describe, expect, it } from 'vitest'
import { stopAllRunning, watcherTakeovers, type WatcherRoomState } from '../../../src/shared/watcherRoom'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-16T10:00:00.000Z'
const watcher = { hostId: HOST, threadId: 'watcher' }
const target = (threadId: string) => ({ hostId: HOST, threadId })
const REQUEST = '22222222-2222-4222-8222-222222222222'
const STANDING = '33333333-3333-4333-8333-333333333333'
type Participant = WatcherRoomState['requests'][number]['participants'][number]
const part = (threadId: string, patch: Partial<Participant> = {}, requestId = REQUEST): Participant =>
  ({ requestId, startedBy: 'watcher', generation: 0, state: 'participating', target: target(threadId), promptCount: 1, ...patch })
const request = (participants: Participant[], patch: Partial<WatcherRoomState['requests'][number]> = {}): WatcherRoomState['requests'][number] =>
  ({ id: REQUEST, watcher, rootUserMessageId: 'u1', state: 'active', createdAt: AT, closedAt: null, participants, ...patch })
const current = { target: watcher, projectId: 'project', provider: 'codex' as const, creationOperationId: '44444444-4444-4444-8444-444444444444', createdAt: AT }
const row = (threadId: string, status: 'idle' | 'running' | 'error' | 'unavailable', backgroundWorkCount = 0): WatcherRoomState['watchedThreads'][number] =>
  ({ target: target(threadId), title: threadId, status, connected: true, settled: false, backgroundWorkCount, waitsOn: [], participation: [] })

describe('takeover lines', () => {
  it('say each thread the user took over by sending there, once per send, oldest first', () => {
    const sent = { reason: 'user-send' as const, at: '2026-10-16T10:05:00.000Z' }
    const lines = watcherTakeovers({ current, requests: [
      request([part('auth', { state: 'taken-over', takeover: sent }), part('native', { state: 'taken-over', takeover: { reason: 'native-user-send', at: '2026-10-16T10:01:00.000Z' } }),
        part('stopped', { state: 'taken-over', takeover: { reason: 'user-stop', at: AT } }), part('driving')]),
      // The same send ended a second request's work on Auth refactor: still one line.
      request([part('auth', { state: 'taken-over', takeover: sent }, '55555555-5555-4555-8555-555555555555')], { id: '55555555-5555-4555-8555-555555555555', rootUserMessageId: 'u2' }),
    ] })
    expect(lines).toEqual([{ target: target('native'), at: '2026-10-16T10:01:00.000Z' }, { target: target('auth'), at: sent.at }])
  })

  it('leave out a paused standing watch and another Watcher’s requests', () => {
    const sent = { reason: 'user-send' as const, at: AT }
    expect(watcherTakeovers({ current, requests: [
      request([part('watched', { state: 'taken-over', takeover: sent }, STANDING)], { id: STANDING, standingWatchId: '66666666-6666-4666-8666-666666666666' }),
      request([part('older', { state: 'taken-over', takeover: sent })], { watcher: { hostId: HOST, threadId: 'older-watcher' } }),
    ] })).toEqual([])
    expect(watcherTakeovers({ current: null, requests: [request([part('auth', { state: 'taken-over', takeover: sent })])] })).toEqual([])
  })
})

describe('Stop all', () => {
  it('is offered only while a thread Watcher started, still Watcher’s, runs for an active request', () => {
    const rows = [row('running', 'running'), row('background', 'idle', 2), row('idle', 'idle'), row('yours', 'running'), row('taken', 'running'), row('closed', 'running')]
    const requests = [request([part('running'), part('background'), part('idle'), part('yours', { startedBy: 'user' }),
      part('taken', { state: 'taken-over', takeover: { reason: 'user-send', at: AT } })]),
    request([part('closed', {}, '77777777-7777-4777-8777-777777777777')], { id: '77777777-7777-4777-8777-777777777777', state: 'stopped', closedAt: AT })]
    expect(stopAllRunning({ requests, watchedThreads: rows }).map(item => item.threadId)).toEqual(['running', 'background'])
    expect(stopAllRunning({ requests, watchedThreads: rows.map(item => ({ ...item, status: 'idle', backgroundWorkCount: 0 })) })).toEqual([])
  })
})
