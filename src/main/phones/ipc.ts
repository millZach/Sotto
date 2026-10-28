import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { PHONES_COMMAND, PHONES_GET, phonesCommandSchema, type PhonesState } from '../../shared/phones'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { PhoneAccess } from './phoneAccess'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const commandArguments = z.tuple([phonesCommandSchema])

/** The Phones page's channels, answered for the main window only: a pairing code is never sent anywhere else. */
export function registerPhonesIpc(ipc: IpcMainAdapter, phones: Pick<PhoneAccess, 'get' | 'command' | 'subscribe'>, senders: () => readonly TrustedIpcSender[], publish: (state: PhonesState) => void): () => void {
  ipc.handle(PHONES_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Phones in the main Sotto window.`)
    noArguments.parse(args)
    return phones.get()
  })
  ipc.handle(PHONES_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Phones in the main Sotto window.`)
    const [command] = commandArguments.parse(args)
    return phones.command(command)
  })
  const off = phones.subscribe(publish)
  return () => { off(); ipc.removeHandler(PHONES_GET); ipc.removeHandler(PHONES_COMMAND) }
}
