import { z } from 'zod'
import { CLOUD_IPHONE_CHANNEL } from '../../shared/cloudIphone'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { CloudIphoneService } from './cloudIphone/service'

/** The renderer's view of the cloud iPhone (ADR-0047): status, setKey, sessions, answer, end, mount. Main window only. */
export function registerCloudIphoneIpc(ipc: IpcMainAdapter, service: CloudIphoneService, senders: () => readonly TrustedIpcSender[]): () => Promise<void> {
  const channels: string[] = []
  const register = (channel: string, operation: (payload: unknown) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('CLOUD_IPHONE_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      return operation(payload)
    })
    channels.push(channel)
  }
  for (const method of ['status', 'setKey', 'sessions', 'answer', 'end', 'mount'] as const) register(CLOUD_IPHONE_CHANNEL + method, payload => service[method](payload))
  // Awaited by the caller (ADR-0047: a session must finish releasing before quit proceeds), not discarded.
  return async () => {
    for (const channel of channels) ipc.removeHandler(channel)
    await service.dispose()
  }
}
