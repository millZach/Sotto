import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

/** Dictation languages by their saved code; each label is a message, read in the interface language where it is shown. */
export const KNOWN_LANGUAGES = [
  { value: 'auto', label: msg`Automatic (detect language)` },
  { value: 'en', label: msg`English` },
  { value: 'es', label: msg`Spanish` },
  { value: 'fr', label: msg`French` },
  { value: 'de', label: msg`German` },
  { value: 'it', label: msg`Italian` },
  { value: 'pt', label: msg`Portuguese` },
  { value: 'ja', label: msg`Japanese` },
  { value: 'zh', label: msg`Chinese` },
] as const

/** A short human name for a saved language code, for status lines. */
export function languageLabel(code: string): string {
  if (code === 'auto') return i18n._(msg`Automatic language`)
  const known = KNOWN_LANGUAGES.find((language) => language.value === code)
  return known === undefined ? code.slice(0, 12).toUpperCase() : i18n._(known.label)
}
