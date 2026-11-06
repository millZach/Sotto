// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentThread } from '../../../src/shared/agents'
import { ThreadSnoozes } from '../../../src/main/agents/threadSnoozes'

const thread = (id: string, extra: Partial<AgentThread> = {}): AgentThread => ({
  id, title: id, projectId: 'p', modelId: 'm', status: 'idle', messages: [], requests: [], ...extra,
})
const future = '2026-11-06T09:00:00.000Z'
const visible = (row: AgentThread): AgentThread => row
const settled = (row: AgentThread): boolean => !!row.workspaceSettledAt

afterEach(() => vi.useRealTimers())

it('publishes shared snoozes, retains them on stable, and expires them without a provider update', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T09:00:00Z'))
  const moved = vi.fn(), expired = vi.fn()
  const snoozes = new ThreadSnoozes(true, moved, expired)
  snoozes.restore({ a: future })
  expect(snoozes.publish(thread('a')).snoozedUntil).toBe(future)
  expect(snoozes.publish(thread('b')).snoozedUntil).toBeNull()
  const stable = new ThreadSnoozes(false, moved, expired)
  stable.restore(snoozes.saved())
  expect(stable.publish(thread('a')).snoozedUntil).toBeUndefined()
  vi.advanceTimersByTime(24 * 60 * 60 * 1000)
  expect(snoozes.saved()).toEqual({})
  expect(stable.saved()).toEqual({ a: future })
  expect(expired).toHaveBeenCalledTimes(1)
  snoozes.dispose(); stable.dispose()
})

it.each(['question', 'permission'] as const)('a delegated %s wakes ancestors permanently', kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T09:00:00Z'))
  const snoozes = new ThreadSnoozes(true, vi.fn(), vi.fn())
  const parent = thread('parent'), child = thread('child', { delegatedBy: 'parent', requests: [{ id: 'ask', kind, text: 'Choose', options: [] }] })
  snoozes.restore({ parent: future, child: future })
  expect(snoozes.track([child], id => id === 'parent' ? parent : child, settled, visible)).toBe(true)
  expect(snoozes.saved()).toEqual({})
  child.requests = []
  snoozes.track([child], () => parent, settled, visible)
  expect(snoozes.publish(parent).snoozedUntil).toBeNull()
  snoozes.dispose()
})

it('finishing and settling do not wake a snooze, but an unseen failure does', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T09:00:00Z'))
  const snoozes = new ThreadSnoozes(true, vi.fn(), vi.fn())
  snoozes.restore({ a: future })
  snoozes.track([thread('a'), thread('a', { workspaceSettledAt: future })], () => undefined, settled, visible)
  expect(snoozes.saved()).toEqual({ a: future })
  snoozes.track([thread('a', { status: 'error' })], () => undefined, settled, visible)
  expect(snoozes.saved()).toEqual({})
  snoozes.dispose()
})
