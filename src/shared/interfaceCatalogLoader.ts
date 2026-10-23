import type { Messages } from '@lingui/core'

import { SOURCE_INTERFACE_LANGUAGE, type ShownInterfaceLanguage } from './interfaceLanguages'

/** A `.po` catalog as the build compiles it. */
export interface CompiledCatalog { readonly messages: Messages }

export interface InterfaceCatalogs {
  /** Every English message the process bundles, ready before anything asks for a word. */
  readonly english: Messages
  /** One language's messages from every catalog the process bundles, read the first time that language is shown. */
  messagesOf(language: ShownInterfaceLanguage): Promise<Messages>
}

/**
 * One process's catalogs (ADR-0123), from its two `import.meta.glob` lists: the English ones, loaded with the bundle, and
 * every other language's, keyed by path and loaded on demand. Each process names which areas it carries; this merges a
 * language's areas into one table.
 */
export function interfaceCatalogs(english: Readonly<Record<string, CompiledCatalog>>, others: Readonly<Record<string, () => Promise<CompiledCatalog>>>): InterfaceCatalogs {
  const merged = (loaded: readonly CompiledCatalog[]): Messages => Object.assign({}, ...loaded.map(catalog => catalog.messages)) as Messages
  const englishMessages = merged(Object.values(english))
  return {
    english: englishMessages,
    async messagesOf(language) {
      if (language === SOURCE_INTERFACE_LANGUAGE) return englishMessages
      const loads = Object.entries(others).filter(([path]) => path.endsWith(`/${language}.po`)).map(([, load]) => load())
      return merged(await Promise.all(loads))
    },
  }
}
