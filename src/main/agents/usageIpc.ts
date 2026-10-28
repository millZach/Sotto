import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { USAGE_READ, USAGE_REFRESH, USAGE_CLEAR, USAGE_HOSTS_MAX, usageQuerySchema, usageRefreshQuerySchema, usageClearQuerySchema, usageDashboardReadSchema, usageClearResultSchema, type UsageBridge } from '../../shared/usageDashboard'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const readArguments = z.tuple([usageQuerySchema])
const refreshArguments = z.tuple([usageRefreshQuerySchema])
const clearArguments = z.tuple([usageClearQuerySchema])
const clearResultsSchema = usageClearResultSchema.array().max(USAGE_HOSTS_MAX)

/** The Owl startup answer decides whether the handlers exist; no renderer can turn a collector on. */
export function registerUsageIpc(ipc: IpcMainAdapter, usage: UsageBridge, senders: () => readonly TrustedIpcSender[], enabled: boolean): () => void {
  if (!enabled) return () => undefined
  const authorize = (event: Parameters<typeof isAuthorizedIpcSender>[0]): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Usage in the main Sotto window.`)
  }
  ipc.handle(USAGE_READ, (event, ...args) => {
    authorize(event)
    const [query] = readArguments.parse(args)
    return usage.read(query).then(answer => usageDashboardReadSchema.parse(answer))
  })
  ipc.handle(USAGE_REFRESH, (event, ...args) => {
    authorize(event)
    const [query] = refreshArguments.parse(args)
    return usage.refresh(query).then(answer => usageDashboardReadSchema.parse(answer))
  })
  ipc.handle(USAGE_CLEAR, (event, ...args) => {
    authorize(event)
    const [query] = clearArguments.parse(args)
    return usage.clear(query).then(answer => clearResultsSchema.parse(answer))
  })
  return () => { ipc.removeHandler(USAGE_READ); ipc.removeHandler(USAGE_REFRESH); ipc.removeHandler(USAGE_CLEAR) }
}
