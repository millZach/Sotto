// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The fixture generator is a plain Node tool.
import { renderOmarchyStockThemes } from '../../../scripts/render-omarchy-theme-fixtures.mjs'
import fixtures from '../../fixtures/omarchy-themes.json'
import { DEFAULT_SETTINGS, parseSettings } from '../../../src/shared/settings'
import { widgetPaletteFor, widgetPresentationFor } from '../../../src/shared/themeBranding'
import { contrastRatio, parseThemeRgb, toCanonicalThemeColor } from '../../../src/shared/themes/color'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, resolveThemeFor, parseCustomThemes } from '../../../src/shared/themes/library'
import { OMARCHY_THEME_ID, OMARCHY_TEXT_PAIRS, guardOmarchyColors, omarchySuccessText, parseOmarchyTheme, readableOmarchyMix } from '../../../src/shared/themes/omarchy'
import { OMARCHY_CSS_TEXT_PAIRS, OMARCHY_GRAPHIC_COLOR_TOKENS } from '../../fixtures/renderer/omarchyTextSurfaces'
import { parseTokenBlocks, rootDeclarations, resolveColor, contrast, over } from '../../fixtures/renderer/themeTokenResolver'

const entries = Object.entries(fixtures.themes)
const blocks = parseTokenBlocks(readFileSync('src/renderer/src/styles/tokens.css', 'utf8'))
const rgb = (value: string) => parseThemeRgb(value, { r: 0, g: 0, b: 0 })

describe('Omarchy M3 and readability check', () => {
  it('covers all 22 stock palettes rendered by Omarchy from this exact template', () => {
    expect(entries).toHaveLength(22)
    expect(createHash('sha256').update(readFileSync('apps/omarchy/sotto.json.tpl')).digest('hex')).toBe(fixtures.templateSha256)
  })
  it.skipIf(!existsSync('/usr/share/omarchy/bin/omarchy-theme-set-templates'))('renders every installed stock theme with Omarchy itself in an isolated HOME', () => {
    expect(renderOmarchyStockThemes()).toEqual(fixtures)
  })
  it.each(entries)('%s reads on every role and painted text surface', (name, fixture) => {
    const theme = parseOmarchyTheme(fixture.rendered, name)
    for (const pair of OMARCHY_TEXT_PAIRS) for (const surface of pair.surfaces) {
      expect(contrastRatio(rgb(theme.colors[pair.foreground]), rgb(theme.colors[surface])), `${pair.foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    const declarations = rootDeclarations(theme.appearance, DEFAULT_THEME_ID, { colors: theme.colors }, blocks)
    const canvas = resolveColor('--tt-canvas', declarations)
    const color = (token: string) => over(resolveColor(`--tt-${token}`, declarations), canvas)
    declarations.set('--tt-success', omarchySuccessText(theme.colors, theme.appearance))
    declarations.set('--tt-diff-add', 'color-mix(in srgb, var(--tt-success) 12%, var(--tt-code-bg))')
    declarations.set('--tt-diff-remove', 'color-mix(in srgb, var(--tt-error) 12%, var(--tt-code-bg))')
    declarations.set('--tt-diff-hunk', 'color-mix(in srgb, var(--tt-accent) 14%, var(--tt-code-bg))')
    declarations.set('--tt-danger-hover', 'color-mix(in srgb, var(--tt-error) 86%, var(--tt-canvas))')
    for (const [ink, surfaces] of OMARCHY_CSS_TEXT_PAIRS) for (const surface of surfaces) {
      expect(contrast(color(ink), color(surface)), `${name}: ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color('focus-ring'), color('canvas'))).toBeGreaterThanOrEqual(3)
  })
  it('accounts for every --tt token used as color in the main and widget stylesheets', () => {
    const covered = new Set([...OMARCHY_CSS_TEXT_PAIRS.map(([ink]) => ink), ...OMARCHY_GRAPHIC_COLOR_TOKENS])
    const visit = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = `${path}/${entry.name}`
        if (entry.isDirectory()) visit(file)
        else if (file.endsWith('.css')) {
          const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
          for (const declaration of css.matchAll(/(?<![-\w])color\s*:\s*([^;}]+)/gu)) {
            for (const [token] of declaration[1]!.matchAll(/--tt-[\w-]+/gu)) expect(covered.has(token.slice(5)), `${file}: ${token}`).toBe(true)
          }
        }
      }
    }
    visit('src/renderer/src')
  })
  it('uses the first whole percent that reads, including a no-op and an impossible mix', () => {
    const amount = readableOmarchyMix('#666666', '#ffffff', color => contrastRatio(rgb(color), rgb('#333333')))
    expect(amount).toBeGreaterThan(0)
    const channel = Math.round(102 + (255 - 102) * amount! / 100)
    const previous = Math.round(102 + (255 - 102) * (amount! - 1) / 100)
    expect(contrastRatio({r:channel,g:channel,b:channel},rgb('#333333'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio({r:previous,g:previous,b:previous},rgb('#333333'))).toBeLessThan(4.5)
    expect(readableOmarchyMix('#ffffff', '#ffffff', color => contrastRatio(rgb(color), rgb('#000000')))).toBe(0)
    expect(readableOmarchyMix('#222222', '#333333', () => 1)).toBeNull()
  })
  it('keeps red and amber meaningful and replaces a status needing over 35 percent', () => {
    const hacker = parseOmarchyTheme(fixtures.themes.hackerman.rendered)
    const own = resolveThemeFor(DEFAULT_SETTINGS, 'dark').colors
    expect(hacker.colors.error).toBe(toCanonicalThemeColor(own.error))
    expect(hacker.colors.warning).toBe(toCanonicalThemeColor(own.warning))
    const raw = structuredClone(fixtures.themes['tokyo-night'].rendered)
    raw.colors.error = '#300000'
    expect(parseOmarchyTheme(raw).colors.error).toBe(toCanonicalThemeColor(own.error))
  })
  it.each([
    ['error', '#e35e00', '#e35c00'],
    ['warning', '#908100', '#8b8200'],
  ] as const)('%s keeps 35%% and falls back at 36%%', (kind, at35, at36) => {
    const raw = structuredClone(fixtures.themes['tokyo-night'].rendered)
    const score = (color: string): number => Math.min(...['canvas', 'surface', 'sidebar'].map(surface =>
      contrastRatio(rgb(color), rgb(raw.colors[surface as keyof typeof raw.colors])),
    ))
    expect(readableOmarchyMix(at35, raw.colors.text, score)).toBe(35)
    expect(readableOmarchyMix(at36, raw.colors.text, score)).toBe(36)
    raw.colors[kind] = at35
    expect(guardOmarchyColors(raw.colors, 'dark')[kind]).toBe(toCanonicalThemeColor(at35))
    raw.colors[kind] = at36
    expect(guardOmarchyColors(raw.colors, 'dark')[kind]).toBe(toCanonicalThemeColor(resolveThemeFor(DEFAULT_SETTINGS, 'dark').colors[kind]))
  })
  it('rejects partial, unresolved, injected, translucent and unreadable palettes', () => {
    for (const change of [{ text: '{{ foreground }}' }, { text: 'url(secret)' }, { text: '#ffffff00' }, { text: '#222222', canvas: '#222222', sidebar: '#ffffff' }]) {
      const raw = structuredClone(fixtures.themes['tokyo-night'].rendered)
      Object.assign(raw.colors, change)
      expect(() => parseOmarchyTheme(raw)).toThrow()
    }
    expect(() => parseOmarchyTheme({ version: 1, id: 'omarchy', name: 'Omarchy', appearance: 'dark', colors: {} })).toThrow()
  })
  it('preserves waiting Linux selections, resolves only the matching half, and follows in the widget', () => {
    const theme = parseOmarchyTheme(fixtures.themes['catppuccin-latte'].rendered)
    const settings = { ...parseSettings({ lightTheme:OMARCHY_THEME_ID, darkTheme:OMARCHY_THEME_ID }, DEFAULT_SETTINGS, true), omarchyTheme: theme }
    expect(settings.darkTheme).toBe(OMARCHY_THEME_ID)
    expect(resolveThemeFor(settings, 'light').theme.id).toBe(OMARCHY_THEME_ID)
    expect(resolveThemeFor(settings, 'dark').theme.id).toBe(DEFAULT_THEME_ID)
    expect(widgetPaletteFor(settings).light.canvas).toBe(theme.colors.canvas)
    expect(widgetPresentationFor(settings).theme).toBe('light')
    expect(resolveThemeFor({ ...settings, omarchyTheme: null }, 'light').theme.id).toBe(DEFAULT_THEME_ID)
  })
  it.each(['Windows', 'macOS'])('%s keeps its defaults and six palettes, ignoring any persisted Omarchy state', () => {
    const settings = parseSettings({ lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID, omarchyTheme: parseOmarchyTheme(fixtures.themes.hackerman.rendered) })
    expect(settings.lightTheme).toBe(DEFAULT_THEME_ID)
    expect(settings.darkTheme).toBe(DEFAULT_THEME_ID)
    expect(settings.appearance).toBe('dark')
    expect(settings).not.toHaveProperty('omarchyTheme')
    expect(BUILT_IN_THEMES).toHaveLength(6)
    // Existing Windows and macOS imports named Omarchy remain user themes.
    expect(parseCustomThemes([{ ...parseOmarchyTheme(fixtures.themes.hackerman.rendered), id: 'omarchy' }])[0]?.id).toBe('omarchy')
  })
})
