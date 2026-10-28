import { t } from '@lingui/core/macro'
import { z } from 'zod'


import { NOTIFICATION_TEST, notificationTestResultSchema, type NotificationTestResult } from '../../shared/desktopNotifications'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])

/**
 * The notification bridge's handler (ADR-0117). Where notifications are off, main builds no notifier, so nothing is
 * registered and no window can ask for a test. Only the main window may ask.
 */
export function registerNotificationIpc(ipc: IpcMainAdapter, notifier: { test(): Promise<NotificationTestResult> } | null,
  senders: () => readonly TrustedIpcSender[]): () => void {
  if (notifier === null) return () => undefined
  ipc.handle(NOTIFICATION_TEST, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return notificationTestResultSchema.parse(await notifier.test())
  })
  return () => { ipc.removeHandler(NOTIFICATION_TEST) }
}
