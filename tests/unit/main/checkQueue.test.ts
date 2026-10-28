// @vitest-environment node
// #1312: a machine runs one check at a time, and the rest wait their turn in the order they were asked for.
import { describe, expect, it, vi } from 'vitest'
import { CHECK_TURN_CEILING_MS, checkWaitingWords, CheckQueue } from '../../../src/main/agents/checkQueue'
import { CHECK_QUEUE_TITLE_MAX, CHECK_QUEUE_VIEW_MAX } from '../../../src/shared/checkQueue'

const settle = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('CheckQueue', () => {
  it('runs the first check at once and starts each next one, in the order asked, once the one ahead leaves', async () => {
    const queue = new CheckQueue('forge')
    const started: string[] = []
    const start = (id: string) => () => { started.push(id) }
    expect(queue.join('a', start('a'))).toBe('running')
    expect(queue.join('b', start('b'))).toBe('waiting')
    expect(queue.join('c', start('c'))).toBe('waiting')
    expect([queue.ahead('a'), queue.ahead('b'), queue.ahead('c')]).toEqual([0, 1, 2])
    expect(queue.running('a')).toBe(true)
    queue.leave('a')
    // The next one starts once the caller's own work is done, never inside it.
    expect(started).toEqual([])
    await settle()
    expect(started).toEqual(['b'])
    expect(queue.ids()).toEqual(['b', 'c'])
    expect(queue.ahead('c')).toBe(1)
  })

  it('takes a waiting check out without starting anything, and starts nothing twice', async () => {
    const queue = new CheckQueue('This computer')
    const b = vi.fn(), c = vi.fn()
    queue.join('a', vi.fn()); queue.join('b', b); queue.join('c', c)
    // Joining again keeps the first place.
    expect(queue.join('b', vi.fn())).toBe('waiting')
    queue.leave('b')
    await settle()
    expect(b).not.toHaveBeenCalled()
    expect(queue.ahead('b')).toBeUndefined()
    expect(queue.ahead('c')).toBe(1)
    queue.leave('a'); queue.leave('a')
    await settle()
    expect(c).toHaveBeenCalledTimes(1)
  })

  it('starts no check that left before its turn came', async () => {
    const queue = new CheckQueue('forge')
    const b = vi.fn()
    queue.join('a', vi.fn()); queue.join('b', b)
    queue.leave('a'); queue.leave('b')
    await settle()
    expect(b).not.toHaveBeenCalled()
    expect(queue.ids()).toEqual([])
  })

  it('gives the machine to the next check once the running one has held it past the ceiling, whatever its outcome reads', async () => {
    vi.useFakeTimers()
    try {
      const queue = new CheckQueue('forge')
      const b = vi.fn(), c = vi.fn()
      queue.join('a', vi.fn()); queue.join('b', b); queue.join('c', c)
      await vi.advanceTimersByTimeAsync(CHECK_TURN_CEILING_MS - 1)
      expect(b).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(b).toHaveBeenCalledTimes(1)
      expect(queue.ids()).toEqual(['b', 'c'])
      // The ceiling counts from each check's own turn, and the owner leaving later changes nothing.
      queue.leave('a')
      await vi.advanceTimersByTimeAsync(CHECK_TURN_CEILING_MS - 1)
      expect(c).not.toHaveBeenCalled()
      queue.leave('b')
      await vi.advanceTimersByTimeAsync(0)
      expect(c).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(CHECK_TURN_CEILING_MS)
      expect(queue.ids()).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('says how many checks are ahead, for the model that asked', () => {
    expect(checkWaitingWords('forge', 1)).toMatch(/^Waiting for forge's check to finish\. 1 ahead\. /u)
    expect(checkWaitingWords('This computer', 2)).toMatch(/^Waiting for This computer's checks to finish\. 2 ahead\. /u)
    expect(checkWaitingWords('forge', 1)).toContain('cancel_delegation takes it out of the queue.')
  })

  it('reads a machine named by a function each time its words are written, as a host the desktop names later is (#1312, #1316)', () => {
    let name = 'forge-box'
    const queue = new CheckQueue(() => name)
    expect(checkWaitingWords(queue.machine, 1)).toMatch(/^Waiting for forge-box's check to finish\. 1 ahead\./u)
    name = 'forge'
    expect(checkWaitingWords(queue.machine, 1)).toMatch(/^Waiting for forge's check to finish\. 1 ahead\./u)
  })

  it('shows the window whose each check is and what names it, the running one first, taken only after the queue changed (#1312, fourth part)', () => {
    const queue = new CheckQueue('forge')
    queue.join('a', vi.fn(), { whose: 'watcher', title: '  Omarchy capture check  ' })
    queue.join('b', vi.fn(), { whose: 'thread', by: 'parent', work: 'building', title: 'x'.repeat(CHECK_QUEUE_TITLE_MAX + 40) })
    const first = queue.view()
    // The same array until the queue changes, so a read that repeats copies nothing.
    expect(queue.view()).toBe(first)
    expect(first).toEqual([{ id: 'a', whose: 'watcher', title: 'Omarchy capture check' },
      { id: 'b', whose: 'thread', by: 'parent', work: 'building', title: 'x'.repeat(CHECK_QUEUE_TITLE_MAX) }])
    queue.describe('b', { thread: 'child', provider: 'codex' })
    const named = queue.view()
    expect(named).not.toBe(first)
    expect(named[1]).toEqual({ id: 'b', whose: 'thread', by: 'parent', work: 'building', title: 'x'.repeat(CHECK_QUEUE_TITLE_MAX), thread: 'child', provider: 'codex' })
    // Saying the same again changes nothing, and a check not in the queue is not added.
    queue.describe('b', { thread: 'child' }); queue.describe('gone', { thread: 'other' })
    expect(queue.view()).toBe(named)
    queue.leave('a')
    expect(queue.view().map(entry => entry.id)).toEqual(['b'])
    // A check whose owner said nothing of it keeps its place in the view.
    queue.join('c', vi.fn())
    expect(queue.view().at(-1)).toEqual({ id: 'c' })
  })

  it('tells its listeners once for every change made in one turn, and nothing after they stop', async () => {
    const queue = new CheckQueue('forge')
    const heard = vi.fn()
    const stop = queue.subscribe(heard)
    queue.join('a', vi.fn(), { whose: 'watcher', title: 'One' }); queue.join('b', vi.fn(), { whose: 'thread' }); queue.describe('b', { thread: 'child' })
    expect(heard).not.toHaveBeenCalled()
    await settle()
    expect(heard).toHaveBeenCalledTimes(1)
    queue.leave('b')
    await settle()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    queue.leave('a')
    await settle()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('lists at most CHECK_QUEUE_VIEW_MAX checks, though every one still waits its turn', () => {
    const queue = new CheckQueue('forge')
    for (let index = 0; index < CHECK_QUEUE_VIEW_MAX + 5; index++) queue.join(`c${index}`, vi.fn(), { whose: 'thread' })
    expect(queue.view()).toHaveLength(CHECK_QUEUE_VIEW_MAX)
    expect(queue.ids()).toHaveLength(CHECK_QUEUE_VIEW_MAX + 5)
  })
})
