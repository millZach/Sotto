// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isWatchedRow, takesPartInActiveRequest, type WatcherRoomState } from '../../../src/shared/watcherRoom'

type Row = WatcherRoomState['watchedThreads'][number]
type Request = WatcherRoomState['requests'][number]
type Part = Row['participation'][number]

const hostId = 'host-a'
const target = { hostId, threadId: 'worker' }
const part = (patch: Partial<Part> = {}): Part => ({ requestId: 'request', target, startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1, ...patch })
const request = (state: Request['state'], participants: Part[] = [part()]): Request =>
  ({ id: 'request', watcher: { hostId, threadId: 'watcher' }, rootUserMessageId: 'ask', state, createdAt: '2026-10-14T08:00:00.000Z', closedAt: null, participants })
const row = (patch: Partial<Row> = {}): Row => ({ target, title: 'Worker', status: 'running', connected: true, settled: false, backgroundWorkCount: 0,
  waitsOn: [], participation: [part()], ...patch })

describe('what counts as watched', () => {
  it('is main’s mark whenever main gives one, standing watch or request alike', () => {
    expect(isWatchedRow(row({ watched: true, participation: [] }), [])).toBe(true)
    expect(isWatchedRow(row({ watched: true }), [request('active')])).toBe(true)
    // Main's mark wins over participation the renderer could read for itself.
    expect(isWatchedRow(row({ watched: false }), [request('active')])).toBe(false)
  })

  it('without a mark, is taking part in an active request the user has not taken over and Watcher has not stopped', () => {
    expect(isWatchedRow(row(), [request('active')])).toBe(true)
    expect(isWatchedRow(row(), [request('closed')])).toBe(false)
    expect(isWatchedRow(row(), [request('stopped')])).toBe(false)
    expect(isWatchedRow(row(), [])).toBe(false)
    expect(isWatchedRow(row({ participation: [part({ state: 'taken-over' })] }), [request('active')])).toBe(false)
    expect(isWatchedRow(row({ participation: [part({ automationStopped: true })] }), [request('active')])).toBe(false)
  })

  it('reads participation only through the requests it is given', () => {
    expect(takesPartInActiveRequest([part()], new Set(['request']))).toBe(true)
    expect(takesPartInActiveRequest([part()], new Set(['another']))).toBe(false)
    expect(takesPartInActiveRequest([], new Set(['request']))).toBe(false)
  })
})
