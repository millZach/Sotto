// @vitest-environment node
// #1312: a machine runs one check at a time, and the rest wait their turn in the order they were asked for.
import { describe, expect, it, vi } from 'vitest'
import { checkWaitingWords, CheckQueue } from '../../../src/main/agents/checkQueue'

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
})
