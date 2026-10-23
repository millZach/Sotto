import { useSyncExternalStore } from 'react'
import { i18n, setupI18n, type MessageDescriptor } from '@lingui/core'

import { interfaceCatalogs, type CompiledCatalog } from '../../../shared/interfaceCatalogLoader'
import { interfaceLanguageStateSchema, type InterfaceLanguageBridge } from '../../../shared/interfaceLanguageBridge'
import {
  ENGLISH_INTERFACE,
  SOURCE_INTERFACE_LANGUAGE,
  type InterfaceLanguageState,
  type ShownInterfaceLanguage,
} from '../../../shared/interfaceLanguages'

/**
 * A window's interface language (ADR-0123). Each window loads every renderer area's catalog, so a component shows its
 * words whichever area it was extracted into; main's catalog stays in main. English is in the bundle and active before
 * the first frame. Another language is read from the bundle the first time it is shown: no request leaves the computer.
 */
const { english: englishMessages, messagesOf } = interfaceCatalogs(
  import.meta.glob<CompiledCatalog>(['../../../locales/*/en.po', '!../../../locales/main/en.po'], { eager: true }),
  import.meta.glob<CompiledCatalog>(['../../../locales/*/*.po', '!../../../locales/main/*.po', '!../../../locales/*/en.po']),
)

/**
 * Where a window remembers the language it shows. Session storage outlives a reload of the window, which keeps the
 * arguments the window was made with, and starts empty in a new window, which main gives today's language.
 */
const SHOWN_KEY = 'sotto:interface-language'

function rememberedLanguage(): InterfaceLanguageState | null {
  try {
    const parsed = interfaceLanguageStateSchema.safeParse(JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The language a window's first frame is in: the one it showed before a reload, else the one main made it with. */
export function firstInterfaceLanguage(bridge: Pick<InterfaceLanguageBridge, 'startup'>): InterfaceLanguageState {
  return rememberedLanguage() ?? bridge.startup
}

/**
 * A message in a language other than the one shown, read from that language's catalogs, which stay loaded for when the
 * window changes to it. A choice of language confirms itself in the language chosen.
 */
export async function messageIn(language: ShownInterfaceLanguage, descriptor: MessageDescriptor): Promise<string> {
  return setupI18n({ locale: language, messages: { [language]: await messagesOf(language) } })._(descriptor)
}

let state: InterfaceLanguageState = ENGLISH_INTERFACE
let sequence = 0
const listeners = new Set<() => void>()

/** Shows `next` in this window: its catalogs, its words and the document's `lang`. The layout stays left to right. */
export async function showInterfaceLanguage(next: InterfaceLanguageState, root: HTMLElement = document.documentElement): Promise<void> {
  const mine = ++sequence
  const messages = await messagesOf(next.language)
  // A later change may have finished first; the newest one is shown.
  if (mine !== sequence) return
  state = next
  if (i18n.locale !== next.language) i18n.loadAndActivate({ locale: next.language, messages })
  root.lang = next.language
  // ADR-0123 keeps the English layout in every language: only text inside its own box runs right to left.
  root.dir = 'ltr'
  try { sessionStorage.setItem(SHOWN_KEY, JSON.stringify(next)) } catch { /* A window without storage asks main after a reload. */ }
  for (const listener of [...listeners]) listener()
}

/**
 * Shows the window's language before its first frame, from what main gave the window as it made it or, after a reload,
 * what it showed last, and follows every change after it. A window without the bridge (the Owl feature off, a test, a preview) stays in English.
 */
export async function startInterfaceLanguage(bridge: InterfaceLanguageBridge | undefined): Promise<void> {
  if (bridge === undefined) return
  bridge.onChanged(next => { void showInterfaceLanguage(next).catch(() => undefined) })
  await showInterfaceLanguage(firstInterfaceLanguage(bridge)).catch(() => undefined)
  void confirmInterfaceLanguage(bridge)
}

/** Waits between asks: main answers a window only once it has loaded. */
const CONFIRM_WAITS_MS = [0, 250, 1_000, 3_000] as const

/**
 * Asks main once the window has loaded, since the language may have changed after the window was made: a window that
 * reloads keeps the arguments it was made with. A change that arrives meanwhile is newer, and is the one kept.
 */
async function confirmInterfaceLanguage(bridge: InterfaceLanguageBridge): Promise<void> {
  if (document.readyState !== 'complete') await new Promise(loaded => window.addEventListener('load', loaded, { once: true }))
  const before = sequence
  for (const wait of CONFIRM_WAITS_MS) {
    if (wait > 0) await new Promise(waited => setTimeout(waited, wait))
    const now = await bridge.current().catch(() => null)
    if (now === null) continue
    if (sequence === before && (now.language !== state.language || now.system !== state.system)) await showInterfaceLanguage(now).catch(() => undefined)
    return
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = (): InterfaceLanguageState => state

/** The language this window shows and the one "Same as this computer" stands for. */
export function useInterfaceLanguageState(): InterfaceLanguageState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

i18n.loadAndActivate({ locale: SOURCE_INTERFACE_LANGUAGE, messages: englishMessages })
