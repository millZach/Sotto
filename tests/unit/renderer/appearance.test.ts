import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  APPEARANCE_CACHE_KEY,
  AppearancePreview,
  THEME_PREVIEW_ID,
  applyAppearance,
  readCachedAppearance,
  resolveAppearance,
  systemPrefersDark,
  type AppearanceChoice,
} from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { parseThemeFile, type ThemeDefinition } from '../../../src/shared/themes/library'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const base: AppearanceChoice = {
  appearance: 'dark',
  lightTheme: 'ocean',
  darkTheme: 'ocean',
  appearanceContrast: 100,
  glassOpacity: 80,
  effortColor: 'ember',
  customThemes: [],
}

function aurora(): ThemeDefinition {
  return parseThemeFile({ version: 1, name: 'Aurora', appearance: 'dark', colors: createVividThemeColors('dark', '#101820', '#e0a040') })
}

describe('main-window appearance', () => {
  it('resolves System from the scheme and treats an unknowable scheme as the dark default', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(systemPrefersDark(undefined)).toBe(true)
    expect(systemPrefersDark({ matchMedia: (() => ({ matches: false })) as unknown as Window['matchMedia'] })).toBe(false)
  })

  it('paints the theme that owns the resolved half, as canonical colours only', () => {
    const root = document.createElement('html')
    const custom = aurora()
    const choice: AppearanceChoice = { ...base, appearance: 'system', lightTheme: 'ember', darkTheme: custom.id, customThemes: [custom] }

    expect(applyAppearance(choice, root, true)).toBe('dark')
    expect(root.dataset.themeId).toBe(custom.id)
    expect(root.style.getPropertyValue('--theme-canvas')).toBe(custom.colors.canvas)

    // The system turning light hands the root to the independent light half.
    expect(applyAppearance(choice, root, false)).toBe('light')
    expect(root.dataset.themeId).toBe('ember')
    expect(root.style.getPropertyValue('--theme-canvas')).toMatch(/^oklch\(/u)
    expect(root.style.getPropertyValue('--theme-canvas')).not.toBe(custom.colors.canvas)
  })

  it('writes contrast and glass strengths, clamped to their steps', () => {
    const root = document.createElement('html')
    applyAppearance({ ...base, appearanceContrast: 150, glassOpacity: 45 }, root, true)
    expect(root.style.getPropertyValue('--theme-contrast-base')).toBe('100%')
    expect(root.style.getPropertyValue('--theme-contrast-boost')).toBe('50%')
    expect(root.style.getPropertyValue('--theme-contrast-border-boost')).toBe('12.5%')
    expect(root.style.getPropertyValue('--theme-glass-opacity')).toBe('45%')

    applyAppearance({ ...base, appearanceContrast: 51, glassOpacity: 7 }, root, true)
    expect(root.style.getPropertyValue('--theme-contrast-base')).toBe('50%')
    expect(root.style.getPropertyValue('--theme-contrast-boost')).toBe('0%')
    expect(root.style.getPropertyValue('--theme-glass-opacity')).toBe('40%')
  })

  it('puts the effort colourway on the root as an attribute, and an unknown one falls back to Ember', () => {
    const root = document.createElement('html')
    applyAppearance({ ...base, effortColor: 'cyberpunk' }, root, true)
    expect(root.dataset.effortColor).toBe('cyberpunk')
    expect(readCachedAppearance().effortColor).toBe('cyberpunk')
    applyAppearance({ ...base, effortColor: 'neon' as AppearanceChoice['effortColor'] }, root, true)
    expect(root.dataset.effortColor).toBe('ember')
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ ...base, effortColor: 'neon' }))
    expect(readCachedAppearance().effortColor).toBe('ember')
  })

  it('never writes a colour that is not canonical, so an injected value cannot reach the style', () => {
    const root = document.createElement('html')
    const hostile = { ...aurora(), colors: { ...aurora().colors, canvas: 'red; background: url(https://example.com/x)' } }
    applyAppearance({ ...base, darkTheme: hostile.id, customThemes: [hostile] }, root, true)
    // The bad role is skipped (the stylesheet's colour stays); the valid roles still paint.
    expect(root.style.cssText).not.toContain('url(')
    expect(root.style.getPropertyValue('--theme-canvas')).toBe('')
    expect(root.style.getPropertyValue('--theme-text')).toMatch(/^oklch\(/u)
  })

  it('paints an editor draft over the saved theme without caching it, and the saved look returns without it', () => {
    const root = document.createElement('html')
    const draftColors = createVividThemeColors('light', '#fff8f0', '#c03060')
    applyAppearance(base, root, true)
    const saved = root.style.getPropertyValue('--theme-canvas')

    expect(applyAppearance(base, root, true, { appearance: 'light', colors: draftColors })).toBe('light')
    expect(root.dataset.themeId).toBe(THEME_PREVIEW_ID)
    expect(root.style.getPropertyValue('--theme-canvas')).toBe(draftColors.canvas)
    expect(readCachedAppearance().darkTheme).toBe('ocean')

    applyAppearance(base, root, true, null)
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.themeId).toBe('ocean')
    expect(root.style.getPropertyValue('--theme-canvas')).toBe(saved)
  })

  it('suppresses transitions only when the painted mode or theme changes, for two frames', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const root = document.createElement('html')

    applyAppearance(base, root, true)
    expect(root.dataset.themeSwitching).toBeUndefined()
    applyAppearance({ ...base, appearanceContrast: 120 }, root, true)
    expect(root.dataset.themeSwitching).toBeUndefined()

    applyAppearance({ ...base, darkTheme: 'iris' }, root, true)
    expect(root.dataset.themeSwitching).toBe('')
    frames.shift()!(0)
    expect(root.dataset.themeSwitching).toBe('')
    frames.shift()!(0)
    expect(root.dataset.themeSwitching).toBeUndefined()
  })

  it('caches the applied look with only the selected custom themes, and validates the cache like settings', () => {
    const root = document.createElement('html')
    const custom = aurora()
    const unused = parseThemeFile({ version: 1, name: 'Unused', appearance: 'light', colors: { canvas: '#ffffff' } })
    applyAppearance({ ...base, appearance: 'system', darkTheme: custom.id, glassOpacity: 60, customThemes: [custom, unused] }, root, true)
    const cached = readCachedAppearance()
    expect(cached).toMatchObject({ appearance: 'system', lightTheme: 'ocean', darkTheme: custom.id, glassOpacity: 60 })
    expect(cached.customThemes.map(theme => theme.id)).toEqual([custom.id])

    // A cache that cannot be trusted comes back as the shipped defaults, not as the chosen halves.
    const restored = { ...base, appearance: DEFAULT_SETTINGS.appearance, lightTheme: DEFAULT_SETTINGS.lightTheme, darkTheme: DEFAULT_SETTINGS.darkTheme }
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ appearance: 'sepia', lightTheme: 'missing', darkTheme: 42, appearanceContrast: 999, customThemes: [{ id: 'x' }] }))
    expect(readCachedAppearance()).toEqual({ ...restored, appearanceContrast: 200 })
    localStorage.setItem(APPEARANCE_CACHE_KEY, '{not json')
    expect(readCachedAppearance()).toEqual(restored)
  })

  it('keeps each field of the newest pending choice, settles only matching saves, and drops a saved choice once settings catch up', () => {
    const preview = new AppearancePreview()
    const persisted = { ...DEFAULT_SETTINGS }
    const light = preview.choose({ appearance: 'light' })
    const iris = preview.choose({ lightTheme: 'iris' })
    expect(preview.effective(persisted)).toMatchObject({ appearance: 'light', lightTheme: 'iris', darkTheme: DEFAULT_SETTINGS.darkTheme })

    // An older theme choice is superseded before its save answers.
    const ember = preview.choose({ lightTheme: 'ember' })
    preview.settle(iris, false, persisted)
    expect(preview.effective(persisted)).toMatchObject({ appearance: 'light', lightTheme: 'ember' })

    preview.settle(light, true, persisted)
    const caughtUp = { ...persisted, appearance: 'light' as const }
    expect(preview.effective(caughtUp)).toMatchObject({ appearance: 'light', lightTheme: 'ember' })

    preview.settle(ember, false, caughtUp)
    expect(preview.effective(caughtUp)).toMatchObject({ appearance: 'light', lightTheme: DEFAULT_SETTINGS.lightTheme })
  })

  it('previews a draft separately from pending choices, and a reset clears both', () => {
    const preview = new AppearancePreview()
    const listener = vi.fn()
    const unsubscribe = preview.subscribe(listener)
    const sequence = preview.choose({ glassOpacity: 55 })
    const draft = { appearance: 'dark' as const, colors: createVividThemeColors('dark', '#000000', '#ffffff') }
    preview.setDraft(draft)
    preview.setDraft(draft)
    expect(preview.draft).toBe(draft)
    preview.settle(sequence, true, DEFAULT_SETTINGS)
    preview.settle(sequence + 10, true, DEFAULT_SETTINGS)
    expect(listener).toHaveBeenCalledTimes(3)
    preview.reset()
    expect(preview.draft).toBeNull()
    expect(preview.effective(DEFAULT_SETTINGS).glassOpacity).toBe(80)
    unsubscribe()
    preview.setDraft(null)
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
