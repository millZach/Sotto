// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { WatcherHoldState, type WatcherHoldThread } from '../../../src/main/agents/watcherHold'
import { LIMIT_RESTART_GRACE_MS } from '../../../src/shared/limitRestart'
import { WATCHER_FAILING_RETRY_MS } from '../../../src/shared/watcherHold'

/**
 * Watcher's hold (#2234): while Watcher's own provider is limited or failing, news and what is queued for Watcher wait,
 * so no wake runs a turn that fails, and the room shows one band. It ends at the reset, at the next try, or with Try now.
 */
const START = Date.parse('2026-11-05T14:41:00.000Z')
const NONE = { count: 0, pullRequests: 0 }
const watcher = (lastTurn: WatcherHoldThread['lastTurn'], patch: Partial<WatcherHoldThread> = {}): WatcherHoldThread =>
  ({ id: 'watcher', providerId: 'claude', status: lastTurn?.status === 'failed' ? 'error' : 'idle', lastTurn, activities: [], ...patch })
const running = (id: string) => watcher({ id, status: 'running' }, { status: 'running' })
const failedTurn = (id: string, error = 'Claude Code could not reach Claude’s servers.') => watcher({ id, status: 'failed' },
  { activities: [{ id: `${id}-activity`, kind: 'turn', turnId: id, status: 'failed', error } as NonNullable<WatcherHoldThread['activities']>[number]] })

describe('Watcher’s hold', () => {
  it('holds while a limit stops Watcher, until the reset and its grace', () => {
    const hold = new WatcherHoldState()
    const reset = new Date(START + 4 * 60 * 60_000).toISOString()
    hold.read(running('turn-1'), undefined, START)
    expect(hold.read(watcher({ id: 'turn-1', status: 'failed', limitStop: { resetsAt: reset } }), undefined, START)).toBe(true)
    expect(hold.holds(START)).toBe(true)
    expect(hold.until()).toBe(Date.parse(reset) + LIMIT_RESTART_GRACE_MS)
    expect(hold.shown({ count: 37, pullRequests: 6 })).toEqual({ kind: 'limited', provider: 'claude', since: new Date(START).toISOString(), resetsAt: reset,
      tries: 0, held: 37, pullRequests: 6 })
    // A limit with a reset waits for it: Try now does nothing.
    expect(hold.tryNow(START)).toBe(false)
    // At the reset and its grace the hold ends, and the band goes.
    const after = Date.parse(reset) + LIMIT_RESTART_GRACE_MS
    expect(hold.holds(after)).toBe(false)
    hold.read(watcher({ id: 'turn-1', status: 'failed', limitStop: { resetsAt: reset } }), undefined, after)
    expect(hold.shown(NONE)).toBeUndefined()
  })

  it('takes the reset from the restart Sotto scheduled, which a restart of Sotto keeps', () => {
    const hold = new WatcherHoldState()
    const at = new Date(START + 60 * 60_000).toISOString()
    // The first read after a start: the failed turn holds only because a restart is scheduled for it.
    hold.read(watcher({ id: 'turn-1', status: 'failed' }), { provider: 'claude', stoppedAt: new Date(START - 60_000).toISOString(), at }, START)
    expect(hold.shown(NONE)).toEqual(expect.objectContaining({ kind: 'limited', resetsAt: at }))
    expect(hold.holds(START)).toBe(true)
  })

  it('holds nothing for a failure Watcher already rested on when this run first read it', () => {
    const hold = new WatcherHoldState()
    hold.read(failedTurn('turn-1'), undefined, START)
    expect(hold.shown(NONE)).toBeUndefined()
    hold.read(failedTurn('turn-1'), undefined, START + 1_000)
    expect(hold.shown(NONE)).toBeUndefined()
    // History read after the start brings the failed turn: still the last run's.
    const later = new WatcherHoldState()
    later.read(watcher(undefined), undefined, START)
    later.read(failedTurn('turn-1'), undefined, START + 1_000)
    expect(later.shown(NONE)).toBeUndefined()
  })

  it('holds a failing Watcher for a few minutes, then lets what waits go as one try, and counts the tries', () => {
    const hold = new WatcherHoldState()
    hold.read(running('turn-1'), undefined, START)
    hold.read(failedTurn('turn-1', 'request to api.anthropic.com failed, reason: write EPROTO'), undefined, START)
    expect(hold.shown({ count: 12, pullRequests: 2 })).toEqual({ kind: 'failing', provider: 'claude', since: new Date(START).toISOString(),
      nextTryAt: new Date(START + WATCHER_FAILING_RETRY_MS).toISOString(), tries: 0, held: 12, pullRequests: 2,
      detail: 'request to api.anthropic.com failed, reason: write EPROTO' })
    expect(hold.holds(START + WATCHER_FAILING_RETRY_MS - 1)).toBe(true)
    expect(hold.holds(START + WATCHER_FAILING_RETRY_MS)).toBe(false)
    // The try runs, and fails again: held again from then, one try more, failing since the first.
    const tried = START + WATCHER_FAILING_RETRY_MS
    hold.read(running('turn-2'), undefined, tried)
    expect(hold.shown(NONE)).toEqual(expect.objectContaining({ kind: 'failing', tries: 0 }))
    hold.read(failedTurn('turn-2'), undefined, tried + 5_000)
    expect(hold.shown(NONE)).toEqual(expect.objectContaining({ since: new Date(START).toISOString(), lastTryAt: new Date(tried + 5_000).toISOString(), tries: 1 }))
    expect(hold.holds(tried + 5_000)).toBe(true)
    // A turn that finishes ends it.
    hold.read(running('turn-3'), undefined, tried + 60_000)
    hold.read(watcher({ id: 'turn-3', status: 'completed' }), undefined, tried + 90_000)
    expect(hold.shown(NONE)).toBeUndefined()
    expect(hold.holds(tried + 90_000)).toBe(false)
  })

  it('lets Try now send what a failing Watcher holds at once', () => {
    const hold = new WatcherHoldState()
    hold.read(running('turn-1'), undefined, START)
    hold.read(failedTurn('turn-1'), undefined, START)
    expect(hold.tryNow(START + 1_000)).toBe(true)
    expect(hold.holds(START + 1_000)).toBe(false)
    expect(hold.tryNow(START + 2_000)).toBe(false)
  })

  it('tries a limit that named no reset every few minutes, and ends when the user stops Watcher', () => {
    const hold = new WatcherHoldState()
    hold.read(running('turn-1'), undefined, START)
    hold.read(watcher({ id: 'turn-1', status: 'failed', limitStop: {} }, { providerId: 'devin' }), undefined, START)
    expect(hold.shown(NONE)).toEqual(expect.objectContaining({ kind: 'limited', provider: 'devin', nextTryAt: new Date(START + WATCHER_FAILING_RETRY_MS).toISOString() }))
    expect(hold.shown(NONE)?.resetsAt).toBeUndefined()
    hold.read(watcher({ id: 'turn-1', status: 'interrupted' }), undefined, START + 1_000)
    expect(hold.shown(NONE)).toBeUndefined()
  })

  it('follows a new Watcher rather than the one it replaced', () => {
    const hold = new WatcherHoldState()
    hold.read(running('turn-1'), undefined, START)
    hold.read(failedTurn('turn-1'), undefined, START)
    expect(hold.threadId()).toBe('watcher')
    hold.read({ ...watcher({ id: 'other-1', status: 'completed' }), id: 'new-watcher' }, undefined, START + 1_000)
    expect(hold.shown(NONE)).toBeUndefined()
    hold.read(undefined, undefined, START + 2_000)
    expect(hold.threadId()).toBeUndefined()
  })
})
