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
import { PAINTED_TEXT_PAIRS, paintedContrast, placeholderApartFromText, withPaintedLayers } from '../../fixtures/renderer/paintedTextPairs'

const entries = Object.entries(fixtures.themes)
const blocks = parseTokenBlocks(readFileSync('src/renderer/src/styles/tokens.css', 'utf8'))
const widgetBlocks = parseTokenBlocks(readFileSync('src/renderer/src/widget/widget-tokens.css', 'utf8'))
const changesBlocks = parseTokenBlocks(readFileSync('src/renderer/src/tools/changes.css', 'utf8'))
const rgb = (value: string) => parseThemeRgb(value, { r: 0, g: 0, b: 0 })

describe('Omarchy M3 and readability check', () => {
  it('covers all 22 stock palettes rendered by Omarchy from this exact template', () => {
    expect(entries).toHaveLength(22)
    expect(createHash('sha256').update(readFileSync('apps/omarchy/sotto.json.tpl')).digest('hex')).toBe(fixtures.templateSha256)
  })
  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/share/omarchy/bin/omarchy-theme-set-templates'))('renders every installed stock theme with Omarchy itself in an isolated HOME', () => {
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
    // threadSidebar.css paints --tt-hover over the sidebar, rather than using
    // the opaque sidebarRowHover role. Both selected and hovered rows keep timestamps.
    const hoveredSidebar = over(resolveColor('--tt-hover', declarations), color('sidebar'))
    for (const ink of ['text-muted', 'text-2']) {
      for (const [surface, background] of [
        ['selected sidebar row', color('sidebar-row-selected')],
        ['hovered sidebar row', hoveredSidebar], ['message bubble', color('bubble')],
      ] as const) {
        expect(contrast(color(ink), background), `${name}: ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // Changes preserves each line's tint beneath its hover or selection image.
    // Read the selection wash from the stylesheet so this covers the real 22% fill.
    const picked = changesBlocks.find(block => block.selectors.includes('.changes-diff__rows') && block.declarations.has('--changes-picked'))!.declarations.get('--changes-picked')!
    declarations.set('--changes-picked', picked)
    for (const base of ['code-bg', 'diff-add', 'diff-remove']) {
      const background = color(base)
      const inks = ['text', 'text-muted', 'text-2', 'code-text', ...(base === 'diff-add' ? ['success'] : base === 'diff-remove' ? ['error-text'] : [])]
      for (const wash of ['none', '--tt-hover', '--changes-picked']) {
        const surface = wash === 'none' ? background : over(resolveColor(wash, declarations), background)
        const pixel = { r: Math.round(surface.r), g: Math.round(surface.g), b: Math.round(surface.b), a: 1 }
        for (const ink of inks) {
          expect(contrast(color(ink), surface), `${name}: ${ink} on ${base} with ${wash}`).toBeGreaterThanOrEqual(4.5)
          expect(contrast(color(ink), pixel), `${name}: ${ink} on the painted ${base} with ${wash}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    expect(contrast(color('focus-ring'), color('canvas'))).toBeGreaterThanOrEqual(3)
    // The pairs the window really paints, which every built-in half meets too (themeTokens.test.ts).
    const painted = withPaintedLayers(rootDeclarations(theme.appearance, DEFAULT_THEME_ID, { colors: theme.colors }, blocks))
    painted.set('--tt-success', omarchySuccessText(theme.colors, theme.appearance))
    for (const pair of PAINTED_TEXT_PAIRS) {
      expect(paintedContrast(painted, pair), `${name}: ${pair.ink} on ${pair.surface.join(' + ')} (${pair.where})`).toBeGreaterThanOrEqual(4.5)
    }
    // The muted foreground can be lifted to the body text for Changes, but the composer's placeholder still reads as a
    // hint: dimmer than typed text, not the same ink.
    expect(placeholderApartFromText(painted), `${name}: placeholder against typed text`).toBeGreaterThanOrEqual(1.2)
  })
  it.each(entries)('%s keeps widget status text readable through the widget token projection', (name, fixture) => {
    const theme = parseOmarchyTheme(fixture.rendered, name)
    const declarations = rootDeclarations(theme.appearance, DEFAULT_THEME_ID, { colors: theme.colors }, widgetBlocks)
    const canvas = resolveColor('--tt-canvas', declarations)
    const color = (token: string) => over(resolveColor(`--tt-${token}`, declarations), canvas)
    // Pasted/Copied use primary here; the main window uses primary only for heading glyphs.
    for (const ink of ['text', 'text-muted', 'primary', 'error']) for (const surface of ['canvas', 'surface', 'surface-elevated', 'surface-sunken']) {
      expect(contrast(color(ink), color(surface)), `${name}: widget ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
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
    expect(widgetPresentationFor(settings, false).theme).toBe('light')
    expect(resolveThemeFor({ ...settings, omarchyTheme: null }, 'light').theme.id).toBe(DEFAULT_THEME_ID)
  })
  it.each(['Windows', 'macOS'])('%s keeps its defaults and six palettes, ignoring any persisted Omarchy state', () => {
    const settings = parseSettings({ lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID, omarchyTheme: parseOmarchyTheme(fixtures.themes.hackerman.rendered) })
    expect(settings.lightTheme).toBe(DEFAULT_THEME_ID)
    expect(settings.darkTheme).toBe(DEFAULT_THEME_ID)
    expect(settings.appearance).toBe('dark')
    expect(settings).not.toHaveProperty('omarchyTheme')
    expect(BUILT_IN_THEMES).toHaveLength(6)
    // Pin all twelve shipped halves and their token projection; the Linux repair
    // must never change Windows/macOS palettes. They last changed on purpose for
    // #936, which needed new design baselines on Windows, and then when Graphite, Clay and Fern replaced Linen,
    // Nocturne and Tropic (ADR-0024, October 26, 2026 amendment). The token file last changed when glass turned solid and
    // the frost tokens went (ADR-0084), then when OpenCode's mark got its own token (ADR-0087), and then when Usage's
    // split chart got its series colours (ADR-0083), when the Owl night sky's switch colours went with Terminal mode's
    // switch (ADR-0111), and then when containers became cards, the segmented controls got their raised segment, the
    // pill radius went and three chart series moved a step (ADR-0110), and then when Settings → Providers put each
    // mark on a badge, which gave Muse and OpenCode's badge a colour of their own, and when Cursor's mark and badge got
    // theirs (ADR-0128), and when the light crossing a running turn's working words got a colour of its own (ADR-0134,
    // October 25 amendment), and when DeepSeek's mark got its badge colour, and when the effort trace's halo got its
    // strength for dark and light rooms (ADR-0019, October 26 amendment), and when the Appearance preview could paint a
    // half of its own (`[data-theme-scope]`), and when the Glass theme's see-through tokens and the card's
    // solid colour arrived (ADR-0150), and when the collapsed rail's trays got their group colours (ADR-0146, October 28 amendment),
    // and when text sizes and corners got their scale of `--tt-type-*` and `--tt-radius-*` steps (ADR-0169), and when the
    // prompt's placeholder got its hint tier, `--tt-text-hint`, from the theme's Muted text role, mixed with the room on Glass
    // (October 31, 2026), when High Contrast began lifting that hint at half strength (November 1, 2026), and when Mark up
    // took its red and amber inks, `--tt-ink-red` and `--tt-ink-amber`, from the theme's error and warning colours at full
    // strength (November 1, 2026); none of them changes a palette.
    expect(createHash('sha256').update(JSON.stringify(BUILT_IN_THEMES)).digest('hex')).toBe('5e43d8dae0a93190f59afd80f75f3400076c21aa2cb023b1aec0f8348ca8aac1')
    const tokenText = readFileSync('src/renderer/src/styles/tokens.css', 'utf8').replace(/\r\n/gu, '\n')
    const tokenHash = createHash('sha256').update(tokenText).digest('hex')
    expect(tokenHash, `tokens.css changed. If that was meant and no palette moved, update the pin to ${tokenHash} and say why above`).toBe('fe0e772623c5cb5166df60e08a771946b82451a49240659b8a6acff0ab3eea49')
    // Existing Windows and macOS imports named Omarchy remain user themes.
    expect(parseCustomThemes([{ ...parseOmarchyTheme(fixtures.themes.hackerman.rendered), id: 'omarchy' }])[0]?.id).toBe('omarchy')
  })
})
