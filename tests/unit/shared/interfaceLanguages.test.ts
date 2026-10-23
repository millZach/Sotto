// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  INTERFACE_LANGUAGE_CODES,
  INTERFACE_LANGUAGES,
  interfaceLanguageDirection,
  interfaceLanguageOfTag,
  isShownInterfaceLanguage,
  resolveInterfaceLanguage,
  systemInterfaceLanguage,
} from '../../../src/shared/interfaceLanguages'
import { DEFAULT_SETTINGS, parseSettings, settingsSchema } from '../../../src/shared/settings'

describe('interface languages', () => {
  it('lists the thirty languages of ADR-0122, each once, English first', () => {
    expect(INTERFACE_LANGUAGE_CODES).toEqual([
      'en', 'es-MX', 'es-ES', 'fr', 'de', 'it', 'pt-BR', 'pt-PT', 'nl', 'pl', 'sv', 'da', 'nb', 'fi', 'cs', 'ro', 'hu', 'el', 'uk', 'tr',
      'ar', 'zh-Hans', 'zh-Hant', 'ja', 'hi', 'bn', 'mr', 'te', 'ta', 'ur',
    ])
    expect(new Set(INTERFACE_LANGUAGES.map(language => language.endonym)).size).toBe(30)
    for (const code of INTERFACE_LANGUAGE_CODES) expect(Intl.getCanonicalLocales(code)).toEqual([code])
  })

  it('runs Arabic and Urdu right to left, and every other language left to right', () => {
    expect(INTERFACE_LANGUAGE_CODES.filter(code => interfaceLanguageDirection(code) === 'rtl')).toEqual(['ar', 'ur'])
    expect(interfaceLanguageDirection('ar-XB')).toBe('rtl')
    expect(interfaceLanguageDirection('en-XA')).toBe('ltr')
  })

  it.each([
    ['en-US', 'en'], ['en-GB', 'en'], ['en', 'en'],
    // Spanish: Mexico's for Latin America, the United States and Spanish with no region; Spain's for Spain and Europe.
    ['es', 'es-MX'], ['es-MX', 'es-MX'], ['es-AR', 'es-MX'], ['es-419', 'es-MX'], ['es-US', 'es-MX'], ['es-CO', 'es-MX'],
    ['es-ES', 'es-ES'], ['es-AD', 'es-ES'], ['es-GQ', 'es-ES'], ['es-DE', 'es-ES'], ['es_ES', 'es-ES'],
    // Portuguese: Brazil's for Brazil and Portuguese with no region; Portugal's everywhere else.
    ['pt', 'pt-BR'], ['pt-BR', 'pt-BR'], ['pt-PT', 'pt-PT'], ['pt-AO', 'pt-PT'], ['pt-MZ', 'pt-PT'],
    // Chinese by script, which a region implies.
    ['zh', 'zh-Hans'], ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh-Hans', 'zh-Hans'], ['zh-Hans-HK', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'], ['zh-Hant', 'zh-Hant'], ['zh-Hant-CN', 'zh-Hant'],
    // Every Norwegian reads Bokmål.
    ['no', 'nb'], ['nb-NO', 'nb'], ['nn-NO', 'nb'],
    ['fr-CA', 'fr'], ['de-AT', 'de'], ['ar-EG', 'ar'], ['ur-PK', 'ur'], ['hi-IN', 'hi'], ['bn-BD', 'bn'], ['ja-JP', 'ja'], ['uk-UA', 'uk'],
  ])('%s reaches %s', (tag, expected) => {
    expect(interfaceLanguageOfTag(tag)).toBe(expected)
  })

  it('reaches nothing from a language outside the thirty or a tag that is not one', () => {
    for (const tag of ['ru-RU', 'ko-KR', 'sk', 'he-IL', '', 'not a tag', 'x']) expect(interfaceLanguageOfTag(tag)).toBeNull()
  })

  it('follows the first of the computer\'s languages that is one of the thirty, and English when none is', () => {
    expect(systemInterfaceLanguage(['ko-KR', 'ja-JP', 'en-US'])).toBe('ja')
    expect(systemInterfaceLanguage(['es-AR', 'en-US'])).toBe('es-MX')
    expect(systemInterfaceLanguage(['ru-RU', 'ko-KR'])).toBe('en')
    expect(systemInterfaceLanguage([])).toBe('en')
  })

  it('puts a choice in Settings over the computer, and the computer under system or a choice it no longer knows', () => {
    expect(resolveInterfaceLanguage('system', ['de-DE'])).toBe('de')
    expect(resolveInterfaceLanguage('ar', ['de-DE'])).toBe('ar')
    expect(resolveInterfaceLanguage('en', ['de-DE'])).toBe('en')
    expect(resolveInterfaceLanguage('ru', ['de-DE'])).toBe('de')
  })

  it('shows a pseudo-language only by its exact code', () => {
    expect(isShownInterfaceLanguage('en-XA')).toBe(true)
    expect(isShownInterfaceLanguage('ar-XB')).toBe(true)
    expect(isShownInterfaceLanguage('pseudo')).toBe(false)
  })

  it('keeps the choice in settings: system by default, a language when saved, and system for one it does not know', () => {
    expect(DEFAULT_SETTINGS.interfaceLanguage).toBe('system')
    expect(parseSettings({ ...DEFAULT_SETTINGS, interfaceLanguage: 'zh-Hant' }).interfaceLanguage).toBe('zh-Hant')
    expect(parseSettings({ ...DEFAULT_SETTINGS, interfaceLanguage: 'ru' }).interfaceLanguage).toBe('system')
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, interfaceLanguage: 'en-XA' }).success).toBe(false)
  })
})
