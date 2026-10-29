import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { THREAD_MOVE_ANSWER, THREAD_MOVE_PREPARE, THREAD_MOVE_START, THREAD_MOVES_CHANGED, THREAD_MOVES_READ, threadMoveAnswerSchema, threadMovePrepareSchema, threadMovesViewSchema,
  threadMoveStartSchema, type ThreadMoveAnswer, type ThreadMovePrepare, type ThreadMovesView, type ThreadMoveStart } from '../../shared/threadMoves'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const oneArgument = z.tuple([z.unknown()])
const noArguments = z.tuple([])

/** What the window's bridge asks of moving threads in main: the preview, the moves it confirms, and the cards. */
export interface ThreadMoveCalls {
  prepare(request: unknown): ThreadMovePrepare
  move(request: unknown): Promise<ThreadMoveStart>
  view(): ThreadMovesView
  answer(request: unknown): Promise<ThreadMoveAnswer>
  subscribe(listener: (view: ThreadMovesView) => void): () => void
}

/**
 * The main window's bridge for moving threads to another machine (#1178). Main's startup answer decides whether the
 * handlers exist: only where Watcher and Work across machines are both on and main built the service, so stable registers
 * nothing and no renderer can turn it on. Each answer is checked against its schema on the way out, as every bridge's is,
 * and the cards go to the main window whenever one changes.
 */
export function registerThreadMoveIpc(ipc: IpcMainAdapter, calls: ThreadMoveCalls | undefined, senders: () => readonly TrustedIpcSender[],
  send: (channel: string, payload: unknown) => void): () => void {
  if (!calls) return () => undefined
  const trusted = (event: Parameters<typeof isAuthorizedIpcSender>[0]): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Move threads from the main Sotto window.`)
  }
  ipc.handle(THREAD_MOVE_PREPARE, (event, ...args) => {
    trusted(event)
    const [request] = oneArgument.parse(args)
    return threadMovePrepareSchema.parse(calls.prepare(request))
  })
  ipc.handle(THREAD_MOVE_START, async (event, ...args) => {
    trusted(event)
    const [request] = oneArgument.parse(args)
    return threadMoveStartSchema.parse(await calls.move(request))
  })
  ipc.handle(THREAD_MOVES_READ, (event, ...args) => {
    trusted(event)
    noArguments.parse(args)
    return threadMovesViewSchema.parse(calls.view())
  })
  ipc.handle(THREAD_MOVE_ANSWER, async (event, ...args) => {
    trusted(event)
    const [request] = oneArgument.parse(args)
    return threadMoveAnswerSchema.parse(await calls.answer(request))
  })
  const stop = calls.subscribe(view => { send(THREAD_MOVES_CHANGED, threadMovesViewSchema.parse(view)) })
  return () => {
    stop()
    for (const channel of [THREAD_MOVE_PREPARE, THREAD_MOVE_START, THREAD_MOVES_READ, THREAD_MOVE_ANSWER]) ipc.removeHandler(channel)
  }
}
