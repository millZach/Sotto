import type { SottoPlatform } from '../../shared/platform'
import { buildDarwinPasteInvocation } from './pasteCommand.darwin'
import { buildPasteHelperInvocation, buildPasteInvocation } from './pasteCommand.win32'

export interface PasteInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

export interface PasteCommands {
  /** null when the platform only copies transcripts. */
  readonly oneShot: () => Readonly<PasteInvocation> | null
  /** null where no warm helper process exists for the platform. */
  readonly helper: (() => Readonly<PasteInvocation>) | null
}

const PASTE_COMMANDS = Object.freeze({
  win32: Object.freeze({
    oneShot: buildPasteInvocation,
    helper: buildPasteHelperInvocation,
  }),
  darwin: Object.freeze({
    oneShot: buildDarwinPasteInvocation,
    helper: null,
  }),
  linux: Object.freeze({
    oneShot: () => null,
    helper: null,
  }),
}) satisfies Readonly<Record<SottoPlatform, PasteCommands>>

export function createPasteCommands<Platform extends SottoPlatform>(platform: Platform): (typeof PASTE_COMMANDS)[Platform] {
  return PASTE_COMMANDS[platform]
}
