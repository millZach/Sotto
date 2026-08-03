import type { SottoPlatform } from '../../shared/platform'
import { buildDarwinPasteInvocation } from './pasteCommand.darwin'
import { buildPasteHelperInvocation, buildPasteInvocation } from './pasteCommand.win32'

export interface PasteInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

export interface PasteCommands {
  readonly oneShot: () => Readonly<PasteInvocation>
  /** null where no warm helper process exists for the platform. */
  readonly helper: (() => Readonly<PasteInvocation>) | null
}

const PASTE_COMMANDS: Readonly<Record<SottoPlatform, PasteCommands>> = Object.freeze({
  win32: Object.freeze({
    oneShot: buildPasteInvocation,
    helper: buildPasteHelperInvocation,
  }),
  darwin: Object.freeze({
    oneShot: buildDarwinPasteInvocation,
    helper: null,
  }),
})

export function createPasteCommands(platform: SottoPlatform): PasteCommands {
  return PASTE_COMMANDS[platform]
}
