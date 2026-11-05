import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { DYNAMIC_RECORD_CLEAR, DYNAMIC_RECORD_READ, dynamicRecordReadSchema, type DynamicRecordRead } from '../../shared/dynamicRecord'
import { isAuthorizedIpcSender, type IpcInvocationEvent, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { DynamicRecord } from './dynamicRecord'

const noArguments = z.tuple([])
const NOTHING: DynamicRecordRead = { models: [] }

/**
 * Settings' read of **its record**, and Clear its record (ADR-0191 decision 9), for the main window alone. Registered only
 * while the `dynamic-threads` Owl feature is on, so stable has no such handler. Each answer waits for the saved record to
 * be read; main opens it itself where this computer runs no threads, so what was saved can still be read and cleared.
 */
export function registerDynamicRecordIpc(ipc: IpcMainAdapter, enabled: boolean, record: Pick<DynamicRecord, 'load' | 'read' | 'clear'> | undefined,
  senders: () => readonly TrustedIpcSender[]): () => void {
  if (!enabled) return () => undefined
  const allowed = (event: IpcInvocationEvent): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
  }
  ipc.handle(DYNAMIC_RECORD_READ, async (event, ...args) => {
    allowed(event); noArguments.parse(args)
    await record?.load()
    return dynamicRecordReadSchema.parse(record?.read() ?? NOTHING)
  })
  ipc.handle(DYNAMIC_RECORD_CLEAR, async (event, ...args) => {
    allowed(event); noArguments.parse(args)
    await record?.load()
    await record?.clear()
    return dynamicRecordReadSchema.parse(record?.read() ?? NOTHING)
  })
  return () => { ipc.removeHandler(DYNAMIC_RECORD_READ); ipc.removeHandler(DYNAMIC_RECORD_CLEAR) }
}
