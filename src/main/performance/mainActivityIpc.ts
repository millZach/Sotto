import { t } from '@lingui/core/macro'
import { z } from 'zod'


import { MAIN_ACTIVITY_COMMAND, MAIN_ACTIVITY_READ, MAIN_ACTIVITY_THREAD_SWITCH, mainActivityCommandSchema, mainActivityStateSchema, threadSwitchTimingSchema, type ThreadSwitchTiming } from '../../shared/mainActivity'
import { isAuthorizedIpcSender, type IpcInvocationEvent, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { ProfilerTarget } from './activityRecorder'
import type { MainActivityService } from './mainActivityService'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const commandArguments = z.tuple([mainActivityCommandSchema])
const threadSwitchArguments = z.tuple([threadSwitchTimingSchema])

/**
 * The main-activity bridge's handlers. Stable built no service, so nothing is registered there and no window can start a
 * monitor or a recording. Only the main window may ask; a recording profiles the window that asked. A thread switch the
 * window timed goes to `threadSwitch`, which notes it on this computer (#2733).
 */
export function registerMainActivityIpc(ipc: IpcMainAdapter, service: MainActivityService | null, senders: () => readonly TrustedIpcSender[],
  windowProfiler: (event: IpcInvocationEvent) => ProfilerTarget | null, threadSwitch?: (timing: ThreadSwitchTiming) => void): () => void {
  if (service === null) return () => undefined
  const authorize = (event: IpcInvocationEvent): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
  }
  ipc.handle(MAIN_ACTIVITY_READ, (event, ...args) => {
    authorize(event)
    noArguments.parse(args)
    return mainActivityStateSchema.parse(service.state())
  })
  ipc.handle(MAIN_ACTIVITY_COMMAND, async (event, ...args) => {
    authorize(event)
    const [command] = commandArguments.parse(args)
    return mainActivityStateSchema.parse(await service.command(command, () => windowProfiler(event)))
  })
  ipc.handle(MAIN_ACTIVITY_THREAD_SWITCH, (event, ...args) => {
    authorize(event)
    const [timing] = threadSwitchArguments.parse(args)
    threadSwitch?.(timing)
  })
  return () => { ipc.removeHandler(MAIN_ACTIVITY_READ); ipc.removeHandler(MAIN_ACTIVITY_COMMAND); ipc.removeHandler(MAIN_ACTIVITY_THREAD_SWITCH) }
}
