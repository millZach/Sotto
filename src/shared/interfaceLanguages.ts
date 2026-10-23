/**
 * The languages Sotto's interface can be written in (ADR-0122), and how the computer's language picks one. This module
 * imports nothing, so `lingui.config.ts` reads the same list the app does.
 */

export interface InterfaceLanguage {
  /** The catalog's name and the window's `lang`: a BCP 47 tag. */
  readonly code: string
  /** The language's name in its own script, as the picker lists it. */
  readonly endonym: string
  /** Its English name, for where `Intl.DisplayNames` has none. */
  readonly englishName: string
  /** Text direction. The window keeps its English layout either way; only text runs right to left. */
  readonly direction: 'ltr' | 'rtl'
}

export const SOURCE_INTERFACE_LANGUAGE = 'en'

export const INTERFACE_LANGUAGES = [
  { code: 'en', endonym: 'English', englishName: 'English', direction: 'ltr' },
  { code: 'es-MX', endonym: 'Español (México)', englishName: 'Spanish (Mexico)', direction: 'ltr' },
  { code: 'es-ES', endonym: 'Español (España)', englishName: 'Spanish (Spain)', direction: 'ltr' },
  { code: 'fr', endonym: 'Français', englishName: 'French', direction: 'ltr' },
  { code: 'de', endonym: 'Deutsch', englishName: 'German', direction: 'ltr' },
  { code: 'it', endonym: 'Italiano', englishName: 'Italian', direction: 'ltr' },
  { code: 'pt-BR', endonym: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', direction: 'ltr' },
  { code: 'pt-PT', endonym: 'Português (Portugal)', englishName: 'Portuguese (Portugal)', direction: 'ltr' },
  { code: 'nl', endonym: 'Nederlands', englishName: 'Dutch', direction: 'ltr' },
  { code: 'pl', endonym: 'Polski', englishName: 'Polish', direction: 'ltr' },
  { code: 'sv', endonym: 'Svenska', englishName: 'Swedish', direction: 'ltr' },
  { code: 'da', endonym: 'Dansk', englishName: 'Danish', direction: 'ltr' },
  { code: 'nb', endonym: 'Norsk bokmål', englishName: 'Norwegian Bokmål', direction: 'ltr' },
  { code: 'fi', endonym: 'Suomi', englishName: 'Finnish', direction: 'ltr' },
  { code: 'cs', endonym: 'Čeština', englishName: 'Czech', direction: 'ltr' },
  { code: 'ro', endonym: 'Română', englishName: 'Romanian', direction: 'ltr' },
  { code: 'hu', endonym: 'Magyar', englishName: 'Hungarian', direction: 'ltr' },
  { code: 'el', endonym: 'Ελληνικά', englishName: 'Greek', direction: 'ltr' },
  { code: 'uk', endonym: 'Українська', englishName: 'Ukrainian', direction: 'ltr' },
  { code: 'tr', endonym: 'Türkçe', englishName: 'Turkish', direction: 'ltr' },
  { code: 'ar', endonym: 'العربية', englishName: 'Arabic', direction: 'rtl' },
  { code: 'zh-Hans', endonym: '简体中文', englishName: 'Chinese (Simplified)', direction: 'ltr' },
  { code: 'zh-Hant', endonym: '繁體中文', englishName: 'Chinese (Traditional)', direction: 'ltr' },
  { code: 'ja', endonym: '日本語', englishName: 'Japanese', direction: 'ltr' },
  { code: 'hi', endonym: 'हिन्दी', englishName: 'Hindi', direction: 'ltr' },
  { code: 'bn', endonym: 'বাংলা', englishName: 'Bangla', direction: 'ltr' },
  { code: 'mr', endonym: 'मराठी', englishName: 'Marathi', direction: 'ltr' },
  { code: 'te', endonym: 'తెలుగు', englishName: 'Telugu', direction: 'ltr' },
  { code: 'ta', endonym: 'தமிழ்', englishName: 'Tamil', direction: 'ltr' },
  { code: 'ur', endonym: 'اردو', englishName: 'Urdu', direction: 'rtl' },
] as const satisfies readonly InterfaceLanguage[]

export type InterfaceLanguageCode = typeof INTERFACE_LANGUAGES[number]['code']
export const INTERFACE_LANGUAGE_CODES: readonly InterfaceLanguageCode[] = INTERFACE_LANGUAGES.map(language => language.code)

/**
 * Development's layout checks: longer, accented text and right-to-left text. Reached only through
 * `SOTTO_INTERFACE_LANGUAGE` on an unpackaged run, never the picker or the setting.
 */
export const INTERFACE_PSEUDO_LANGUAGES = [
  { code: 'en-XA', direction: 'ltr' },
  { code: 'ar-XB', direction: 'rtl' },
] as const
export type InterfacePseudoLanguageCode = typeof INTERFACE_PSEUDO_LANGUAGES[number]['code']
/** What a window can be shown in: one of the thirty, or a pseudo-language in development. */
export type ShownInterfaceLanguage = InterfaceLanguageCode | InterfacePseudoLanguageCode

/** The saved choice: follow the computer, or one language. */
export type InterfaceLanguageSetting = 'system' | InterfaceLanguageCode
export const INTERFACE_LANGUAGE_SETTINGS = ['system', ...INTERFACE_LANGUAGE_CODES] as readonly [InterfaceLanguageSetting, ...InterfaceLanguageSetting[]]

/** What main tells each window: the language it is in, and the one "Same as this computer" stands for. */
export interface InterfaceLanguageState {
  readonly language: ShownInterfaceLanguage
  readonly system: InterfaceLanguageCode
}
export const ENGLISH_INTERFACE: InterfaceLanguageState = Object.freeze({ language: 'en', system: 'en' })

export function isInterfaceLanguageCode(value: unknown): value is InterfaceLanguageCode {
  return typeof value === 'string' && (INTERFACE_LANGUAGE_CODES as readonly string[]).includes(value)
}

export function isShownInterfaceLanguage(value: unknown): value is ShownInterfaceLanguage {
  return isInterfaceLanguageCode(value) || INTERFACE_PSEUDO_LANGUAGES.some(language => language.code === value)
}

export function interfaceLanguageDirection(code: ShownInterfaceLanguage): 'ltr' | 'rtl' {
  return [...INTERFACE_LANGUAGES, ...INTERFACE_PSEUDO_LANGUAGES].find(language => language.code === code)?.direction ?? 'ltr'
}

// Spanish as written in Spain: Spain, its North African cities and the Canaries, Andorra, Equatorial Guinea, and the rest
// of Europe. Every other region, and Spanish with none, reads the Mexican catalog.
const SPAIN_SPANISH_REGIONS = new Set([
  'ES', 'EA', 'IC', 'AD', 'GQ', '150', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'FI', 'FR', 'GB', 'GI', 'GR',
  'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK',
  'SM', 'UA', 'VA', 'XK',
])

/** The language one system language tag reaches, or null when it is none of the thirty. */
export function interfaceLanguageOfTag(tag: string): InterfaceLanguageCode | null {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(tag.trim().replaceAll('_', '-'))
  } catch {
    return null
  }
  const region = locale.region?.toUpperCase()
  switch (locale.language) {
    case 'es': return region !== undefined && SPAIN_SPANISH_REGIONS.has(region) ? 'es-ES' : 'es-MX'
    // Brazil's Portuguese for Brazil and for Portuguese with no region; every other region writes Portugal's.
    case 'pt': return region === undefined || region === 'BR' ? 'pt-BR' : 'pt-PT'
    // The script decides, and a region implies one: zh-TW, zh-HK and zh-MO are Traditional, zh-CN and zh-SG Simplified.
    case 'zh': return (locale.script ?? maximizedScript(locale)) === 'Hant' ? 'zh-Hant' : 'zh-Hans'
    case 'no': case 'nb': case 'nn': return 'nb'
    default: return INTERFACE_LANGUAGE_CODES.find(code => code === locale.language) ?? null
  }
}

function maximizedScript(locale: Intl.Locale): string | undefined {
  try {
    return locale.maximize().script
  } catch {
    return undefined
  }
}

/** The language "Same as this computer" stands for: the first system language that is one of the thirty, else English. */
export function systemInterfaceLanguage(systemLanguages: readonly string[]): InterfaceLanguageCode {
  for (const tag of systemLanguages) {
    const language = interfaceLanguageOfTag(tag)
    if (language !== null) return language
  }
  return SOURCE_INTERFACE_LANGUAGE
}

/** The interface language: a choice in Settings wins over the computer (ADR-0122). */
export function resolveInterfaceLanguage(setting: string, systemLanguages: readonly string[]): InterfaceLanguageCode {
  return isInterfaceLanguageCode(setting) ? setting : systemInterfaceLanguage(systemLanguages)
}
