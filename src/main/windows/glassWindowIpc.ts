import { z } from 'zod'

import { GLASS_WINDOW_SET, glassWindowRequestSchema, glassWindowResultSchema } from '../../shared/glassWindow'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/**
 * The see-through window's one handler (ADR-0149). Stable has no Glass, so nothing is registered there and no window
 * can ask for a material. Only the main window may ask, and only for itself.
 */
export function registerGlassWindowIpc(ipc: IpcMainAdapter, setSeeThrough: ((on: boolean) => boolean) | null,
  senders: () => readonly TrustedIpcSender[]): () => void {
  if (setSeeThrough === null) return () => undefined
  ipc.handle(GLASS_WINDOW_SET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Only the main window may change its own material.')
    const [on] = z.tuple([glassWindowRequestSchema]).parse(args)
    return glassWindowResultSchema.parse(setSeeThrough(on))
  })
  return () => { ipc.removeHandler(GLASS_WINDOW_SET) }
}
