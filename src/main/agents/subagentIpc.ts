import { z } from 'zod'
import { namesHostThread } from '../../shared/clientIdentity'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, subagentPageRequestSchema, subagentAssignmentsRequestSchema, type SubagentChange } from '../../shared/subagents'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { HostThreadToolReads } from './threadToolReads'
import type { WorkspaceHost } from './workspace'

const UNAVAILABLE = 'Agents cannot reach the host machine from this window. Nothing was changed. Restart Sotto and try again.'

/**
 * Observational history only; no child identity is accepted as a provider command target. A thread on a paired host is
 * read on that host through `hosted`, the router (ADR-0025, October 5 amendment); its host pushes no roster changes.
 */
export function registerSubagentIpc(ipc: IpcMainAdapter, host: Pick<WorkspaceHost, 'subagentPage' | 'subagentAssignments' | 'subscribeSubagents'>,
  senders: () => readonly TrustedIpcSender[], publish: (change: SubagentChange) => void, hosted?: Pick<HostThreadToolReads, 'subagentPage' | 'subagentAssignments'>): () => void {
  ipc.handle(SUBAGENTS_PAGE, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Agents in the main Sotto window.')
    const [request] = z.tuple([subagentPageRequestSchema]).parse(args)
    if (!namesHostThread(request)) return host.subagentPage(request)
    if (!hosted) throw new Error(UNAVAILABLE)
    return hosted.subagentPage(request)
  })
  ipc.handle(SUBAGENTS_ASSIGNMENTS, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Agents in the main Sotto window.')
    const [request] = z.tuple([subagentAssignmentsRequestSchema]).parse(args)
    if (!namesHostThread(request)) return host.subagentAssignments(request)
    if (!hosted) throw new Error(UNAVAILABLE)
    return hosted.subagentAssignments(request)
  })
  const unsubscribe = host.subscribeSubagents(publish)
  return () => { unsubscribe(); ipc.removeHandler(SUBAGENTS_PAGE); ipc.removeHandler(SUBAGENTS_ASSIGNMENTS) }
}
