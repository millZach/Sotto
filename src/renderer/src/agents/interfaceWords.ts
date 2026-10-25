import { i18n, type MessageDescriptor } from '@lingui/core'

import { INTERFACE_LANGUAGES, INTERFACE_PSEUDO_LANGUAGES, SOURCE_INTERFACE_LANGUAGE } from '../../../shared/interfaceLanguages'

/**
 * A table of words kept at module level, each read in the interface language when it is read (ADR-0123). Its messages
 * are `msg` descriptors, so the table can be written once and still follow a change of language; code that reads it by
 * key, here or in another area, reads plain strings. A component that shows one subscribes with `useLingui()`.
 */
export function wordsOf<K extends string>(messages: Readonly<Record<K, MessageDescriptor>>): Readonly<Record<K, string>> {
  const words = {} as Record<K, string>
  for (const key of Object.keys(messages) as K[]) {
    Object.defineProperty(words, key, { enumerable: true, get: () => i18n._(messages[key]) })
  }
  return words
}

const RIGHT_TO_LEFT: ReadonlySet<string> = new Set([...INTERFACE_LANGUAGES, ...INTERFACE_PSEUDO_LANGUAGES]
  .filter(language => language.direction === 'rtl').map(language => language.code))

/**
 * A branch name, path or command for a message's placeholder. In a right-to-left interface language it runs left to
 * right in its own isolate, so `feat/a-b` or `src/app.ts` keeps its order inside an Arabic or Urdu sentence (ADR-0123,
 * the glossary's "In the code"); in every other language it is the text as it is.
 */
export function leftToRight(text: string): string {
  return RIGHT_TO_LEFT.has(i18n.locale) ? `⁦${text}⁩` : text
}

/**
 * A count for a message's placeholder, in the interface language's own digits and grouping (ADR-0123). English keeps
 * the plain digits Sotto has always written, "1200 files", so its words are unchanged; a plural's `#` would group them.
 */
export function shownCount(value: number): string {
  return i18n.locale === SOURCE_INTERFACE_LANGUAGE ? String(value) : i18n.number(value)
}

/**
 * Words a part of the Threads page keeps to show later, such as an error, a notice or a copy's outcome (ADR-0123): a
 * message, read in the interface language each time it is shown, so a change of language reaches it too, or text
 * someone else wrote, such as main's or a provider's error, shown as written. A message's placeholder may itself hold
 * a message, such as "this computer" inside a sentence; it is read in the same language when the sentence is.
 */
export type LaterWords = MessageDescriptor | string

const isMessage = (value: unknown): value is MessageDescriptor =>
  typeof value === 'object' && value !== null && typeof (value as { readonly id?: unknown }).id === 'string'

/** The words as shown now. The component showing them reads the language (`useLingui`), so it draws again on a change. */
export function shownWords(words: LaterWords): string
export function shownWords(words: LaterWords | null | undefined): string | null
export function shownWords(words: LaterWords | null | undefined): string | null {
  if (words === null || words === undefined) return null
  if (typeof words === 'string') return words
  const values = words.values
  if (!values || !Object.values(values).some(isMessage)) return i18n._(words)
  return i18n._({ ...words, values: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, isMessage(value) ? shownWords(value) : value])) })
}
