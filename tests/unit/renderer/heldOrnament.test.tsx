import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread } from '../../../src/shared/agents'
import { useHeldAction } from '../../../src/renderer/src/agents/ThreadMonitor'
import { HELD_AFTER_MS } from '../../../src/renderer/src/agents/threadActivityView'

type LiveThread = Pick<AgentThread, 'status' | 'activities' | 'messages'>
const origin = Date.parse('2026-09-21T10:00:00.000Z')
const thread = (agoMs: number, patch: Partial<AgentActivity> = {}): LiveThread => ({
  status: 'running', messages: [{ id: 'u1', role: 'user', text: 'go', createdAt: '2026-09-21T09:59:00.000Z' }],
  activities: [
    { id: 'turn', turnId: 'turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn' },
    { id: 'action', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Bash',
      command: 'npm test', startedAt: new Date(Date.now() - agoMs).toISOString(), ...patch },
  ],
})

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(origin) })
afterEach(() => { vi.useRealTimers() })

describe('the waiting ornament’s own clock', () => {
  it('says nothing until the threshold passes, then says so without another event arriving', () => {
    const live = thread(HELD_AFTER_MS - 2_000)
    const view = renderHook(({ value }: { value: LiveThread }) => useHeldAction(value, true, undefined),
      { initialProps: { value: live } })
    expect(view.result.current).toBeUndefined()
    // No new host state: only the hook's own timer may bring the ornament in.
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(view.result.current).toBeUndefined()
    act(() => { vi.advanceTimersByTime(2) })
    expect(view.result.current?.id).toBe('action')
  })

  it('answers immediately for an action that was already past the threshold when it arrived', () => {
    const view = renderHook(() => useHeldAction(thread(HELD_AFTER_MS + 1_000), true, undefined))
    expect(view.result.current?.id).toBe('action')
  })

  it('restarts the wait when a new action replaces the one being waited on', () => {
    const view = renderHook(({ value }: { value: LiveThread }) => useHeldAction(value, true, undefined),
      { initialProps: { value: thread(HELD_AFTER_MS + 1_000) } })
    expect(view.result.current?.id).toBe('action')
    view.rerender({ value: thread(0) })
    expect(view.result.current).toBeUndefined()
    act(() => { vi.advanceTimersByTime(HELD_AFTER_MS) })
    expect(view.result.current?.id).toBe('action')
  })

  it('says nothing while it is ineligible, and schedules nothing against a held clock', () => {
    const live = thread(HELD_AFTER_MS - 2_000)
    const blocked = renderHook(() => useHeldAction(live, false, undefined))
    act(() => { vi.advanceTimersByTime(HELD_AFTER_MS) })
    expect(blocked.result.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    const held = renderHook(() => useHeldAction(live, true, origin))
    expect(held.result.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(renderHook(() => useHeldAction(live, true, origin + 2_000)).result.current?.id).toBe('action')
  })

  it('drops the ornament when the action ends, and clears its timer with it', () => {
    const view = renderHook(({ value }: { value: LiveThread }) => useHeldAction(value, true, undefined),
      { initialProps: { value: thread(HELD_AFTER_MS - 5_000) } })
    expect(vi.getTimerCount()).toBe(1)
    view.rerender({ value: { status: 'idle', messages: [], activities: [] } })
    expect(view.result.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
