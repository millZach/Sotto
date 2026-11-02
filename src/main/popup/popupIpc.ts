import { z } from 'zod'

import {
  POPUP_FIT, POPUP_HIDE, POPUP_OPEN, POPUP_SHORTCUT_REPLACE, POPUP_SHORTCUT_STATE_GET, POPUP_SHORTCUT_SUSPEND,
  popupFitSchema, popupOpenSchema, popupShortcutReplaceSchema, type PopupOpen, type PopupShortcutResult, type PopupShortcutState,
} from '../../shared/popup'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

const noArguments = z.tuple([])
const fitArguments = z.tuple([popupFitSchema])
const openArguments = z.tuple([popupOpenSchema])
const replaceArguments = z.tuple([popupShortcutReplaceSchema])
const suspendArguments = z.tuple([z.boolean()])

export interface PopupIpcService {
  hide(): void
  fit(height: number): void
  open(request: PopupOpen): Promise<void>
  shortcutState(): PopupShortcutState
  replaceShortcut(chord: string | null): Promise<PopupShortcutResult>
  suspendShortcut(suspended: boolean): void
}

/**
 * The popup's own channels (ADR-0181): its window hides, sizes and opens what it shows in the main window; the main
 * window's Settings reads and changes the shortcut. Registered only while the Owl feature is on.
 */
export function registerPopupIpc(ipc: IpcMainAdapter, service: PopupIpcService, senders: () => readonly TrustedIpcSender[]): () => void {
  const handle = <Args extends unknown[], Result>(channel: string, role: 'main' | 'popup', schema: z.ZodType<Args>,
    run: (...args: Args) => Result): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), [role])) throw new Error('POPUP_SENDER_REJECTED')
      return run(...schema.parse(args))
    })
  }
  handle(POPUP_HIDE, 'popup', noArguments, () => service.hide())
  handle(POPUP_FIT, 'popup', fitArguments, height => service.fit(height))
  handle(POPUP_OPEN, 'popup', openArguments, request => service.open(request))
  handle(POPUP_SHORTCUT_STATE_GET, 'main', noArguments, () => service.shortcutState())
  handle(POPUP_SHORTCUT_REPLACE, 'main', replaceArguments, chord => service.replaceShortcut(chord))
  handle(POPUP_SHORTCUT_SUSPEND, 'main', suspendArguments, suspended => service.suspendShortcut(suspended))
  return () => {
    for (const channel of [POPUP_HIDE, POPUP_FIT, POPUP_OPEN, POPUP_SHORTCUT_STATE_GET, POPUP_SHORTCUT_REPLACE, POPUP_SHORTCUT_SUSPEND]) ipc.removeHandler(channel)
  }
}
