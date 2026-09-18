import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppearanceSettings } from '../../../src/renderer/src/features/settings/AppearanceSettings'
import { ThemeEditorHost } from '../../../src/renderer/src/features/settings/themes/ThemeEditor'
import { closeThemeEditor, openThemeEditor } from '../../../src/renderer/src/features/settings/themes/themeEditorSession'
import { describeOversizedThemeFile, parseImportedThemeText } from '../../../src/renderer/src/features/settings/themes/ThemeImportDialog'
import {
  ThemeLibraryError,
  ThemeLibraryWriter,
  editorSavePatch,
  installThemesPatch,
  removeThemesPatch,
  replaceCollectionPatch,
  useThemePatch,
  versionedCopy,
  type LibraryState,
} from '../../../src/renderer/src/features/settings/themes/themeLibrary'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../../src/shared/settings'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { BUILT_IN_THEMES, MAX_CUSTOM_THEMES, canonicalizeTheme, parseThemeFile, serializeThemeFile, type ThemeDefinition } from '../../../src/shared/themes/library'

afterEach(() => {
  cleanup()
  act(() => closeThemeEditor())
  appearancePreview.reset()
})

function theme(name: string, appearance: 'light' | 'dark', extra: Record<string, unknown> = {}): ThemeDefinition {
  return canonicalizeTheme(parseThemeFile({ version: 1, name, appearance, colors: createVividThemeColors(appearance, appearance === 'dark' ? '#101820' : '#fbf8f2', '#e0a040'), ...extra }))
}

const empty: LibraryState = { lightTheme: 'ocean', darkTheme: 'ocean', customThemes: [] }
const both = { light: createVividThemeColors('light', '#fbf8f2', '#3060c0'), dark: createVividThemeColors('dark', '#101820', '#3060c0') }

describe('theme library changes', () => {
  it('takes only the half a one-appearance theme can paint, and both for a full theme', () => {
    expect(useThemePatch(theme('Paper', 'light'))).toEqual({ lightTheme: 'paper' })
    expect(useThemePatch(theme('Night', 'dark'))).toEqual({ darkTheme: 'night' })
    expect(useThemePatch(BUILT_IN_THEMES.find(entry => entry.id === 'iris')!)).toEqual({ lightTheme: 'iris', darkTheme: 'iris' })
  })

  it('installs without shadowing a built-in, duplicating an id or passing capacity', () => {
    const night = theme('Night', 'dark')
    expect(installThemesPatch(empty, [night]).customThemes!.map(entry => entry.id)).toEqual(['night'])
    const withNight = { ...empty, customThemes: [night] }
    expect(() => installThemesPatch(withNight, [night])).toThrow(ThemeLibraryError)
    expect(() => installThemesPatch(empty, [{ ...night, id: 'ocean' }])).toThrow(/reserved/u)
    const full = { ...empty, customThemes: Array.from({ length: MAX_CUSTOM_THEMES }, (_, index) => ({ ...night, id: `t-${index}` })) }
    expect(() => installThemesPatch(full, [night])).toThrow(/up to 64/u)
  })

  it('duplicates as a numbered copy and removes with the selected half falling back to Sotto', () => {
    const night = theme('Night', 'dark')
    const state: LibraryState = { lightTheme: 'iris', darkTheme: 'night', customThemes: [night] }
    const copy = versionedCopy(night, state)
    expect(copy).toMatchObject({ id: 'night-1', label: 'Night (1)', appearance: 'dark' })
    expect(versionedCopy(night, { ...state, customThemes: [night, copy] }).label).toBe('Night (2)')
    expect(versionedCopy(night, state, 'Night Owl').label).toBe('Night Owl')

    expect(removeThemesPatch(state, ['night'])).toEqual({ customThemes: [], darkTheme: 't3-code' })
    // Removing a theme no half uses leaves both halves alone.
    expect(removeThemesPatch({ ...state, darkTheme: 'grove', customThemes: [night, copy] }, ['night-1'])).toEqual({ customThemes: [night] })
  })

  it('replaces an updated collection in place and releases halves on variants it no longer ships', () => {
    const collection = { id: 'open-vsx:a.b', label: 'Pack' }
    const oldLight = theme('Pack Light', 'light', { collection, id: 'ovx-aaaaaaaaaaaa' })
    const oldDark = theme('Pack Dark', 'dark', { collection, id: 'ovx-bbbbbbbbbbbb' })
    const solo = theme('Solo', 'dark')
    const state: LibraryState = { lightTheme: oldLight.id, darkTheme: oldDark.id, customThemes: [solo, oldLight, oldDark] }
    const updatedLight = { ...oldLight, label: 'Pack Light 2' }
    const patch = replaceCollectionPatch(state, collection.id, [updatedLight])
    expect(patch.customThemes!.map(entry => entry.label)).toEqual(['Solo', 'Pack Light 2'])
    expect(patch).toMatchObject({ darkTheme: 't3-code' })
    expect(patch.lightTheme).toBeUndefined()
  })
})

describe('theme editor saves', () => {
  it('creates a theme and makes it the active half', () => {
    const result = editorSavePatch(empty, { name: 'Aurora', editingTheme: null, activeAppearance: 'dark', colorsByAppearance: both, advanced: false })
    expect(result.created).toBe(true)
    expect(result.patch).toMatchObject({ darkTheme: 'aurora' })
    expect(result.patch.lightTheme).toBeUndefined()
    expect(result.theme.managed).toBe(true)
  })

  it('adds the other palette to a same-named theme, and refuses to overwrite one it already has', () => {
    const aurora = theme('Aurora', 'dark')
    const state = { ...empty, customThemes: [aurora] }
    const merged = editorSavePatch(state, { name: 'aurora', editingTheme: null, activeAppearance: 'light', colorsByAppearance: both, advanced: true })
    expect(merged.mergedAppearance).toBe('light')
    expect(Object.keys(merged.theme.variants ?? {})).toEqual(['light'])
    expect(merged.patch).toMatchObject({ lightTheme: 'aurora', darkTheme: 'aurora' })
    expect(() => editorSavePatch(state, { name: 'Aurora', editingTheme: null, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow(/already has/u)
  })

  it('keeps an edited theme id, and reports a theme removed while it was being edited', () => {
    const aurora = theme('Aurora', 'dark')
    const state: LibraryState = { lightTheme: 'ocean', darkTheme: 'aurora', customThemes: [aurora] }
    const saved = editorSavePatch(state, { name: 'Aurora Deep', editingTheme: aurora, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })
    expect(saved.theme).toMatchObject({ id: 'aurora', label: 'Aurora Deep' })
    expect(saved.patch.customThemes).toHaveLength(1)
    expect(() => editorSavePatch(empty, { name: 'Aurora', editingTheme: aurora, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow(/removed while you were editing/u)
    expect(() => editorSavePatch(empty, { name: '  ', editingTheme: null, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow(/Name your theme/u)
    expect(() => editorSavePatch(empty, { name: 'Ocean', editingTheme: null, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow(/reserved/u)
    // A built-in's own name is taken too, whatever its id; a custom theme that already carries one keeps it.
    expect(() => editorSavePatch(empty, { name: 'tide', editingTheme: null, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow('“Tide” is a built-in theme. Pick another name.')
    expect(() => editorSavePatch({ ...empty, customThemes: [aurora] }, { name: 'Dusk', editingTheme: aurora, activeAppearance: 'dark', colorsByAppearance: both, advanced: true })).toThrow(/built-in theme/u)
    const rose = theme('Rose', 'dark')
    expect(editorSavePatch({ ...empty, customThemes: [rose] }, { name: 'Rose', editingTheme: rose, activeAppearance: 'dark', colorsByAppearance: both, advanced: true }).theme).toMatchObject({ id: 'rose', label: 'Rose' })
  })
})

describe('theme library writer', () => {
  it('runs writes one at a time, each from the library the previous write left', async () => {
    let settings: AppSettings = { ...DEFAULT_SETTINGS, customThemes: [theme('One', 'dark'), theme('Two', 'dark')] }
    const releases: Array<() => void> = []
    const save = vi.fn((patch: SettingsPatch) => new Promise<boolean>(resolve => {
      releases.push(() => {
        settings = { ...settings, ...patch } as AppSettings
        resolve(true)
      })
    }))
    const writer = new ThemeLibraryWriter(save, () => settings)
    const first = writer.run(state => ({ patch: removeThemesPatch(state, ['one']) }))
    const second = writer.run(state => ({ patch: removeThemesPatch(state, ['two']) }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    releases.shift()!()
    await first
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    // The second removal started from the first's result, so it cannot restore "one".
    expect(save.mock.calls[1]![0]).toEqual({ customThemes: [] })
    releases.shift()!()
    await expect(second).resolves.toMatchObject({ saved: true })
  })

  it('reports a failed save and leaves the saved library in force', async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, darkTheme: 'grove' }
    const writer = new ThemeLibraryWriter(async () => { throw new Error('disk full') }, () => settings)
    await expect(writer.run(() => ({ patch: { darkTheme: 'iris' } }))).resolves.toMatchObject({ saved: false })
    expect(writer.current().darkTheme).toBe('grove')
  })
})

describe('theme import text', () => {
  it('reads T3 theme files and VS Code themes, and explains invalid files', () => {
    const harbor = parseThemeFile({ version: 1, name: 'Harbor', appearance: 'dark', colors: { canvas: '#102a33' } })
    expect(parseImportedThemeText(serializeThemeFile(harbor))).toEqual(harbor)
    expect(parseImportedThemeText(JSON.stringify({ name: 'Code Dark', colors: { 'editor.background': '#1e1e1e' } })).label).toBe('Code Dark')
    expect(() => parseImportedThemeText('{ "version": 1, ')).toThrow(/not valid JSON/u)
    expect(() => parseImportedThemeText('[]')).toThrow(/JSON object/u)
    expect(() => parseImportedThemeText(JSON.stringify({ version: 1, name: 'Bad', appearance: 'dark', colors: { canvas: 'url(https://evil.example)' } }))).toThrow(/literal CSS color/u)
  })

  it('refuses a file over the size limit before reading it', () => {
    expect(describeOversizedThemeFile(1024)).toBeNull()
    expect(describeOversizedThemeFile(10 * 1024 * 1024)).toMatch(/was not read/u)
    expect(() => parseImportedThemeText(`{"pad":"${'x'.repeat(300 * 1024)}"}`)).toThrow(/was not read/u)
  })
})

describe('theme editor panel', () => {
  function host(onSave: (patch: SettingsPatch) => Promise<boolean>) {
    let settings: AppSettings = { ...DEFAULT_SETTINGS }
    const save = vi.fn(async (patch: SettingsPatch) => {
      const ok = await onSave(patch)
      if (ok) settings = { ...settings, ...patch } as AppSettings
      return ok
    })
    const view = render(<ThemeEditorHost settings={settings} onSave={save} getSettings={() => settings} />)
    return { save, view, settings: () => settings }
  }

  it('paints a draft while open, and Cancel discards it without saving', async () => {
    const user = userEvent.setup()
    const { save } = host(async () => true)
    act(() => openThemeEditor({ editingThemeId: null, seedThemeId: 'ocean', seedName: null, initialAppearance: 'dark' }))
    expect(await screen.findByRole('dialog', { name: 'Create theme' })).toHaveAttribute('data-covers-native-view')
    await user.type(screen.getByLabelText('Theme name'), 'Aurora')
    fireEvent.change(screen.getByLabelText('Background hex value'), { target: { value: '#203040' } })
    await waitFor(() => expect(appearancePreview.draft?.colors.canvas).toMatch(/^oklch\(/u))
    const drafted = appearancePreview.draft!.colors.canvas

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(appearancePreview.draft).toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(drafted).not.toBe(BUILT_IN_THEMES.find(entry => entry.id === 'ocean')!.colors.canvas)
  })

  it('saves the draft as a new theme and closes', async () => {
    const user = userEvent.setup()
    const { save } = host(async () => true)
    act(() => openThemeEditor({ editingThemeId: null, seedThemeId: 'ocean', seedName: null, initialAppearance: 'dark' }))
    await user.type(await screen.findByLabelText('Theme name'), 'Aurora')
    await user.click(screen.getByRole('button', { name: 'Create theme' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({ darkTheme: 'aurora' })
    expect(save.mock.calls[0]![0].customThemes?.map(entry => entry.label)).toEqual(['Aurora'])
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(appearancePreview.draft).toBeNull()
  })

  it('keeps the editor open with an alert when the save fails', async () => {
    const user = userEvent.setup()
    host(async () => false)
    act(() => openThemeEditor({ editingThemeId: null, seedThemeId: 'ocean', seedName: null, initialAppearance: 'dark' }))
    await user.type(await screen.findByLabelText('Theme name'), 'Aurora')
    await user.click(screen.getByRole('button', { name: 'Create theme' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(screen.getByRole('dialog', { name: 'Create theme' })).toBeVisible()
  })
})

describe('appearance settings', () => {
  function renderSettings(initial: Partial<AppSettings>) {
    let settings: AppSettings = { ...DEFAULT_SETTINGS, ...initial }
    const save = vi.fn(async (patch: SettingsPatch) => {
      settings = { ...settings, ...patch } as AppSettings
      return true
    })
    render(<AppearanceSettings settings={settings} platform="win32" onSave={save} getSettings={() => settings} />)
    return { save }
  }

  it('asks before removing a theme, and the half it owned falls back to Sotto', async () => {
    const user = userEvent.setup()
    const night = theme('Night', 'dark')
    const { save } = renderSettings({ appearance: 'dark', darkTheme: 'night', customThemes: [night] })

    await user.click(screen.getByRole('button', { name: 'Remove Night' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove “Night”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(save).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove Night' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove theme' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ customThemes: [], darkTheme: 't3-code' }, expect.anything()))
  })

  it('duplicates a built-in into the editor under a copy name', async () => {
    const user = userEvent.setup()
    renderSettings({})
    render(<ThemeEditorHost settings={DEFAULT_SETTINGS} onSave={async () => true} getSettings={() => DEFAULT_SETTINGS} />)
    await user.click(screen.getByRole('button', { name: 'Duplicate Fern' }))
    expect(await screen.findByLabelText('Theme name')).toHaveValue('Fern copy')
  })

  it('returns keyboard focus to the button that opened the editor, however it closes', async () => {
    const user = userEvent.setup()
    const night = theme('Night', 'dark')
    const settings: AppSettings = { ...DEFAULT_SETTINGS, appearance: 'dark', darkTheme: 'night', customThemes: [night] }
    renderSettings(settings)
    render(<ThemeEditorHost settings={settings} onSave={async () => true} getSettings={() => settings} />)
    const openWithKeyboard = async (label: string): Promise<HTMLElement> => {
      const opener = screen.getByRole('button', { name: label })
      opener.focus()
      await user.keyboard('{Enter}')
      await waitFor(() => expect(screen.getByLabelText('Theme name')).toHaveFocus())
      return opener
    }

    const create = await openWithKeyboard('Create theme')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(create).toHaveFocus())

    const duplicate = await openWithKeyboard('Duplicate Fern')
    screen.getByRole('button', { name: 'Close the theme editor' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(duplicate).toHaveFocus())

    const edit = await openWithKeyboard('Edit Night')
    screen.getByRole('button', { name: 'Cancel' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(edit).toHaveFocus())
  })

  it('leaves a replacing editor its focus, and restores nothing once the opener is gone', async () => {
    const user = userEvent.setup()
    const page = render(<AppearanceSettings settings={DEFAULT_SETTINGS} platform="win32" onSave={async () => true} getSettings={() => DEFAULT_SETTINGS} />)
    render(<ThemeEditorHost settings={DEFAULT_SETTINGS} onSave={async () => true} getSettings={() => DEFAULT_SETTINGS} />)
    screen.getByRole('button', { name: 'Create theme' }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByLabelText('Theme name')).toHaveFocus())

    // The gallery stays usable beside the non-modal editor; opening another session replaces this one.
    const duplicate = screen.getByRole('button', { name: 'Duplicate Fern' })
    duplicate.focus()
    await user.keyboard('{Enter}')
    const name = await screen.findByDisplayValue('Fern copy')
    await act(async () => { await Promise.resolve() })
    expect(name).toHaveFocus()

    page.unmount()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { await Promise.resolve() })
    expect(document.body).toHaveFocus()
    expect(duplicate).not.toBeInTheDocument()
  })

  it('previews every slider step at once and saves only where the hand settles', async () => {
    const { save } = renderSettings({})
    const contrast = screen.getByRole('slider', { name: 'Contrast' })
    expect(contrast).toHaveAttribute('min', '50')
    expect(contrast).toHaveAttribute('max', '200')
    expect(contrast).toHaveAttribute('step', '5')
    for (const value of ['110', '130', '152']) fireEvent.change(contrast, { target: { value } })
    expect(appearancePreview.effective(DEFAULT_SETTINGS).appearanceContrast).toBe(150)
    expect(save).not.toHaveBeenCalled()
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(save.mock.calls[0]![0]).toEqual({ appearanceContrast: 150 })

    const glass = screen.getByRole('slider', { name: 'Glass opacity' })
    fireEvent.change(glass, { target: { value: '20' } })
    fireEvent.pointerUp(glass)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1]![0]).toEqual({ glassOpacity: 40 })
  })
})
