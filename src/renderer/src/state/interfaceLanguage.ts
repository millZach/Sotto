import { useSyncExternalStore } from 'react'
import { i18n, setupI18n, type MessageDescriptor, type Messages } from '@lingui/core'

import type { InterfaceLanguageBridge } from '../../../shared/interfaceLanguageBridge'
import {
  ENGLISH_INTERFACE,
  SOURCE_INTERFACE_LANGUAGE,
  type InterfaceLanguageState,
  type ShownInterfaceLanguage,
} from '../../../shared/interfaceLanguages'

/**
 * A window's interface language (ADR-0122). Each window loads every renderer area's catalog, so a component shows its
 * words whichever area it was extracted into; main's catalog stays in main. English is in the bundle and active before
 * the first frame. Another language is read from the bundle the first time it is shown: no request leaves the computer.
 */
interface Catalog { readonly messages: Messages }

const english = import.meta.glob<Catalog>(['../../../locales/*/en.po', '!../../../locales/main/en.po'], { eager: true })
const catalogs = import.meta.glob<Catalog>(['../../../locales/*/*.po', '!../../../locales/main/*.po', '!../../../locales/*/en.po'])

const merged = (loaded: readonly Catalog[]): Messages => Object.assign({}, ...loaded.map(catalog => catalog.messages)) as Messages
const englishMessages = merged(Object.values(english))

async function messagesOf(language: ShownInterfaceLanguage): Promise<Messages> {
  if (language === SOURCE_INTERFACE_LANGUAGE) return englishMessages
  const loads = Object.entries(catalogs).filter(([path]) => path.endsWith(`/${language}.po`)).map(([, load]) => load())
  return merged(await Promise.all(loads))
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
  // ADR-0122 keeps the English layout in every language: only text inside its own box runs right to left.
  root.dir = 'ltr'
  for (const listener of [...listeners]) listener()
}

/**
 * Shows the window's language before its first frame, from what main gave the window as it made it, and follows every
 * change after it. A window without the bridge (the Owl feature off, a test, a preview) stays in English.
 */
export async function startInterfaceLanguage(bridge: InterfaceLanguageBridge | undefined): Promise<void> {
  if (bridge === undefined) return
  bridge.onChanged(next => { void showInterfaceLanguage(next).catch(() => undefined) })
  await showInterfaceLanguage(bridge.startup).catch(() => undefined)
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
