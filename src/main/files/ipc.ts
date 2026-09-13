import { z } from 'zod'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL } from '../../shared/files'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { FilesService } from './service'

export function registerFilesIpc(ipc: IpcMainAdapter, files: FilesService, senders: () => readonly TrustedIpcSender[]): () => void {
  const operations = [[FILES_LIST, 'list'], [FILES_PREVIEW, 'preview'], [FILES_COPY_PATH, 'copyPath'], [FILES_REVEAL, 'reveal']] as const
  for (const [channel, method] of operations) {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('FILES_MAIN_WINDOW_REQUIRED')
      const [request] = z.tuple([z.unknown()]).parse(args)
      return files[method](request)
    })
  }
  return () => { for (const [channel] of operations) ipc.removeHandler(channel) }
}
