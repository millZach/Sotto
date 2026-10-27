import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSettings } from '../../../../../src/renderer/src/features/settings/AppearanceSettings'
import { LanguagePicker } from '../../../../../src/renderer/src/features/settings/LanguagePicker'
import type { LaterWords } from '../../../../../src/renderer/src/features/settings/laterWords'
import { firstInterfaceLanguage, showInterfaceLanguage, startInterfaceLanguage } from '../../../../../src/renderer/src/state/interfaceLanguage'
import type { InterfaceLanguageState } from '../../../../../src/shared/interfaceLanguages'
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../../../../src/shared/settings'

// The row is an Owl feature (ADR-0072, ADR-0123); each test says whether this build has it.
const gate = vi.hoisted(() => ({ owl: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'interface-language' && gate.owl,
}))

afterEach(async () => {
  cleanup()
  gate.owl = true
  await act(() => showInterfaceLanguage({ language: 'en', system: 'en' }))
})

const appearance = (onSave = vi.fn<(patch: SettingsPatch, text?: LaterWords) => Promise<boolean>>(async () => true)) =>
  render(<AppearanceSettings settings={DEFAULT_SETTINGS} platform="win32" onSave={onSave} getSettings={() => DEFAULT_SETTINGS} />)

describe('Settings > Appearance > Language', () => {
  it('does not exist while the Owl feature is off, and the saved choice is left alone', () => {
    gate.owl = false
    const onSave = vi.fn(async () => true)
    appearance(onSave)
    expect(screen.queryByRole('combobox', { name: /Language/u })).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('stands in the Details card of Appearance, naming what it does and what it is set to', () => {
    appearance()
    const section = document.querySelector('#settings-appearance') as HTMLElement
    const picker = within(section).getByRole('combobox', { name: 'Language Same as this computer (English)' })
    expect(within(section).getByRole('region', { name: 'Details' })).toContainElement(picker)
    expect(picker).toHaveAccessibleDescription('Menus, buttons and messages. What you dictate and what agents write stay as they are.')
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(within(section).getAllByText('Preview')).not.toHaveLength(0)
  })

  it('lists "Same as this computer" first, then every language in its own script with its name here beside it', async () => {
    const user = userEvent.setup()
    await act(() => showInterfaceLanguage({ language: 'en', system: 'de' }))
    render(<LanguagePicker value="system" onChoose={() => undefined} />)
    await user.click(screen.getByRole('combobox', { name: 'Language Same as this computer (Deutsch)' }))
    const options = within(screen.getByRole('listbox', { name: 'Language' })).getAllByRole('option')
    expect(options).toHaveLength(31)
    expect(options[0]).toHaveTextContent('Same as this computer (Deutsch)')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveTextContent(/^English$/u)
    const japanese = options.find(option => option.textContent?.startsWith('日本語'))!
    expect(japanese).toHaveTextContent('日本語Japanese')
    expect(within(japanese).getByText('日本語')).toHaveAttribute('lang', 'ja')
    const arabic = options.find(option => option.textContent?.startsWith('العربية'))!
    expect(within(arabic).getByText('العربية')).toHaveAttribute('dir', 'rtl')
    expect(screen.getByText('Translations are new and ship on Owl first. Some words may still be in English.')).toBeVisible()
  })

  it('is complete from the keyboard: arrows and letters move, Enter picks, Escape closes without choosing', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<LanguagePicker value="system" onChoose={onChoose} />)
    const picker = screen.getByRole('combobox', { name: /^Language/u })
    picker.focus()
    await user.keyboard('{ArrowDown}')
    expect(picker).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{ArrowDown}')
    expect(document.getElementById(picker.getAttribute('aria-activedescendant')!)).toHaveTextContent('English')
    await user.keyboard('{Escape}')
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(onChoose).not.toHaveBeenCalled()
    // A language is found by its own name or its name here.
    await user.keyboard('{ArrowDown}j')
    expect(document.getElementById(picker.getAttribute('aria-activedescendant')!)).toHaveTextContent('日本語')
    await user.keyboard('{Enter}')
    expect(onChoose).toHaveBeenCalledWith('ja')
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(picker).toHaveFocus()
  })

  it('saves the choice as its own patch, confirmed in the language chosen', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(patch: SettingsPatch, text?: LaterWords) => Promise<boolean>>(async () => true)
    appearance(onSave)
    await user.click(screen.getByRole('combobox', { name: /^Language/u }))
    await user.click(screen.getByRole('option', { name: /^Français/u }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ interfaceLanguage: 'fr' }, 'Langue enregistrée.'))
  })

  it('redraws in a new language at once, keeps the English word Language beside the label, and the window left to right', async () => {
    appearance()
    await act(() => showInterfaceLanguage({ language: 'ja', system: 'en' }))
    const section = document.querySelector('#settings-appearance') as HTMLElement
    expect(within(section).getByRole('heading', { level: 2, name: '外観' })).toBeVisible()
    const picker = within(section).getByRole('combobox', { name: '言語 このコンピューターと同じ（English）' })
    expect(picker).toBeVisible()
    expect(within(section).getByText('Language')).toHaveAttribute('lang', 'en')
    expect(document.documentElement.lang).toBe('ja')
    expect(document.documentElement.dir).toBe('ltr')

    await act(() => showInterfaceLanguage({ language: 'ar', system: 'en' }))
    expect(within(section).getByRole('heading', { level: 2, name: 'المظهر' })).toBeVisible()
    expect(document.documentElement.lang).toBe('ar')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it('names other languages in the language shown, from the system\'s own list', async () => {
    const user = userEvent.setup()
    await act(() => showInterfaceLanguage({ language: 'de', system: 'en' }))
    render(<LanguagePicker value="ja" onChoose={() => undefined} />)
    await user.click(screen.getByRole('combobox', { name: 'Sprache 日本語' }))
    expect(screen.getByRole('option', { name: /^日本語/u })).toHaveTextContent('日本語Japanisch')
    expect(screen.getByRole('option', { name: /^日本語/u })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('a window\'s interface language', () => {
  it('draws its first frame in the language it was made with, asks main once loaded, and follows every change', async () => {
    let changed: ((state: InterfaceLanguageState) => void) | undefined
    const current = vi.fn(async (): Promise<InterfaceLanguageState> => ({ language: 'fr', system: 'fr' }))
    const bridge = { startup: { language: 'it', system: 'fr' } as InterfaceLanguageState, current, onChanged: vi.fn((listener: (state: InterfaceLanguageState) => void) => { changed = listener; return () => undefined }) }
    await startInterfaceLanguage(bridge)
    expect(document.documentElement.lang).toBe('it')
    // The window was made before a change it missed, as after a reload; main's answer once loaded wins.
    await waitFor(() => expect(document.documentElement.lang).toBe('fr'))
    changed?.({ language: 'pt-BR', system: 'fr' })
    await waitFor(() => expect(document.documentElement.lang).toBe('pt-BR'))
  })

  it('keeps asking until main answers a window that has just loaded', async () => {
    const current = vi.fn<() => Promise<InterfaceLanguageState>>()
      .mockRejectedValueOnce(new Error('Unauthorized IPC sender'))
      .mockResolvedValue({ language: 'nl', system: 'en' })
    await startInterfaceLanguage({ startup: { language: 'en', system: 'en' }, current, onChanged: () => () => undefined })
    await waitFor(() => expect(document.documentElement.lang).toBe('nl'))
    expect(current).toHaveBeenCalledTimes(2)
  })

  it('draws the first frame after a reload in the language it showed last, not the one the window was made with', async () => {
    await act(() => showInterfaceLanguage({ language: 'ja', system: 'en' }))
    // A reload keeps the window's arguments, which still say English; main has not answered yet.
    const madeWith: InterfaceLanguageState = { language: 'en', system: 'en' }
    expect(firstInterfaceLanguage({ startup: madeWith })).toEqual({ language: 'ja', system: 'en' })
    await startInterfaceLanguage({ startup: madeWith, current: () => new Promise(() => undefined), onChanged: () => () => undefined })
    expect(document.documentElement.lang).toBe('ja')
    // A new window remembers nothing and starts in what main made it with.
    sessionStorage.clear()
    expect(firstInterfaceLanguage({ startup: madeWith })).toEqual(madeWith)
    sessionStorage.setItem('sotto:interface-language', '{"language":"klingon","system":"en"}')
    expect(firstInterfaceLanguage({ startup: madeWith })).toEqual(madeWith)
  })

  it('stays English without a bridge', async () => {
    await startInterfaceLanguage(undefined)
    expect(document.documentElement.lang).toBe('en')
  })
})
