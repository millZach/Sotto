// @vitest-environment node
import { i18n } from '@lingui/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApplicationMenuTemplate } from '../../../src/main/app/applicationMenu'
import { MainInterfaceLanguage, preferredSystemLanguages } from '../../../src/main/interfaceLanguage'
import { TrayController, type TrayMenuItem } from '../../../src/main/tray/trayController'

const english = new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'] })

afterEach(async () => {
  // Every test file reads English (tests/setup.ts); a test that changed it puts it back.
  await english.apply({ interfaceLanguage: 'en' })
  i18n.loadAndActivate({ locale: 'en', messages: {} })
})

function trayLabels(): (string | undefined)[] {
  const setMenu = vi.fn<(items: readonly TrayMenuItem[]) => void>()
  new TrayController({ setMenu, destroy: () => undefined }, { toggleDictation: () => undefined, setAutoPaste: () => undefined, show: () => undefined, quit: () => undefined })
    .update({ dictating: false, autoPaste: true })
  return setMenu.mock.calls.at(-1)?.[0].map(item => item.label ?? item.type) ?? []
}

describe('main interface language', () => {
  it('stays English while the Owl feature is off, whatever the setting and the computer say', async () => {
    const off = new MainInterfaceLanguage({ enabled: false, systemLanguages: ['ja-JP'] })
    expect(await off.apply({ interfaceLanguage: 'de' })).toBe(false)
    expect(off.current()).toEqual({ language: 'en', system: 'en' })
    expect(trayLabels()).toEqual(['Start Dictation', 'Show Sotto', 'separator', 'Auto-paste', 'separator', 'Quit'])
  })

  it('follows the computer under system and a choice over it, and says what the computer is in either way', async () => {
    const language = new MainInterfaceLanguage({ enabled: true, systemLanguages: ['ko-KR', 'ja-JP'] })
    expect(language.stateFor({ interfaceLanguage: 'system' })).toEqual({ language: 'ja', system: 'ja' })
    expect(language.stateFor({ interfaceLanguage: 'fr' })).toEqual({ language: 'fr', system: 'ja' })
  })

  it('writes the tray and the application menu in the language it shows, and tells only of a change', async () => {
    const language = new MainInterfaceLanguage({ enabled: true, systemLanguages: ['ja-JP'] })
    expect(await language.apply({ interfaceLanguage: 'system' })).toBe(true)
    expect(await language.apply({ interfaceLanguage: 'system' })).toBe(false)
    expect(trayLabels()).toEqual(['音声入力を開始', 'Sotto を表示', 'separator', '自動ペースト', 'separator', '終了'])
    const menu = buildApplicationMenuTemplate({ platform: 'darwin', appName: 'Sotto', includeDeveloperTools: false, onShowSettings: () => undefined })
    expect(menu?.map(item => item.label)).toEqual(['Sotto', '編集', '表示', 'ウインドウ'])
    expect(menu?.[0]?.submenu?.find(item => item.accelerator === 'Command+,')?.label).toBe('設定…')

    expect(await language.apply({ interfaceLanguage: 'de' })).toBe(true)
    expect(trayLabels()).toEqual(['Diktat starten', 'Sotto anzeigen', 'separator', 'Automatisch einfügen', 'separator', 'Beenden'])
  })

  it('shows the newest choice when two arrive together', async () => {
    const language = new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'] })
    const first = language.apply({ interfaceLanguage: 'ar' })
    const second = language.apply({ interfaceLanguage: 'hi' })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(language.current().language).toBe('hi')
    expect(i18n.locale).toBe('hi')
  })

  it('lets an unpackaged run show a pseudo-language over the setting, and ignores one it does not know', () => {
    expect(new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'], override: 'en-XA' }).stateFor({ interfaceLanguage: 'de' }).language).toBe('en-XA')
    expect(new MainInterfaceLanguage({ enabled: true, systemLanguages: ['en-US'], override: 'klingon' }).stateFor({ interfaceLanguage: 'de' }).language).toBe('de')
  })

  it('reads the computer\'s languages, and Electron\'s locale when the system list is empty or fails', () => {
    expect(preferredSystemLanguages({ getPreferredSystemLanguages: () => ['nb-NO', 'en-US'], getLocale: () => 'en-US' })).toEqual(['nb-NO', 'en-US'])
    expect(preferredSystemLanguages({ getPreferredSystemLanguages: () => [], getLocale: () => 'pt-PT' })).toEqual(['pt-PT'])
    expect(preferredSystemLanguages({ getPreferredSystemLanguages: () => { throw new Error('unavailable') }, getLocale: () => 'tr' })).toEqual(['tr'])
  })
})
