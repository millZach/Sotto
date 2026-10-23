import { useEffect } from 'react'
import type { NotificationsBridge } from '../../../shared/desktopNotifications'
import { useOwlFeature } from './owlFeature'

/** The notifications bridge while the window shows notifications (ADR-0112): the Owl list turns it on and main offered it. */
export function useDesktopNotifications(): NotificationsBridge | undefined {
  const on = useOwlFeature('desktop-notifications')
  return on && typeof window !== 'undefined' ? window.sotto?.notifications : undefined
}

/**
 * A pressed notification shows Threads. Main has already brought the window forward and selected the thread, so the
 * window only changes page.
 */
export function useOpenThreadsOnNotification(showThreads: () => void): void {
  const bridge = useDesktopNotifications()
  useEffect(() => bridge?.onOpened(showThreads), [bridge, showThreads])
}
