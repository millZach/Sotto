/// <reference types="vite/client" />
import { i18n, setupI18n, type MessageDescriptor } from '@lingui/core'

import { interfaceCatalogs, type CompiledCatalog } from '../shared/interfaceCatalogLoader'

import {
  ENGLISH_INTERFACE,
  isShownInterfaceLanguage,
  resolveInterfaceLanguage,
  SOURCE_INTERFACE_LANGUAGE,
  systemInterfaceLanguage,
  type InterfaceLanguageState,
  type ShownInterfaceLanguage,
} from '../shared/interfaceLanguages'
import type { AppSettings } from '../shared/settings'

/**
 * Main's own words, the tray, the application menu and main's dialogs, in the interface language (ADR-0123). Main
 * loads its own catalog and the shared one; each window loads the renderer's. English is in the bundle and active before
 * anything asks for a word; another language's catalogs are read the first time it is shown.
 */
const { english, messagesOf } = interfaceCatalogs(
  import.meta.glob<CompiledCatalog>(['../locales/main/en.po', '../locales/shared/en.po'], { eager: true }),
  import.meta.glob<CompiledCatalog>(['../locales/main/*.po', '../locales/shared/*.po', '!../locales/*/en.po']),
)
i18n.loadAndActivate({ locale: SOURCE_INTERFACE_LANGUAGE, messages: english })
/**
 * English whatever the interface language, for what Sotto says to a model about something the user also sees: an agent
 * setting a host up reads the host's failures in English while the dialog shows them in the interface language.
 */
const englishI18n = setupI18n({ locale: SOURCE_INTERFACE_LANGUAGE, messages: { [SOURCE_INTERFACE_LANGUAGE]: english } })
export function inEnglish(words: MessageDescriptor): string { return englishI18n._(words) }

export interface InterfaceLanguageOptions {
  /** The `interface-language` Owl answer read at start. Off, Sotto is English whatever the setting says. */
  readonly enabled: boolean
  /** The computer's languages, most preferred first. End-to-end runs pass English, so a test reads English anywhere. */
  readonly systemLanguages: readonly string[]
  /** `SOTTO_INTERFACE_LANGUAGE` on an unpackaged run: any language, or a pseudo-language, over the setting. */
  readonly override?: string | undefined
}

export class MainInterfaceLanguage {
  private readonly system
  private readonly override: ShownInterfaceLanguage | null
  private shown: InterfaceLanguageState = ENGLISH_INTERFACE
  private sequence = 0

  constructor(private readonly options: InterfaceLanguageOptions) {
    this.system = systemInterfaceLanguage(options.systemLanguages)
    this.override = isShownInterfaceLanguage(options.override) ? options.override : null
  }

  /** What every window is told: the language now shown, and what "Same as this computer" stands for. */
  current(): InterfaceLanguageState {
    return this.shown
  }

  stateFor(settings: Pick<AppSettings, 'interfaceLanguage'>): InterfaceLanguageState {
    if (!this.options.enabled) return ENGLISH_INTERFACE
    return { language: this.override ?? resolveInterfaceLanguage(settings.interfaceLanguage, [this.system]), system: this.system }
  }

  /** Shows the language `settings` asks for in main; true when what the windows are told changed. */
  async apply(settings: Pick<AppSettings, 'interfaceLanguage'>): Promise<boolean> {
    const next = this.stateFor(settings)
    const sequence = ++this.sequence
    if (next.language === this.shown.language && next.system === this.shown.system) return false
    const messages = await messagesOf(next.language)
    // A later change may have asked while this one read its catalogs; the newest choice is the one shown.
    if (sequence !== this.sequence) return false
    i18n.loadAndActivate({ locale: next.language, messages })
    this.shown = next
    return true
  }
}

/** The computer's languages, most preferred first; Electron's own locale where the system list is empty. */
export function preferredSystemLanguages(app: { getPreferredSystemLanguages(): string[]; getLocale(): string }): string[] {
  try {
    const languages = app.getPreferredSystemLanguages()
    if (languages.length > 0) return languages
  } catch {
    // An older or unusual system answers nothing; the locale below still names one language.
  }
  return [app.getLocale()]
}
