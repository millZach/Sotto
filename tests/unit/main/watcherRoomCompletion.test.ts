// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createRoomCompletion } from '../../fixtures/watcherRoomCompletion'

afterEach(() => vi.useRealTimers())

it('waits for the page callback after an older page read and keeps cumulative CPU', async () => {
  const cpu = vi.fn().mockReturnValueOnce(12).mockReturnValueOnce(19)
  const page = createRoomCompletion<object>(cpu), first = {}, final = {}
  page.receive(first, 1)
  let settled = false
  const pending = page.wait(2).then(result => { settled = true; return result })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(cpu).not.toHaveBeenCalled()
  page.receive(final, 2)
  expect(await pending).toEqual({ revision: 2, room: final, cpuMs: 12 })
  expect(await page.wait(2)).toEqual({ revision: 2, room: final, cpuMs: 19 })
})

it('returns a newer naturally delivered source revision so main can compare its current source', async () => {
  const page = createRoomCompletion<object>(() => 8), final = {}
  const pending = page.wait(2)
  page.receive(final, 3)
  expect(await pending).toEqual({ revision: 3, room: final, cpuMs: 8 })
})

it('fails when the latest source room never reaches the page', async () => {
  vi.useFakeTimers()
  const cpu = vi.fn(), page = createRoomCompletion<object>(cpu)
  page.receive({}, 1)
  const result = expect(page.wait(2)).rejects.toThrow('target=2, page=1')
  await vi.advanceTimersByTimeAsync(10_000)
  await result
  expect(cpu).not.toHaveBeenCalled()
})

it('rejects a pending completion when the CPU read throws and removes the waiter', async () => {
  vi.useFakeTimers()
  const error = new Error('Generated CPU read failure'), cpu = vi.fn(() => { throw error })
  const page = createRoomCompletion<object>(cpu)
  const result = expect(page.wait(2)).rejects.toBe(error)
  expect(() => page.receive({}, 2)).not.toThrow()
  await result
  expect(vi.getTimerCount()).toBe(0)
  page.receive({}, 3)
  expect(cpu).toHaveBeenCalledTimes(1)
})
