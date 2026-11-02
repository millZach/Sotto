import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDesktopNotifications, useOpenNotification } from '../../../src/renderer/src/state/desktopNotifications'
import type { NotificationOpening, NotificationsBridge } from '../../../src/shared/desktopNotifications'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'desktop-notifications' && owl.on,
}))

afterEach(() => {
  owl.on = false
  vi.unstubAllGlobals()
})

function bridge(): { bridge: NotificationsBridge; open: (opening: NotificationOpening) => void; unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn()
  let opened: (opening: NotificationOpening) => void = () => undefined
  const value: NotificationsBridge = { test: vi.fn(async () => 'shown' as const), onOpened: vi.fn((listener: (opening: NotificationOpening) => void) => { opened = listener; return unsubscribe }) }
  vi.stubGlobal('sotto', { notifications: value })
  return { bridge: value, open: opening => opened(opening), unsubscribe }
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

describe('useOpenNotification (App)', () => {
  it.each([{ page: 'threads' }, { page: 'watcher', notice: 'This notification is for Watcher.' }] satisfies NotificationOpening[])('opens the requested room and forwards its explanation: $page', opening => {
    owl.on = true
    const { open, unsubscribe, bridge: value } = bridge()
    const showRoom = vi.fn()
    const { unmount } = renderHook(() => useOpenNotification(showRoom))
    expect(value.onOpened).toHaveBeenCalledTimes(1)
    open(opening)
    expect(showRoom).toHaveBeenCalledExactlyOnceWith(opening)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not subscribe without the Owl feature', () => {
    const { bridge: value } = bridge()
    renderHook(() => useOpenNotification(vi.fn()))
    expect(value.onOpened).not.toHaveBeenCalled()
  })

  it('does nothing without a bridge', () => {
    owl.on = true
    expect(() => renderHook(() => useOpenNotification(vi.fn())).unmount()).not.toThrow()
  })
})
