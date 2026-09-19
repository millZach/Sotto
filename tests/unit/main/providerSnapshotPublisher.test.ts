// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderSnapshotPublisher } from '../../../src/main/agents/providerSnapshotPublisher'

afterEach(() => vi.useRealTimers())

it('keeps a bounded window while updates continue, then publishes the latest state', () => {
  vi.useFakeTimers()
  let revision = 0
  const seen: number[] = []
  const publisher = new ProviderSnapshotPublisher(() => seen.push(revision))
  for (revision = 1; revision <= 16; revision++) {
    publisher.publish(true)
    vi.advanceTimersByTime(1)
  }
  expect(seen).toEqual([16])
  publisher.publish(true)
  vi.advanceTimersByTime(16)
  expect(seen).toEqual([16, 17])
})

it('flushes a permission or turn boundary synchronously and cancels the redundant trailing update', () => {
  vi.useFakeTimers()
  let state = 'streaming'
  const seen: string[] = []
  const publisher = new ProviderSnapshotPublisher(() => seen.push(state))
  publisher.publish(true)
  state = 'permission'
  publisher.publish()
  expect(seen).toEqual(['permission'])
  vi.runAllTimers()
  expect(seen).toEqual(['permission'])
})

it('cancels a former connection without blocking updates on its replacement', () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const publisher = new ProviderSnapshotPublisher(emit)
  publisher.publish(true)
  publisher.cancel()
  vi.runAllTimers()
  expect(emit).not.toHaveBeenCalled()
  publisher.publish(true)
  vi.advanceTimersByTime(16)
  expect(emit).toHaveBeenCalledTimes(1)
})
