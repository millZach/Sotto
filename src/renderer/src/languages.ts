export const KNOWN_LANGUAGES = [
  { value: 'auto', label: 'Automatic (English default)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
] as const

/** A short human name for a saved language code, for status lines. */
export function languageLabel(code: string): string {
  if (code === 'auto') return 'English default'
  const known = KNOWN_LANGUAGES.find((language) => language.value === code)
  return known === undefined ? code.slice(0, 12).toUpperCase() : known.label
}
