import { i18n, type MessageDescriptor } from '@lingui/core'
import type { ToolsError } from '../../../shared/tools'
import { shownWords, type LaterWords } from '../features/settings/laterWords'

/**
 * Words a Tools store keeps to show later (ADR-0123): what Tools says, kept as a message so a change of language reaches
 * it, then what went wrong, which is either a message too or text main or a provider wrote, shown as written.
 */
export interface ToolsNotice {
  readonly words: LaterWords
  readonly detail?: LaterWords | null
}

/** A notice as shown now. The component showing it reads the language (`useLingui`), so it draws again on a change. */
export function shownNotice(notice: ToolsNotice): string
export function shownNotice(notice: ToolsNotice | null | undefined): string | null
export function shownNotice(notice: ToolsNotice | null | undefined): string | null {
  if (notice === null || notice === undefined) return null
  const detail = shownWords(notice.detail)
  return detail ? `${shownWords(notice.words)} ${detail}`.trim() : shownWords(notice.words)
}

/** Errors this window wrote itself, by the message each says, so a notice can keep the message rather than its words. */
const ownErrors = new WeakMap<ToolsError, MessageDescriptor>()

/** An error the window writes itself rather than main: its message reads in the interface language each time it is read. */
export function ownError(code: ToolsError['code'], words: MessageDescriptor): ToolsError {
  const error: ToolsError = { code, get message() { return i18n._(words) } }
  ownErrors.set(error, words)
  return error
}

/** What an error says, to keep: the window's own message, or main's text as main wrote it. */
export function errorWords(error: ToolsError): LaterWords {
  return ownErrors.get(error) ?? error.message
}
