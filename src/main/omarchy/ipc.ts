import { z } from 'zod'
import { OMARCHY_SETUP_COMMAND, OMARCHY_SETUP_GET, omarchySetupCommandSchema } from '../../shared/omarchySetup'
import type { SottoPlatform } from '../../shared/platform'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { OmarchySetup } from './setup'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const commandArguments = z.tuple([omarchySetupCommandSchema])

/** Only Linux's main window can inspect or change its own desktop setup. */
export function registerOmarchySetupIpc(ipc: IpcMainAdapter, platform: SottoPlatform, engine: OmarchySetup | null,
  senders: () => readonly TrustedIpcSender[], focus?: { follow(listener: () => void): () => void; notify(): void }): () => void {
  if (platform !== 'linux' || !engine) return () => undefined
  ipc.handle(OMARCHY_SETUP_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('OMARCHY_MAIN_WINDOW_REQUIRED')
    noArguments.parse(args)
    return engine.get()
  })
  ipc.handle(OMARCHY_SETUP_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('OMARCHY_MAIN_WINDOW_REQUIRED')
    const [command] = commandArguments.parse(args)
    return engine.command(command)
  })
  // The visible renderer coalesces native and DOM focus; hidden panels do no inspection.
  const unsubscribeFocus = focus?.follow(() => focus.notify())
  return () => { unsubscribeFocus?.(); ipc.removeHandler(OMARCHY_SETUP_GET); ipc.removeHandler(OMARCHY_SETUP_COMMAND) }
}
