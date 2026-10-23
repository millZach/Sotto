import { i18n, type MessageDescriptor } from '@lingui/core'

/**
 * Words a part of Settings keeps to show later, such as a notice or an error (ADR-0123): a message, read in the
 * interface language each time it is shown, so a change of language reaches it too, or text someone else wrote, such as
 * a host's error, shown as written.
 */
export type LaterWords = MessageDescriptor | string

/** The words as shown now. The component showing them reads the language (`useLingui`), so it draws again on a change. */
export function shownWords(words: LaterWords): string
export function shownWords(words: LaterWords | null | undefined): string | null
export function shownWords(words: LaterWords | null | undefined): string | null {
  if (words === null || words === undefined) return null
  return typeof words === 'string' ? words : i18n._(words)
}
