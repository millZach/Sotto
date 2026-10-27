import { t } from '@lingui/core/macro'
import { hostEntityKey } from '../../shared/clientIdentity'
import { CHECK_QUEUES_CHANGED, CHECK_QUEUES_READ, checkQueuesViewSchema, type CheckQueueEntry, type CheckQueuesView, type MachineChecks } from '../../shared/checkQueue'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { CheckQueue } from './checkQueue'

/** The connected hosts' own check queues, by the window's keys for their threads (`DesktopHostRouter`). */
export interface RemoteCheckQueues {
  hostCheckQueues(): MachineChecks[]
  subscribeCheckQueues(listener: () => void): () => void
}

/**
 * Every machine's check queue as the window shows it (#1312, fourth part, Zach's pick C): This computer's first, then each
 * connected host's that sends its own. Registered only where This computer keeps a queue, which it does only while Work
 * across machines is on, and only with Watcher on, as the machines line is: stable registers nothing. The window reads it
 * once and main sends the whole view again whenever a queue changes, never on the update path: a queue's own view is taken
 * only after it changed.
 */
export function registerCheckQueueIpc(ipc: IpcMainAdapter, local: CheckQueue | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void, remote?: RemoteCheckQueues): () => void {
  if (!local) return () => undefined
  const view = (): CheckQueuesView => {
    const hostId = localHostId()
    // The window names this computer's threads by their host-qualified IDs too.
    const named = (check: CheckQueueEntry): CheckQueueEntry => ({ ...check, ...check.thread !== undefined ? { thread: hostEntityKey(hostId, check.thread) } : {},
      ...check.by !== undefined ? { by: hostEntityKey(hostId, check.by) } : {} })
    return checkQueuesViewSchema.parse({ machines: [{ hostId: hostId ?? 'this-computer', thisComputer: true, checks: local.view().map(named) }, ...remote?.hostCheckQueues() ?? []] })
  }
  ipc.handle(CHECK_QUEUES_READ, event => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open checks in the main Sotto window.`)
    return view()
  })
  const changed = (): void => { send(CHECK_QUEUES_CHANGED, view()) }
  const stopLocal = local.subscribe(changed)
  const stopRemote = remote?.subscribeCheckQueues(changed)
  return () => { stopLocal(); stopRemote?.(); ipc.removeHandler(CHECK_QUEUES_READ) }
}
