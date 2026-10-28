import { t } from '@lingui/core/macro'
import { z } from 'zod'

import { MEMORY_COMMAND, MEMORY_GET, memoryCommandSchema, type MemorySnapshot } from '../../shared/memory'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { MemoryProfile } from './profile'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([]).or(z.tuple([z.undefined()]))
const commandArguments = z.tuple([memoryCommandSchema])

export function registerMemoryIpc(
  ipc: IpcMainAdapter,
  profile: Pick<MemoryProfile, 'snapshot' | 'command'> | undefined,
  senders: () => readonly TrustedIpcSender[],
  changed: (snapshot: MemorySnapshot) => void,
): () => void {
  ipc.handle(MEMORY_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('MEMORY_MAIN_WINDOW_REQUIRED')
    noArguments.parse(args)
    return profile?.snapshot() ?? { available: false, questionnaireCompletedAt: null, memories: [], policies: [] }
  })
  ipc.handle(MEMORY_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('MEMORY_MAIN_WINDOW_REQUIRED')
    const [command] = commandArguments.parse(args)
    if (!profile) throw new Error(t`Memory is unavailable. Restart Sotto and try again.`)
    const snapshot = profile.command(command)
    changed(snapshot)
    return snapshot
  })
  return () => { ipc.removeHandler(MEMORY_GET); ipc.removeHandler(MEMORY_COMMAND) }
}
