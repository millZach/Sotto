// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { interfaceLanguageArgument, parseInterfaceLanguageArgument } from '../../../src/shared/interfaceLanguageBridge'

describe('the interface language a window is made with', () => {
  it('carries the language shown and the computer\'s through the window\'s arguments', () => {
    const argument = interfaceLanguageArgument({ language: 'zh-Hant', system: 'en' })
    expect(argument).toBe('--sotto-interface-language=zh-Hant,en')
    expect(parseInterfaceLanguageArgument(['--sotto-renderer-role=main', argument])).toEqual({ language: 'zh-Hant', system: 'en' })
    expect(parseInterfaceLanguageArgument([interfaceLanguageArgument({ language: 'ar-XB', system: 'de' })])).toEqual({ language: 'ar-XB', system: 'de' })
  })

  it('reads none when the Owl feature is off, or from an argument that is not one', () => {
    expect(parseInterfaceLanguageArgument(['--sotto-renderer-role=main'])).toBeNull()
    for (const value of ['ja', 'ja,en-XA', 'klingon,en', 'ja,en,fr', '']) expect(parseInterfaceLanguageArgument([`--sotto-interface-language=${value}`])).toBeNull()
    expect(parseInterfaceLanguageArgument(['--sotto-interface-language=ja,en', '--sotto-interface-language=fr,en'])).toBeNull()
  })
})
