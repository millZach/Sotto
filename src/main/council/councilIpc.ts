import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { COUNCIL_CHANGED, COUNCIL_COMMAND, COUNCIL_ESTIMATE, COUNCIL_READ, COUNCIL_VIEWS_MAX, councilChangedSchema, councilCommandResultSchema, councilCommandSchema,
  councilEstimateRequestSchema, councilEstimateSchema, councilViewsSchema, type CouncilCommand, type CouncilCommandResult, type CouncilEstimate, type CouncilView } from '../../shared/council'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const estimateArguments = z.tuple([councilEstimateRequestSchema])
const commandArguments = z.tuple([councilCommandSchema])

/** What the window's bridge asks of the Council in main. */
export interface CouncilCalls {
  views(): CouncilView[]
  estimate(originThreadId: string): CouncilEstimate
  command(command: CouncilCommand): Promise<CouncilCommandResult>
  onChanged(listener: (councils: readonly string[]) => void): () => void
}

/**
 * The main window's bridge to the Council (ADR-0176). The Owl list's startup answer decides whether the handlers exist:
 * stable registers nothing, and no renderer can turn it on. The window names threads by their host-qualified IDs; a
 * Council starts only from a thread on this computer. Each answer is checked against its schema on the way out.
 */
export function registerCouncilIpc(ipc: IpcMainAdapter, council: CouncilCalls | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void): () => void {
  if (!council) return () => undefined
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)
  /** This computer's own thread named by a window key, or undefined for a thread on another machine. */
  const ownId = (key: string): string | undefined => { const parsed = parseHostEntityKey(key); return parsed ? parsed.hostId === localHostId() ? parsed.id : undefined : key }
  const windowed = (view: CouncilView): CouncilView => ({ ...view, origin: { ...view.origin, thread: windowId(view.origin.thread) },
    seats: view.seats.map(seat => ({ ...seat, thread: windowId(seat.thread) })),
    rounds: view.rounds.map(round => ({ ...round, rows: round.rows.map(row => ({ ...row, thread: windowId(row.thread) })) })) })
  const refuse = (): never => { throw new Error(t`Open the Council in the main Sotto window.`) }
  ipc.handle(COUNCIL_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) refuse()
    noArguments.parse(args)
    return councilViewsSchema.parse(council.views().map(windowed))
  })
  ipc.handle(COUNCIL_ESTIMATE, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) refuse()
    const [request] = estimateArguments.parse(args)
    const id = ownId(request.originThread)
    return councilEstimateSchema.parse(id ? council.estimate(id) : { unavailable: t`A Council starts from a thread on this computer.` })
  })
  ipc.handle(COUNCIL_COMMAND, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) refuse()
    const [command] = commandArguments.parse(args)
    if (command.type !== 'start') return councilCommandResultSchema.parse(await council.command(command))
    const origin = ownId(command.originThread)
    if (!origin) return councilCommandResultSchema.parse({ ok: false, message: t`A Council starts from a thread on this computer. Choose one of this computer's threads. Nothing was started.` })
    return councilCommandResultSchema.parse(await council.command({ ...command, originThread: origin }))
  })
  const unsubscribe = council.onChanged(councils => send(COUNCIL_CHANGED, councilChangedSchema.parse({ councils: councils.slice(0, COUNCIL_VIEWS_MAX) })))
  return () => {
    unsubscribe()
    ipc.removeHandler(COUNCIL_READ); ipc.removeHandler(COUNCIL_ESTIMATE); ipc.removeHandler(COUNCIL_COMMAND)
  }
}
