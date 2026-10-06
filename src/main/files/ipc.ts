import { z } from 'zod'
import { namesHostThread } from '../../shared/clientIdentity'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, fileListRequestSchema, fileRequestSchema, type FileListing, type FileListRequest, type FilePath, type FilePreview, type FileRequest, type FilesResult } from '../../shared/files'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { FilesService } from './service'

/**
 * Files for a thread on a paired host, read on that host through the router (ADR-0025, October 5 amendment). Copy path
 * copies the host's own path to this computer's clipboard; there is no reveal, since the folder is not on this computer.
 */
export interface HostedThreadFiles {
  list(request: FileListRequest): Promise<FilesResult<FileListing>>
  preview(request: FileRequest): Promise<FilesResult<FilePreview>>
  copyPath(request: FileRequest): Promise<FilesResult<FilePath>>
}

const ON_HOST = 'This file is on the host machine, so it cannot be shown in a folder here. Nothing was opened.'
const UNAVAILABLE = 'Files cannot reach the host machine from this window. Nothing was changed. Restart Sotto and try again.'

export function registerFilesIpc(ipc: IpcMainAdapter, files: FilesService, senders: () => readonly TrustedIpcSender[], hosted?: HostedThreadFiles): () => void {
  const operations = [[FILES_LIST, 'list'], [FILES_PREVIEW, 'preview'], [FILES_COPY_PATH, 'copyPath'], [FILES_REVEAL, 'reveal']] as const
  /** A request for a thread on a paired host goes to that host, checked here as Files would check it on this computer. */
  const onHost = async (method: typeof operations[number][1], request: unknown): Promise<FilesResult<unknown>> => {
    if (method === 'reveal' || !hosted) return { ok: false, error: { code: 'unavailable', message: method === 'reveal' ? ON_HOST : UNAVAILABLE } }
    if (method === 'list') {
      const parsed = fileListRequestSchema.safeParse(request)
      return parsed.success ? hosted.list(parsed.data) : { ok: false, error: { code: 'invalid-request', message: 'Refresh the workspace and use a relative directory path.' } }
    }
    const parsed = fileRequestSchema.safeParse(request)
    return parsed.success ? hosted[method](parsed.data) : { ok: false, error: { code: 'invalid-request', message: method === 'preview' ? 'Refresh the workspace and select a file.' : 'Refresh the workspace and select a path.' } }
  }
  for (const [channel, method] of operations) {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('FILES_MAIN_WINDOW_REQUIRED')
      const [request] = z.tuple([z.unknown()]).parse(args)
      return namesHostThread(request) ? onHost(method, request) : files[method](request)
    })
  }
  return () => { for (const [channel] of operations) ipc.removeHandler(channel) }
}
