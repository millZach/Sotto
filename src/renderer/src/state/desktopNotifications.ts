import { useEffect } from 'react'
import type { NotificationOpening, NotificationsBridge } from '../../../shared/desktopNotifications'
import { useOwlFeature } from './owlFeature'

/** The notifications bridge while the window shows notifications (ADR-0117): the Owl list turns it on and main offered it. */
export function useDesktopNotifications(): NotificationsBridge | undefined {
  const on = useOwlFeature('desktop-notifications')
  return on && typeof window !== 'undefined' ? window.sotto?.notifications : undefined
}

/**
 * Main has brought the window forward and selected the thread or a fallback. The window opens its room and explains
 * any fallback without turning a notification into an answer (ADR-0117).
 */
export function useOpenNotification(open: (opening: NotificationOpening) => void): void {
  const bridge = useDesktopNotifications()
  useEffect(() => bridge?.onOpened(open), [bridge, open])
}
