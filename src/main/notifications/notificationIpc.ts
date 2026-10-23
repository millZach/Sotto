import { z } from 'zod'

import { NOTIFICATION_TEST, notificationTestResultSchema, type NotificationTestResult } from '../../shared/desktopNotifications'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/**
 * The notification bridge's handler (ADR-0112). Where notifications are off, main builds no notifier, so nothing is
 * registered and no window can ask for a test. Only the main window may ask.
 */
export function registerNotificationIpc(ipc: IpcMainAdapter, notifier: { test(): Promise<NotificationTestResult> } | null,
  senders: () => readonly TrustedIpcSender[]): () => void {
  if (notifier === null) return () => undefined
  ipc.handle(NOTIFICATION_TEST, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Settings in the main Sotto window.')
    z.tuple([]).parse(args)
    return notificationTestResultSchema.parse(await notifier.test())
  })
  return () => { ipc.removeHandler(NOTIFICATION_TEST) }
}
