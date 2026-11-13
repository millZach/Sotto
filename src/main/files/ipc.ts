import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import { z } from 'zod'

import { namesHostThread } from '../../shared/clientIdentity'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL, FILES_REVEAL_LINK, FILES_PREVIEW_LINK, FILES_OPEN_LINK, FILES_LINKED_FILE, FILES_DOWNLOAD, FILES_DOWNLOAD_STOP, FILES_DOWNLOAD_SHOW, FILES_DOWNLOAD_OPEN,
  fileDownloadHandleSchema, fileDownloadRequestSchema, fileLinkRequestSchema, fileListRequestSchema, fileRequestSchema, linkedFileViewRequestSchema,
  type FileLinkPreview, type FileLinkRequest, type FileListing, type FileListRequest, type FilePath, type FilePreview, type FileRequest, type FilesResult, type LinkedFile, type LinkedFileRequest } from '../../shared/files'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { FileDownloads } from './downloads'
import type { FilesService } from './service'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const oneArgument = z.tuple([z.unknown()])

/**
 * Files for a thread on a paired host, read on that host through the router (ADR-0025, October 5 amendment). Copy path
 * copies the host's own path to this computer's clipboard; there is no reveal, since the folder is not on this computer.
 */
export interface HostedThreadFiles {
  list(request: FileListRequest): Promise<FilesResult<FileListing>>
  preview(request: FileRequest): Promise<FilesResult<FilePreview>>
  copyPath(request: FileRequest): Promise<FilesResult<FilePath>>
  previewLink?(request: FileLinkRequest): Promise<FilesResult<FileLinkPreview>>
  /** Where a linked file is on the host, its preview, or one part of it for a download (ADR-0120, November 12 amendment). */
  linkedFile?(request: LinkedFileRequest): Promise<FilesResult<LinkedFile>>
}
/** Downloads from paired hosts, and showing a saved one in its folder on this computer. */
export interface FilesIpcDownloads { readonly downloads: FileDownloads; reveal(path: string): void }

const ON_HOST = msg`This file is on the host machine, so it cannot be shown in a folder here. Nothing was opened.`
const UNAVAILABLE = msg`Files cannot reach the host machine from this window. Nothing was changed. Restart Sotto and try again.`

const ON_HOST_OPEN = msg`This file is on the host machine, so it cannot be opened here. Nothing was opened.`
const NOT_A_LINK = msg`This link is not a file path. Nothing was opened.`
const ALREADY_HERE = msg`This file is already on this computer. Nothing was saved.`
const OPENS_HERE = msg`This file is on this computer, so its link opens it. Nothing was read.`
const DOWNLOAD_GONE = msg`Sotto no longer knows where this download is. Look in the Downloads folder.`

const REVEAL_LINK_OFF = msg`Showing linked files is not part of this version of Sotto. Nothing was opened.`
const PREVIEW_LINK_OFF = msg`Opening Markdown files in the side panel is not part of this version of Sotto. Nothing was opened.`

/**
 * `revealLinks` is the reveal-linked-files Owl answer read at start (ADR-0120), and `previewLinks` the markdown-side-panel
 * one (its November 3 amendment); while one is off its channel refuses every request.
 */
export function registerFilesIpc(ipc: IpcMainAdapter, files: FilesService, senders: () => readonly TrustedIpcSender[], hosted?: HostedThreadFiles, revealLinks = false, previewLinks = false, saved?: FilesIpcDownloads): () => void {
  const operations = [[FILES_LIST, 'list'], [FILES_PREVIEW, 'preview'], [FILES_COPY_PATH, 'copyPath'], [FILES_REVEAL, 'reveal'], [FILES_REVEAL_LINK, 'revealLink'], [FILES_PREVIEW_LINK, 'previewLink']] as const
  /** A request for a thread on a paired host goes to that host, checked here as Files would check it on this computer. */
  const onHost = async (method: typeof operations[number][1], request: unknown): Promise<FilesResult<unknown>> => {
    if (method === 'reveal' || method === 'revealLink' || !hosted) return { ok: false, error: { code: 'unavailable', message: i18n._(method === 'reveal' || method === 'revealLink' ? ON_HOST : UNAVAILABLE) } }
    if (method === 'previewLink') {
      const parsed = fileLinkRequestSchema.safeParse(request)
      if (!parsed.success) return { ok: false, error: { code: 'invalid-request', message: t`This link is not a file path. Nothing was opened.` } }
      return hosted.previewLink ? hosted.previewLink(parsed.data) : { ok: false, error: { code: 'unavailable', message: i18n._(UNAVAILABLE) } }
    }
    if (method === 'list') {
      const parsed = fileListRequestSchema.safeParse(request)
      return parsed.success ? hosted.list(parsed.data) : { ok: false, error: { code: 'invalid-request', message: t`Refresh the workspace and use a relative directory path.` } }
    }
    const parsed = fileRequestSchema.safeParse(request)
    return parsed.success ? hosted[method](parsed.data) : { ok: false, error: { code: 'invalid-request', message: method === 'preview' ? t`Refresh the workspace and select a file.` : t`Refresh the workspace and select a path.` } }
  }
  for (const [channel, method] of operations) {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('FILES_MAIN_WINDOW_REQUIRED')
      const [request] = oneArgument.parse(args)
      if (method === 'revealLink' && !revealLinks) return { ok: false, error: { code: 'unavailable', message: i18n._(REVEAL_LINK_OFF) } }
      if (method === 'previewLink' && !previewLinks) return { ok: false, error: { code: 'unavailable', message: i18n._(PREVIEW_LINK_OFF) } }
      return namesHostThread(request) ? onHost(method, request) : files[method](request)
    })
  }
  /**
   * What a linked file adds on November 12 (ADR-0120): opening it here, finding and reading it on its host, and saving it
   * from there to Downloads. All of it is the reveal-linked-files Owl feature, refused whole while that is off.
   */
  const unavailable = (message: string): FilesResult<never> => ({ ok: false, error: { code: 'unavailable', message } })
  const invalid = (): FilesResult<never> => ({ ok: false, error: { code: 'invalid-request', message: i18n._(NOT_A_LINK) } })
  const gone = (): FilesResult<never> => ({ ok: false, error: { code: 'path-unavailable', message: i18n._(DOWNLOAD_GONE) } })
  /** Where main saved the download a handle names; the window never names a saved file by a path. */
  const savedPath = (request: unknown): string | undefined => {
    const parsed = fileDownloadHandleSchema.safeParse(request)
    return parsed.success ? saved?.downloads.savedPath(parsed.data.downloadId) : undefined
  }
  const linked: readonly (readonly [string, (request: unknown) => unknown])[] = [
    [FILES_OPEN_LINK, request => namesHostThread(request) ? unavailable(i18n._(ON_HOST_OPEN)) : files.openLink(request)],
    [FILES_LINKED_FILE, async request => {
      const parsed = linkedFileViewRequestSchema.safeParse(request)
      if (!parsed.success) return invalid()
      // Only a paired host's file is found and read this way. One on this computer opens from its link, and the window is
      // told nothing of where a path here leads.
      if (!namesHostThread(parsed.data)) return unavailable(i18n._(OPENS_HERE))
      if (!hosted?.linkedFile) return unavailable(i18n._(UNAVAILABLE))
      const answer = await hosted.linkedFile(parsed.data)
      // The window asked where a file is or for its preview, and is never handed its bytes.
      return answer.ok && answer.value.is !== parsed.data.want ? unavailable(i18n._(UNAVAILABLE)) : answer
    }],
    [FILES_DOWNLOAD, request => {
      const parsed = fileDownloadRequestSchema.safeParse(request)
      if (!parsed.success) return invalid()
      if (!namesHostThread(parsed.data)) return unavailable(i18n._(ALREADY_HERE))
      return saved ? saved.downloads.download(parsed.data) : unavailable(i18n._(UNAVAILABLE))
    }],
    [FILES_DOWNLOAD_STOP, request => {
      const parsed = fileDownloadRequestSchema.safeParse(request)
      return !parsed.success ? invalid() : saved ? saved.downloads.stop(parsed.data) : unavailable(i18n._(UNAVAILABLE))
    }],
    [FILES_DOWNLOAD_SHOW, request => {
      const path = savedPath(request)
      if (path === undefined) return gone()
      saved!.reveal(path)
      return { ok: true, value: {} }
    }],
    [FILES_DOWNLOAD_OPEN, async request => {
      const path = savedPath(request)
      if (path === undefined) return gone()
      const opened = await files.openHere(path)
      return !opened.ok && opened.error.code === 'path-unavailable' ? gone() : opened
    }],
  ]
  for (const [channel, answer] of linked) {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('FILES_MAIN_WINDOW_REQUIRED')
      const [request] = oneArgument.parse(args)
      return revealLinks ? answer(request) : unavailable(i18n._(REVEAL_LINK_OFF))
    })
  }
  return () => { for (const [channel] of [...operations, ...linked]) ipc.removeHandler(channel) }
}
