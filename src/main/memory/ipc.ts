import { z } from 'zod'
import { MEMORY_COMMAND, MEMORY_GET, memoryCommandSchema, type MemorySnapshot } from '../../shared/memory'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { MemoryProfile } from './profile'

export function registerMemoryIpc(
  ipc: IpcMainAdapter,
  profile: Pick<MemoryProfile, 'snapshot' | 'command'> | undefined,
  senders: () => readonly TrustedIpcSender[],
  changed: (snapshot: MemorySnapshot) => void,
): () => void {
  ipc.handle(MEMORY_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('MEMORY_MAIN_WINDOW_REQUIRED')
    z.tuple([]).or(z.tuple([z.undefined()])).parse(args)
    return profile?.snapshot() ?? { available: false, questionnaireCompletedAt: null, memories: [], policies: [] }
  })
  ipc.handle(MEMORY_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('MEMORY_MAIN_WINDOW_REQUIRED')
    const [command] = z.tuple([memoryCommandSchema]).parse(args)
    if (!profile) throw new Error('Memory is unavailable. Restart Sotto and try again.')
    const snapshot = profile.command(command)
    changed(snapshot)
    return snapshot
  })
  return () => { ipc.removeHandler(MEMORY_GET); ipc.removeHandler(MEMORY_COMMAND) }
}
