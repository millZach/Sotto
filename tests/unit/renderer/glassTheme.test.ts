import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OWL_FEATURES, isOwlFeatureEnabled } from '../../../src/shared/owlFeatures'
import { DEFAULT_SETTINGS, parseSettings } from '../../../src/shared/settings'
import { formatOklch, parseThemeColor, rgbToOklch } from '../../../src/shared/themes/color'
import { GLASS_CONTRAST_FLOOR, GLASS_DARK_THEME_COLORS, GLASS_LIGHT_THEME_COLORS, GLASS_THEME_ID, GLASS_TINTS } from '../../../src/shared/themes/glass'
import { widgetPresentationFor } from '../../../src/shared/themeBranding'
import { applyAppearance, useSystemReducesTransparency, type AppearanceChoice } from '../../../src/renderer/src/state/appearance'
import {
  APPEARANCE_CONTRAST,
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  GLASS_THEME,
  THEME_COLOR_ROLES,
  builtInThemesFor,
  parseThemeFile,
  resolveThemeFor,
  savedThemeHalfId,
} from '../../../src/shared/themes/library'
import { PAINTED_TEXT_PAIRS, paintedContrast, withPaintedLayers } from '../../fixtures/renderer/paintedTextPairs'
import { MODES, contrast, over, parseTokenBlocks, resolveColor, rootDeclarations, type Mode, type Rgba } from '../../fixtures/renderer/themeTokenResolver'

const tokenBlocks = parseTokenBlocks(readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8'))

/** Pure white and pure black: the two ends any desktop can show behind the window before the blur softens it. */
const DESKS: ReadonlyArray<readonly [string, Rgba]> = [['white', { r: 255, g: 255, b: 255, a: 1 }], ['black', { r: 0, g: 0, b: 0, a: 1 }]]

/**
 * The tokens of a see-through Glass room with `desk` behind the window. The room's tint is flattened over the desk
 * and stands in for the canvas every painted pair is composited on, so the sidebar, the cards, the user's messages and
 * the selected rows, which are translucent, are judged as they show over that desktop; the solid surfaces cover it.
 */
function glassRoom(mode: Mode, desk: Rgba, contrast = 100): Map<string, string> {
  // Glass paints at the Contrast chosen, but never under its floor (appearance.ts).
  const painted = Math.max(contrast, GLASS_CONTRAST_FLOOR)
  const declarations = withPaintedLayers(rootDeclarations(mode, GLASS_THEME_ID, { glass: true, contrast: painted }, tokenBlocks))
  const room = over(resolveColor('--tt-glass-room', declarations), desk)
  declarations.set('--tt-canvas', formatOklch(rgbToOklch(room)))
  return declarations
}

describe('Glass, the see-through theme (ADR-0149)', () => {
  it('is an Owl feature held from stable', () => {
    expect(OWL_FEATURES.find(feature => feature.id === 'glass-theme')?.sentToStable).toBe(false)
    expect(isOwlFeatureEnabled('glass-theme', 'stable')).toBe(false)
    expect(isOwlFeatureEnabled('glass-theme', 'owl')).toBe(true)
  })

  it('is offered only where the feature is on, and a saved Glass paints Sotto without it', () => {
    expect(BUILT_IN_THEMES.map(theme => theme.id)).not.toContain(GLASS_THEME_ID)
    expect(builtInThemesFor(false)).toBe(BUILT_IN_THEMES)
    expect(builtInThemesFor(true).map(theme => theme.id)).toContain(GLASS_THEME_ID)
    const selection = { lightTheme: GLASS_THEME_ID, darkTheme: GLASS_THEME_ID, customThemes: [] }
    for (const mode of MODES) {
      expect(resolveThemeFor(selection, mode).theme.id).toBe(DEFAULT_THEME_ID)
      expect(resolveThemeFor({ ...selection, glass: false }, mode).theme.id).toBe(DEFAULT_THEME_ID)
      expect(resolveThemeFor({ ...selection, glass: true }, mode).theme).toBe(GLASS_THEME)
    }
  })

  it('keeps a saved Glass whole on every build, and no custom theme may take its id', () => {
    expect(savedThemeHalfId(GLASS_THEME_ID, 'light', [])).toBe(GLASS_THEME_ID)
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, lightTheme: GLASS_THEME_ID, darkTheme: GLASS_THEME_ID })
    expect([parsed.lightTheme, parsed.darkTheme]).toEqual([GLASS_THEME_ID, GLASS_THEME_ID])
    expect(() => parseThemeFile({ version: 1, id: GLASS_THEME_ID, name: 'Mine', appearance: 'light', colors: { canvas: '#ffffff' } })).toThrow(/reserved/u)
  })

  it('has every role in both halves, all of them solid, and translucent tints', () => {
    for (const mode of MODES) {
      const colors = mode === 'light' ? GLASS_THEME.colors : GLASS_THEME.variants!.dark!
      for (const role of THEME_COLOR_ROLES) expect(parseThemeColor(colors[role])?.alpha, `${mode} ${role}`).toBe(1)
      const tints = GLASS_TINTS[mode]
      for (const tint of [tints.room, tints.sidebar, tints.raised, tints.message, tints.rowSelected]) expect(parseThemeColor(tint)!.alpha).toBeLessThan(1)
      for (const stop of tints.backdrop) expect(parseThemeColor(stop)!.alpha).toBe(1)
    }
  })

  const CONTRASTS: number[] = []
  for (let contrast = APPEARANCE_CONTRAST.min; contrast <= APPEARANCE_CONTRAST.max; contrast += APPEARANCE_CONTRAST.step) CONTRASTS.push(contrast)

  it.each(MODES.flatMap(mode => DESKS.map(([name, desk]) => [mode, name, desk] as const)))(
    '%s half keeps every line of words at 4.5:1 with pure %s behind the window, at every Contrast',
    (mode, _name, desk) => {
      for (const contrast of CONTRASTS) {
        const declarations = glassRoom(mode, desk, contrast)
        for (const pair of PAINTED_TEXT_PAIRS) {
          expect(paintedContrast(declarations, pair), `${pair.ink} on ${pair.surface.join(' + ')} (${pair.where}) at ${contrast}%`).toBeGreaterThanOrEqual(4.5)
        }
      }
      const declarations = glassRoom(mode, desk)
      const color = (name: string): Rgba => over(resolveColor(`--tt-${name}`, declarations), resolveColor('--tt-canvas', declarations))
      // The accent as a fill and the focus ring are not words: 3:1 is their bar, on the room and on the sidebar.
      for (const surface of ['canvas', 'sidebar', 'card'] as const) {
        expect(contrast(color('accent'), color(surface)), `accent on ${surface}`).toBeGreaterThanOrEqual(3)
        expect(contrast(color('focus-ring'), color(surface)), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3)
      }
    },
  )

  it('holds Contrast at its floor while Glass paints, and leaves it alone on every other theme', () => {
    const choice: AppearanceChoice = { appearance: 'light', lightTheme: GLASS_THEME_ID, darkTheme: GLASS_THEME_ID, appearanceContrast: 50, effortColor: 'ember', customThemes: [], glass: true }
    const root = document.createElement('html')
    applyAppearance(choice, root, false)
    expect(root.dataset.themeId).toBe(GLASS_THEME_ID)
    expect(root.style.getPropertyValue('--theme-contrast-base')).toBe(`${GLASS_CONTRAST_FLOOR}%`)
    applyAppearance({ ...choice, appearanceContrast: 150 }, root, false)
    expect(root.style.getPropertyValue('--theme-contrast-boost')).toBe('50%')
    applyAppearance({ ...choice, lightTheme: DEFAULT_THEME_ID }, root, false)
    expect(root.dataset.glass).toBeUndefined()
    expect(root.style.getPropertyValue('--theme-contrast-base')).toBe('50%')
  })

  it('dresses the widget in Glass\u2019s solid roles only where the run has Glass', () => {
    const settings = { ...DEFAULT_SETTINGS, lightTheme: GLASS_THEME_ID, darkTheme: GLASS_THEME_ID }
    const owl = widgetPresentationFor(settings, true).palette
    expect([owl.light.canvas, owl.dark.canvas]).toEqual([GLASS_LIGHT_THEME_COLORS.canvas, GLASS_DARK_THEME_COLORS.canvas])
    const stable = widgetPresentationFor(settings, false).palette
    expect([stable.light.canvas, stable.dark.canvas]).toEqual([BUILT_IN_THEMES[0]!.colors.canvas, BUILT_IN_THEMES[0]!.variants!.dark!.canvas])
  })
})

describe('the reduced-transparency listener (ADR-0149)', () => {
  const original = window.matchMedia
  afterEach(() => { window.matchMedia = original })

  it('starts nothing where the run has no Glass, and follows the system where it does', () => {
    const queries: string[] = []
    window.matchMedia = vi.fn((query: string) => {
      queries.push(query)
      return { matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList
    })
    const held = renderHook(() => useSystemReducesTransparency(false))
    expect(held.result.current).toBe(false)
    expect(queries).toEqual([])
    const offered = renderHook(() => useSystemReducesTransparency(true))
    expect(offered.result.current).toBe(true)
    expect(queries).toContain('(prefers-reduced-transparency: reduce)')
  })
})

afterEach(() => { localStorage.clear() })
