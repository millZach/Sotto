import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { resolveE2EConfiguration } from '../e2e/e2eBoundary'
import type { IpcMainAdapter, TrustedIpcSender } from '../ipc/registerIpc'
import type { HostService } from './hostService'
import { registerAgentIpcCore, type AgentIpcControl, type AgentIpcOptions } from './ipcCore'

export type { AgentIpcControl, AgentIpcOptions } from './ipcCore'

/** Native folder picker for `AGENT_CHOOSE_PROJECT_DIRECTORY`, kept in the Electron shell. */
export async function chooseProjectDirectoryInElectron(event: { readonly sender: unknown }): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(event.sender as WebContents)
  if (parent === null || parent.isDestroyed()) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
  if (resolveE2EConfiguration(app.isPackaged, process.env) !== null) {
    const path = process.env.SOTTO_E2E_PROJECT_DIRECTORY
    if (path === undefined) return null
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('AGENT_E2E_PROJECT_DIRECTORY_INVALID')
    return path
  }
  const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0] || null
}

/**
 * The window's end of the host boundary. Reads still go straight to the coordinator, because the
 * window is in the same process; every command goes through the host service with the identity of
 * the client that sent it, which is the line a remote client would cross (ADR-0016).
 */
export function registerAgentIpc(
  ipc: IpcMainAdapter,
  control: AgentIpcControl,
  host: Pick<HostService, 'command'>,
  senders: () => readonly TrustedIpcSender[],
  options: AgentIpcOptions,
): () => void {
  return registerAgentIpcCore(ipc, control, host, senders, {
    ...options,
    chooseProjectDirectory: options.chooseProjectDirectory ?? chooseProjectDirectoryInElectron,
  })
}
