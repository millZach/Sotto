import type { IpcFrameLike, IpcInvocationEvent, IpcMainAdapter, IpcWebContentsLike, TrustedIpcSender } from '../ipc/registerIpc'
import type { EngineIpcRole } from './types'

type IpcHandler = (event: IpcInvocationEvent, ...args: unknown[]) => unknown

const MAIN_URL = 'sotto-engine://main'
const POPUP_URL = 'sotto-engine://popup'
const MAIN_FRAME: IpcFrameLike = Object.freeze({ parent: null, url: MAIN_URL })
const POPUP_FRAME: IpcFrameLike = Object.freeze({ parent: null, url: POPUP_URL })
const MAIN_CONTENTS: IpcWebContentsLike = Object.freeze({ mainFrame: MAIN_FRAME, getURL: () => MAIN_URL, isDestroyed: () => false })
const POPUP_CONTENTS: IpcWebContentsLike = Object.freeze({ mainFrame: POPUP_FRAME, getURL: () => POPUP_URL, isDestroyed: () => false })

const ENGINE_SENDERS: readonly TrustedIpcSender[] = Object.freeze([
  Object.freeze({ role: 'main' as const, webContents: MAIN_CONTENTS, url: MAIN_URL }),
  Object.freeze({ role: 'popup' as const, webContents: POPUP_CONTENTS, url: POPUP_URL }),
])

const ROLE_EVENTS: Readonly<Record<EngineIpcRole, IpcInvocationEvent>> = Object.freeze({
  main: Object.freeze({ sender: MAIN_CONTENTS, senderFrame: MAIN_FRAME }),
  popup: Object.freeze({ sender: POPUP_CONTENTS, senderFrame: POPUP_FRAME }),
})

/**
 * In-engine `IpcMainAdapter` with zero Electron dependencies (ADR-0210).
 * The Electron shell authenticates each renderer `WebContents` once at `ipcMain` and forwards the verified role
 * (`main` or `popup`) here; every engine IPC registrar keeps its own per-channel role check and zod input validation.
 */
export class EngineIpcRegistry implements IpcMainAdapter {
  private readonly handlers = new Map<string, IpcHandler>()

  handle(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  channels(): readonly string[] {
    return [...this.handlers.keys()]
  }

  senders(): readonly TrustedIpcSender[] {
    return ENGINE_SENDERS
  }

  invoke(channel: string, role: EngineIpcRole, args: readonly unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) return Promise.reject(new Error(`ENGINE_IPC_CHANNEL_UNAVAILABLE: ${channel}`))
    try {
      return Promise.resolve(handler(ROLE_EVENTS[role], ...args))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
