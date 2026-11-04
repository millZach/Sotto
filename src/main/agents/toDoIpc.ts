import { t } from '@lingui/core/macro'
import { TO_DOS_CHANGED, TO_DOS_READ, TO_DOS_REQUEST, toDoForWindow, toDosViewSchema, toDoWindowRequestSchema, type MachineToDos, type ToDoRequest, type ToDosView } from '../../shared/toDos'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { ToDoStore } from './toDos'

/** The connected hosts' own lists, by the window's keys for their threads (`DesktopHostRouter`). */
export interface RemoteToDos {
  hostToDos(): MachineToDos[]
  subscribeToDos(listener: () => void): () => void
  toDoRequest(hostId: string, request: ToDoRequest): Promise<void>
}

/**
 * Every computer's to-dos as the window shows them (ADR-0188): This computer's first, where it runs its local host, then each
 * connected host's. Stable registers nothing. The window reads it once and main sends the whole view again whenever a list
 * changes, never on the update path: a list's view is taken only after it changed.
 */
export function registerToDoIpc(ipc: IpcMainAdapter, enabled: boolean, local: ToDoStore | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void, remote?: RemoteToDos): () => void {
  if (!enabled) return () => undefined
  const ownId = (): string => localHostId() ?? 'this-computer'
  const view = (): ToDosView => {
    const hostId = localHostId()
    const own = local ? [{ hostId: ownId(), thisComputer: true, items: local.view().map(item => toDoForWindow(hostId, item)) }] : []
    return toDosViewSchema.parse({ machines: [...own, ...remote?.hostToDos() ?? []] })
  }
  const allowed = (event: Parameters<typeof isAuthorizedIpcSender>[0]): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open your to-do list in the main Sotto window.`)
  }
  ipc.handle(TO_DOS_READ, event => { allowed(event); return view() })
  ipc.handle(TO_DOS_REQUEST, async (event, input: unknown) => {
    allowed(event)
    const { hostId, request } = toDoWindowRequestSchema.parse(input)
    if (local && hostId === ownId()) await local.request(request)
    else if (remote) await remote.toDoRequest(hostId, request)
    else throw new Error(t`That computer is not connected. Your to-do is still on its list.`)
  })
  const changed = (): void => { send(TO_DOS_CHANGED, view()) }
  const stopLocal = local?.subscribe(changed)
  const stopRemote = remote?.subscribeToDos(changed)
  return () => { stopLocal?.(); stopRemote?.(); ipc.removeHandler(TO_DOS_READ); ipc.removeHandler(TO_DOS_REQUEST) }
}
