import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDesktopNotifications, useOpenThreadsOnNotification } from '../../../src/renderer/src/state/desktopNotifications'
import type { NotificationsBridge } from '../../../src/shared/desktopNotifications'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'desktop-notifications' && owl.on,
}))

afterEach(() => {
  owl.on = false
  vi.unstubAllGlobals()
})

function bridge(): { bridge: NotificationsBridge; open: () => void; unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn()
  let opened: () => void = () => undefined
  const value: NotificationsBridge = { test: vi.fn(async () => 'shown' as const), onOpened: vi.fn((listener: () => void) => { opened = listener; return unsubscribe }) }
  vi.stubGlobal('sotto', { notifications: value })
  return { bridge: value, open: () => opened(), unsubscribe }
}

describe('useDesktopNotifications', () => {
  it('gives the bridge only with the Owl feature and a bridge', () => {
    expect(renderHook(() => useDesktopNotifications()).result.current).toBeUndefined()
    owl.on = true
    expect(renderHook(() => useDesktopNotifications()).result.current).toBeUndefined()
    const { bridge: value } = bridge()
    expect(renderHook(() => useDesktopNotifications()).result.current).toBe(value)
    owl.on = false
    expect(renderHook(() => useDesktopNotifications()).result.current).toBeUndefined()
  })
})

describe('useOpenThreadsOnNotification (App)', () => {
  it('shows Threads when a notification is pressed, and unsubscribes on unmount', () => {
    owl.on = true
    const { open, unsubscribe, bridge: value } = bridge()
    const showThreads = vi.fn()
    const { unmount } = renderHook(() => useOpenThreadsOnNotification(showThreads))
    expect(value.onOpened).toHaveBeenCalledTimes(1)
    open()
    expect(showThreads).toHaveBeenCalledTimes(1)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not subscribe without the Owl feature', () => {
    const { bridge: value } = bridge()
    renderHook(() => useOpenThreadsOnNotification(vi.fn()))
    expect(value.onOpened).not.toHaveBeenCalled()
  })

  it('does nothing without a bridge', () => {
    owl.on = true
    expect(() => renderHook(() => useOpenThreadsOnNotification(vi.fn())).unmount()).not.toThrow()
  })
})
