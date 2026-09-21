import { z } from 'zod'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, subagentPageRequestSchema, subagentAssignmentsRequestSchema, type SubagentChange } from '../../shared/subagents'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { WorkspaceHost } from './workspace'

/** Observational history only; no child identity is accepted as a provider command target. */
export function registerSubagentIpc(ipc: IpcMainAdapter, host: Pick<WorkspaceHost, 'subagentPage' | 'subagentAssignments' | 'subscribeSubagents'>,
  senders: () => readonly TrustedIpcSender[], publish: (change: SubagentChange) => void): () => void {
  ipc.handle(SUBAGENTS_PAGE, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Agents in the main Sotto window.')
    const [request] = z.tuple([subagentPageRequestSchema]).parse(args)
    return host.subagentPage(request)
  })
  ipc.handle(SUBAGENTS_ASSIGNMENTS, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Agents in the main Sotto window.')
    const [request] = z.tuple([subagentAssignmentsRequestSchema]).parse(args)
    return host.subagentAssignments(request)
  })
  const unsubscribe = host.subscribeSubagents(publish)
  return () => { unsubscribe(); ipc.removeHandler(SUBAGENTS_PAGE); ipc.removeHandler(SUBAGENTS_ASSIGNMENTS) }
}
