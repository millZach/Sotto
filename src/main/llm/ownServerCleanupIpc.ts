import { t } from '@lingui/core/macro'
import {
  OWN_SERVER_CLEANUP_MEASURE, OWN_SERVER_CLEANUP_MEASURED, ownCleanupMeasuredListSchema, ownCleanupMeasureResultSchema,
} from '../../shared/ownServerCleanup'
import { isAuthorizedIpcSender, type IpcInvocationEvent, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { OwnCleanupMeasures } from './ownServerCleanup'

/**
 * The main window's bridge to Measure (ADR-0136). Whether the feature runs decides whether the handlers exist: off,
 * nothing is registered. A request that fails the schema or throws answers `failed`, and every answer is checked on the
 * way out, so nothing but what the schema allows crosses back.
 */
export function registerOwnServerCleanupIpc(
  ipc: IpcMainAdapter,
  measures: Pick<OwnCleanupMeasures, 'measure' | 'measured'> | undefined,
  senders: () => readonly TrustedIpcSender[],
): () => void {
  if (!measures) return () => undefined
  const trusted = (event: IpcInvocationEvent): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Measure your own server from the main Sotto window.`)
  }
  ipc.handle(OWN_SERVER_CLEANUP_MEASURE, async (event, ...args) => {
    trusted(event)
    let answer: unknown
    try { answer = await measures.measure(args[0]) } catch { answer = { status: 'failed' } }
    return ownCleanupMeasureResultSchema.parse(answer)
  })
  ipc.handle(OWN_SERVER_CLEANUP_MEASURED, async event => {
    trusted(event)
    return ownCleanupMeasuredListSchema.parse(await measures.measured().catch(() => []))
  })
  return () => {
    ipc.removeHandler(OWN_SERVER_CLEANUP_MEASURE)
    ipc.removeHandler(OWN_SERVER_CLEANUP_MEASURED)
  }
}
