import { z } from 'zod'
import { OMARCHY_SETUP_COMMAND, OMARCHY_SETUP_GET, omarchySetupCommandSchema } from '../../shared/omarchySetup'
import type { SottoPlatform } from '../../shared/platform'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { OmarchySetup } from './setup'

/** Only Linux's main window can inspect or change its own desktop setup. */
export function registerOmarchySetupIpc(ipc: IpcMainAdapter, platform: SottoPlatform, engine: OmarchySetup | null,
  senders: () => readonly TrustedIpcSender[]): () => void {
  if (platform !== 'linux' || !engine) return () => undefined
  ipc.handle(OMARCHY_SETUP_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('OMARCHY_MAIN_WINDOW_REQUIRED')
    z.tuple([]).parse(args)
    return engine.get()
  })
  ipc.handle(OMARCHY_SETUP_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('OMARCHY_MAIN_WINDOW_REQUIRED')
    const [command] = z.tuple([omarchySetupCommandSchema]).parse(args)
    return engine.command(command)
  })
  return () => { ipc.removeHandler(OMARCHY_SETUP_GET); ipc.removeHandler(OMARCHY_SETUP_COMMAND) }
}
