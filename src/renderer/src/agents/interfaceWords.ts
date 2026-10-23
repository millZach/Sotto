import { i18n, type MessageDescriptor } from '@lingui/core'

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
