import { writeFile } from 'node:fs/promises'
import { z } from 'zod'

import { THEMES_EXPORT, THEMES_INSTALL, THEMES_SEARCH, themeExportRequestSchema, type ThemesResult } from '../../shared/themes/bridge'
import { parseThemeFile } from '../../shared/themes/library'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import { OpenVsxFailure, type OpenVsxClient } from './openVsx'

export interface ThemesIpcServices {
  readonly openVsx: Pick<OpenVsxClient, 'search' | 'install'>
  /** Ask where to save an exported theme; null when the user cancels. */
  readonly chooseExportPath: (defaultName: string) => Promise<string | null>
  readonly writeFile?: (path: string, contents: string) => Promise<void>
}

async function settle<T>(operation: () => Promise<T>): Promise<ThemesResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (cause) {
    if (cause instanceof OpenVsxFailure) return { ok: false, error: { code: cause.code, message: cause.message.slice(0, 2000) } }
    return { ok: false, error: { code: 'unavailable', message: 'Something went wrong. Try again.' } }
  }
}

/** Theme export and Open VSX for the main window only (ADR-0011). */
export function registerThemesIpc(ipc: IpcMainAdapter, services: ThemesIpcServices, senders: () => readonly TrustedIpcSender[]): () => void {
  const write = services.writeFile ?? ((path: string, contents: string) => writeFile(path, contents, 'utf8'))
  const channels: string[] = []
  const register = (channel: string, operation: (payload: unknown) => Promise<unknown>): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('THEMES_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      return operation(payload)
    })
    channels.push(channel)
  }
  register(THEMES_EXPORT, payload => settle(async () => {
    const request = themeExportRequestSchema.safeParse(payload)
    if (!request.success) throw new OpenVsxFailure('invalid-request', 'That theme could not be exported.')
    // Only a real theme file is ever written, whatever the renderer sends.
    try {
      parseThemeFile(JSON.parse(request.data.contents))
    } catch {
      throw new OpenVsxFailure('invalid-request', 'That theme could not be exported.')
    }
    const path = await services.chooseExportPath(request.data.fileName)
    if (path === null) return { saved: false }
    try {
      await write(path, request.data.contents)
    } catch {
      throw new OpenVsxFailure('unavailable', 'The theme file could not be written there. Choose another folder.')
    }
    return { saved: true }
  }))
  register(THEMES_SEARCH, payload => settle(() => services.openVsx.search(payload)))
  register(THEMES_INSTALL, payload => settle(() => services.openVsx.install(payload)))
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
