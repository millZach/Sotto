import { z } from 'zod'
import { TERMINALS_CHANNEL } from '../../shared/terminalWorkspace'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { TerminalWorkspaceService } from './service'

export const TERMINAL_WORKSPACE_METHODS = ['list', 'open', 'read', 'write', 'resize', 'interrupt', 'stop', 'restart', 'close', 'pasteImage'] as const

/** Terminal mode's IPC: main window only, one payload per call, the service validating everything else. */
export function registerTerminalWorkspaceIpc(ipc: IpcMainAdapter, service: TerminalWorkspaceService, senders: () => readonly TrustedIpcSender[]): () => void {
  for (const method of TERMINAL_WORKSPACE_METHODS) {
    ipc.handle(TERMINALS_CHANNEL + method, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('TERMINALS_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      return service[method](payload)
    })
  }
  return () => {
    for (const method of TERMINAL_WORKSPACE_METHODS) ipc.removeHandler(TERMINALS_CHANNEL + method)
    service.dispose()
  }
}
