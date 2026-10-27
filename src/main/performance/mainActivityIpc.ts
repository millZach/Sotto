import { t } from '@lingui/core/macro'
import { z } from 'zod'


import { MAIN_ACTIVITY_COMMAND, MAIN_ACTIVITY_READ, mainActivityCommandSchema, mainActivityStateSchema } from '../../shared/mainActivity'
import { isAuthorizedIpcSender, type IpcInvocationEvent, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { ProfilerTarget } from './activityRecorder'
import type { MainActivityService } from './mainActivityService'

/**
 * The main-activity bridge's handlers. Stable built no service, so nothing is registered there and no window can start a
 * monitor or a recording. Only the main window may ask; a recording profiles the window that asked.
 */
export function registerMainActivityIpc(ipc: IpcMainAdapter, service: MainActivityService | null, senders: () => readonly TrustedIpcSender[],
  windowProfiler: (event: IpcInvocationEvent) => ProfilerTarget | null): () => void {
  if (service === null) return () => undefined
  const authorize = (event: IpcInvocationEvent): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
  }
  ipc.handle(MAIN_ACTIVITY_READ, (event, ...args) => {
    authorize(event)
    z.tuple([]).parse(args)
    return mainActivityStateSchema.parse(service.state())
  })
  ipc.handle(MAIN_ACTIVITY_COMMAND, async (event, ...args) => {
    authorize(event)
    const [command] = z.tuple([mainActivityCommandSchema]).parse(args)
    return mainActivityStateSchema.parse(await service.command(command, () => windowProfiler(event)))
  })
  return () => { ipc.removeHandler(MAIN_ACTIVITY_READ); ipc.removeHandler(MAIN_ACTIVITY_COMMAND) }
}
