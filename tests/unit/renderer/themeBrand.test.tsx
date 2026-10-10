import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SottoMark } from '../../../src/renderer/src/components/SottoMark'
import { applyAppearance, type AppearanceChoice } from '../../../src/renderer/src/state/appearance'
import { APP_ICON_BRAND, themeBrand } from '../../../src/shared/themeBranding'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, getThemeColorsForMode, parseThemeFile, type ThemeDefinition } from '../../../src/shared/themes/library'
import type { ThemeAppearance } from '../../../src/shared/themes/palettes'

const choice = (patch: Partial<AppearanceChoice> = {}): AppearanceChoice => ({
  appearance: 'dark', lightTheme: 'nocturne', darkTheme: 'nocturne', appearanceContrast: 100, glassOpacity: 80, frostedWindow: false, frostSeeThrough: 40, effortColor: 'ember', customThemes: [], ...patch,
})

function builtIn(id: string, mode: ThemeAppearance) {
  return getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === id)!, mode)!
}

function custom(): ThemeDefinition {
  return parseThemeFile({ version: 1, id: 'saffron', name: 'Saffron', appearance: 'light', colors: createVividThemeColors('light', '#fbf7ee', '#c0392b') })
}

function paint(next: AppearanceChoice, draft: Parameters<typeof applyAppearance>[3] = null): void {
  act(() => { applyAppearance(next, document.documentElement, true, draft) })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})

afterEach(() => {
  cleanup()
  const root = document.documentElement
  root.removeAttribute('style')
  delete root.dataset.theme
  delete root.dataset.themeId
  delete root.dataset.brand
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('SottoMark in the main window', () => {
  it('wears the painted theme and follows selection, mode, custom themes and editor drafts live', async () => {
    paint(choice())
    const { container } = render(<SottoMark />)
    const svg = container.querySelector('svg')!
    const expectBrand = async (colors: Parameters<typeof themeBrand>[0], mode: ThemeAppearance) => {
      const brand = themeBrand(colors, mode)
      await waitFor(() => expect(svg).toHaveAttribute('data-tile', brand.tile))
      expect(svg.querySelector('rect')).toHaveAttribute('fill', brand.tile)
      expect(svg.querySelector('path[fill-rule="evenodd"]')).toHaveAttribute('fill', brand.glyph)
      expect([...svg.querySelectorAll('circle')].map(circle => circle.getAttribute('fill'))).toEqual([brand.glyph, brand.glyph])
    }
    await expectBrand(builtIn('nocturne', 'dark'), 'dark')

    paint(choice({ darkTheme: 'tropic' }))
    await expectBrand(builtIn('tropic', 'dark'), 'dark')

    paint(choice({ appearance: 'light', lightTheme: 'citrine' }))
    await expectBrand(builtIn('citrine', 'light'), 'light')

    const saffron = custom()
    paint(choice({ appearance: 'light', lightTheme: saffron.id, customThemes: [saffron] }))
    await expectBrand(saffron.colors, 'light')

    // An unsaved editor draft repaints the root, and the mark with it.
    const draft = { appearance: 'dark' as const, colors: createVividThemeColors('dark', '#0b1a12', '#2ecc71') }
    paint(choice(), draft)
    await expectBrand(draft.colors, 'dark')
    // Geometry is untouched.
    expect(svg.querySelector('rect')).toHaveAttribute('rx', '22')
  })

  it('wears a brand override instead of the window theme when one is given', async () => {
    paint(choice())
    const override = { tile: '#112233', glyph: '#eeddcc' }
    const { container } = render(<SottoMark brand={override} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('data-tile', override.tile)
    expect(svg).toHaveAttribute('data-glyph', override.glyph)
    expect(svg.querySelector('rect')).toHaveAttribute('fill', override.tile)
    expect(svg.querySelector('path[fill-rule="evenodd"]')).toHaveAttribute('fill', override.glyph)
    expect([...svg.querySelectorAll('circle')].every(circle => circle.getAttribute('fill') === override.glyph)).toBe(true)

    // The window's own theme changing afterward leaves the override painted.
    paint(choice({ darkTheme: 'tropic' }))
    await act(async () => undefined)
    expect(svg).toHaveAttribute('data-tile', override.tile)
  })

  it('wears the app icon itself on the default theme, in both modes', async () => {
    paint(choice({ darkTheme: DEFAULT_THEME_ID, lightTheme: DEFAULT_THEME_ID }))
    const { container } = render(<SottoMark />)
    const svg = container.querySelector('svg')!
    for (const mode of ['dark', 'light'] as const) {
      paint(choice({ appearance: mode, darkTheme: DEFAULT_THEME_ID, lightTheme: DEFAULT_THEME_ID }))
      await waitFor(() => expect(svg).toHaveAttribute('data-tile', APP_ICON_BRAND.tile))
      expect(svg).toHaveAttribute('data-glyph', APP_ICON_BRAND.glyph)
    }

    // Any other theme hands the mark back to its own accent, which the light default is not.
    paint(choice({ appearance: 'light', lightTheme: 'citrine' }))
    const citrine = themeBrand(builtIn('citrine', 'light'), 'light')
    await waitFor(() => expect(svg).toHaveAttribute('data-tile', citrine.tile))
    expect(citrine.tile).not.toBe(APP_ICON_BRAND.tile)
  })
})
