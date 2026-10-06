// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { PROVIDER_PUBLISH_WINDOW_MS, ProviderSnapshotPublisher, openedCount } from '../../../src/main/agents/providerSnapshotPublisher'

afterEach(() => vi.useRealTimers())

it('publishes the first streamed frame at once, then keeps a bounded window while updates continue', () => {
  vi.useFakeTimers()
  let revision = 0
  const seen: number[] = []
  const publisher = new ProviderSnapshotPublisher(() => seen.push(revision))
  for (revision = 1; revision <= 16; revision++) {
    publisher.publish(true)
    vi.advanceTimersByTime(1)
  }
  // The first frame went out without waiting; the fifteen behind it became one publish at the window's end.
  expect(seen).toEqual([1, 16])
  publisher.publish(true)
  expect(seen).toEqual([1, 16])
  vi.advanceTimersByTime(PROVIDER_PUBLISH_WINDOW_MS)
  expect(seen).toEqual([1, 16, 17])
  // A quiet window closes, and the next burst opens with an immediate publish again.
  vi.advanceTimersByTime(PROVIDER_PUBLISH_WINDOW_MS)
  revision = 18
  publisher.publish(true)
  expect(seen).toEqual([1, 16, 17, 18])
})

it('publishes a message’s first words at once inside a window, and still coalesces the chunks after them', () => {
  vi.useFakeTimers()
  let messages = 1
  let text = 'prompt'
  const seen: string[] = []
  const publisher = new ProviderSnapshotPublisher(() => seen.push(text), () => messages)
  // The prompt's echo opens a window.
  publisher.publish(true)
  vi.advanceTimersByTime(2)
  // The reply's first words arrive inside it, and go out without waiting for its end.
  messages = 2; text = 'Hel'
  publisher.publish(true)
  expect(seen).toEqual(['prompt', 'Hel'])
  // Later chunks of the same message are held for the window.
  text = 'Hello'; publisher.publish(true)
  text = 'Hello there'; publisher.publish(true)
  expect(seen).toEqual(['prompt', 'Hel'])
  vi.advanceTimersByTime(PROVIDER_PUBLISH_WINDOW_MS)
  expect(seen).toEqual(['prompt', 'Hel', 'Hello there'])
})

it('flushes a permission or turn boundary synchronously and cancels the redundant trailing update', () => {
  vi.useFakeTimers()
  let state = 'streaming'
  const seen: string[] = []
  const publisher = new ProviderSnapshotPublisher(() => seen.push(state))
  publisher.publish(true)
  state = 'streaming more'
  publisher.publish(true)
  state = 'permission'
  publisher.publish()
  expect(seen).toEqual(['streaming', 'permission'])
  vi.runAllTimers()
  expect(seen).toEqual(['streaming', 'permission'])
})

it('cancels a former connection without blocking updates on its replacement', () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const publisher = new ProviderSnapshotPublisher(emit)
  publisher.publish(true)
  publisher.publish(true)
  expect(emit).toHaveBeenCalledTimes(1)
  publisher.cancel()
  vi.runAllTimers()
  expect(emit).toHaveBeenCalledTimes(1)
  publisher.publish(true)
  expect(emit).toHaveBeenCalledTimes(2)
})

it('counts recorded messages and activity records, not the words in them', () => {
  const log = { recorded: () => 3 }
  expect(openedCount(log, [{ activities: [1, 2] }, {}, { activities: undefined }])).toBe(5)
})
