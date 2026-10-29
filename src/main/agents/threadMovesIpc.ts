import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { THREAD_MOVE_PREPARE, THREAD_MOVE_START, threadMovePrepareSchema, threadMoveStartSchema, type ThreadMovePrepare, type ThreadMoveStart } from '../../shared/threadMoves'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const oneArgument = z.tuple([z.unknown()])

/** What the window's bridge asks of moving threads in main: the preview, and the moves it confirms. */
export interface ThreadMoveCalls {
  prepare(request: unknown): ThreadMovePrepare
  move(request: unknown): Promise<ThreadMoveStart>
}

/**
 * The main window's bridge for moving threads to another machine (#1178). Main's startup answer decides whether the
 * handlers exist: only where Watcher and Work across machines are both on and main built the service, so stable registers
 * nothing and no renderer can turn it on. Each answer is checked against its schema on the way out, as every bridge's is.
 */
export function registerThreadMoveIpc(ipc: IpcMainAdapter, calls: ThreadMoveCalls | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!calls) return () => undefined
  ipc.handle(THREAD_MOVE_PREPARE, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Move threads from the main Sotto window.`)
    const [request] = oneArgument.parse(args)
    return threadMovePrepareSchema.parse(calls.prepare(request))
  })
  ipc.handle(THREAD_MOVE_START, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Move threads from the main Sotto window.`)
    const [request] = oneArgument.parse(args)
    return threadMoveStartSchema.parse(await calls.move(request))
  })
  return () => { ipc.removeHandler(THREAD_MOVE_PREPARE); ipc.removeHandler(THREAD_MOVE_START) }
}
