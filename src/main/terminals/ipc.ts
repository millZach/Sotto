import { z } from 'zod'
import { TERMINALS_CHANNEL } from '../../shared/terminalWorkspace'
import { isAuthorizedIpcSender, type IpcMainAdapter, type IpcWebContentsLike, type TrustedIpcSender } from '../ipc/registerIpc'
import type { TerminalWorkspaceService } from './service'

export const TERMINAL_WORKSPACE_METHODS = ['list', 'open', 'read', 'write', 'resize', 'interrupt', 'stop', 'restart', 'close', 'pasteImage', 'visibility'] as const

export interface TerminalVisibilityWindow {
  isVisible(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
  on(event: 'show' | 'hide' | 'minimize' | 'restore' | 'closed', listener: () => void): void
  removeListener(event: 'show' | 'hide' | 'minimize' | 'restore' | 'closed', listener: () => void): void
  webContents?: {
    on(event: 'did-start-loading' | 'render-process-gone' | 'destroyed', listener: () => void): void
    removeListener(event: 'did-start-loading' | 'render-process-gone' | 'destroyed', listener: () => void): void
  }
}

/** Terminal mode's IPC: main window only, one payload per call, the service validating everything else. */
export function registerTerminalWorkspaceIpc(ipc: IpcMainAdapter, service: TerminalWorkspaceService, senders: () => readonly TrustedIpcSender[], getWindow?: (sender: IpcWebContentsLike) => TerminalVisibilityWindow | undefined): () => void {
  const watchers = new Map<IpcWebContentsLike, () => void>()
  for (const method of TERMINAL_WORKSPACE_METHODS) {
    ipc.handle(TERMINALS_CHANNEL + method, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('TERMINALS_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      if (method === 'visibility' && getWindow) {
        const window = getWindow(event.sender)
        if (!window || window.isDestroyed()) return service.visibility({ ids: [] }, event.sender, () => false)
        if (!watchers.has(event.sender)) {
          const refresh = (): void => { service.refreshVisibility() }
          const unavailable = (): void => { service.withdrawVisibility(event.sender) }
          const closed = (): void => { service.withdrawVisibility(event.sender); watchers.get(event.sender)?.(); watchers.delete(event.sender) }
          for (const name of ['show', 'hide', 'minimize', 'restore'] as const) window.on(name, refresh)
          window.on('closed', closed)
          for (const name of ['did-start-loading', 'render-process-gone', 'destroyed'] as const) window.webContents?.on(name, unavailable)
          watchers.set(event.sender, () => {
            for (const name of ['show', 'hide', 'minimize', 'restore'] as const) window.removeListener(name, refresh)
            window.removeListener('closed', closed)
            for (const name of ['did-start-loading', 'render-process-gone', 'destroyed'] as const) window.webContents?.removeListener(name, unavailable)
          })
        }
        return service.visibility(payload, event.sender, () => !event.sender.isDestroyed() && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
      }
      return service[method](payload)
    })
  }
  return () => {
    for (const method of TERMINAL_WORKSPACE_METHODS) ipc.removeHandler(TERMINALS_CHANNEL + method)
    for (const cleanup of watchers.values()) cleanup()
    watchers.clear()
    service.dispose()
  }
}
