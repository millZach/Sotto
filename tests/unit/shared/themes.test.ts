// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { contrastRatio, isCanonicalThemeColor, parseThemeRgb, toCanonicalThemeColor } from '../../../src/shared/themes/color'
import { createVividThemeColors, getDefaultThemeColors } from '../../../src/shared/themes/engine'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  T3_CODE_THEME,
  THEME_COLOR_ROLES,
  canonicalizeTheme,
  customThemeSchema,
  customThemesSchema,
  findTheme,
  getThemeColorsForMode,
  parseCustomThemes,
  parseThemeFile,
  resolveThemeFor,
  resolveThemeHalfId,
  serializeThemeFile,
  uniqueThemeId,
  type ThemeColorRole,
} from '../../../src/shared/themes/library'
import { isVsCodeThemeFile, pairVsCodeThemes, parseVsCodeThemeFile, resolveThemeLabelCollisions } from '../../../src/shared/themes/vscodeImport'

describe('theme colours', () => {
  it('accepts literal CSS colours and writes them in one canonical OKLCH form', () => {
    for (const value of ['#336699', '#369', 'rgb(51 102 153)', 'rgba(51, 102, 153, 1)', 'hsl(210 50% 40%)', 'oklch(0.5 0.1 250)', 'color(srgb 0.2 0.4 0.6)']) {
      const canonical = toCanonicalThemeColor(value)
      expect(canonical, value).toMatch(/^oklch\(/u)
      expect(isCanonicalThemeColor(canonical)).toBe(true)
      expect(toCanonicalThemeColor(canonical)).toBe(canonical)
    }
    expect(toCanonicalThemeColor('#33669980')).toMatch(/ \/ 0\.50\d*\)$/u)
  })

  it('refuses anything that is not a literal colour, so nothing else can reach a style', () => {
    for (const value of [
      'red; background: url(https://evil.example)',
      'url(https://evil.example)',
      'var(--tt-text)',
      'expression(alert(1))',
      'oklch(0.5 0.1 250) ; color: red',
      'color-mix(in oklab, red, blue)',
      'currentColor',
      '',
      42,
      null,
      '#'.padEnd(300, 'f'),
    ]) {
      expect(toCanonicalThemeColor(value), String(value)).toBeNull()
      expect(isCanonicalThemeColor(value)).toBe(false)
    }
    // Canonical is exact: a colour that parses but is not in stored form is not accepted as stored.
    expect(isCanonicalThemeColor('oklch(0.5 0.1 250)')).toBe(toCanonicalThemeColor('oklch(0.5 0.1 250)') === 'oklch(0.5 0.1 250)')
    expect(isCanonicalThemeColor('#336699')).toBe(false)
  })
})

describe('built-in themes', () => {
  it('ships Sotto and its five companions in picker order, each with every role in both halves', () => {
    expect(BUILT_IN_THEMES.map(theme => theme.id)).toEqual(['t3-code', 'hush', 'linen', 'nocturne', 'tropic', 'citrine'])
    expect(DEFAULT_THEME_ID).toBe('t3-code')
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = mode === theme.appearance ? theme.colors : theme.variants?.[mode]
        expect(colors, `${theme.id} ${mode}`).toBeDefined()
        for (const role of THEME_COLOR_ROLES) expect(isCanonicalThemeColor(colors![role]), `${theme.id} ${mode} ${role}`).toBe(true)
      }
    }
  })

  it('gives the built-ins Sotto names, once each, and carries no T3 name', () => {
    expect(BUILT_IN_THEMES.map(theme => [theme.id, theme.label])).toEqual([
      ['t3-code', 'Sotto'], ['hush', 'Hush'], ['linen', 'Linen'], ['nocturne', 'Nocturne'], ['tropic', 'Tropic'], ['citrine', 'Citrine'],
    ])
    const labels = BUILT_IN_THEMES.map(theme => theme.label.toLowerCase())
    expect(new Set(labels).size).toBe(labels.length)
    for (const t3Name of ['t3 code', 't3 chat', 'grove', 'ocean', 'ember', 'iris']) expect(labels).not.toContain(t3Name)
  })

  it('wears the app icon’s teal on Sotto’s dark half', () => {
    expect(getThemeColorsForMode(T3_CODE_THEME, 'dark')!.accent).toBe(toCanonicalThemeColor('#47b8a9'))
  })

  it('keeps every foreground readable on the surface it sits on, in both halves of every built-in', () => {
    // The pairs a user reads as text: 4.5:1 is the bar ADR-0011 sets for body copy.
    const pairs = [
      ['text', 'canvas'], ['text', 'surface'], ['text', 'surfaceRaised'],
      ['textMuted', 'canvas'], ['textMuted', 'surface'],
      ['sidebarForeground', 'sidebar'], ['sidebarMutedForeground', 'sidebar'],
      ['messageForeground', 'messageSurface'],
      ['accentForeground', 'accent'],
      ['messageActionForeground', 'messageAction'],
      ['accentSurfaceForeground', 'accentSurface'],
      ['codeForeground', 'codeBackground'],
      ['mutedForeground', 'muted'],
      ['secondaryForeground', 'secondary'],
      ['updateForeground', 'updateSurface'],
      ['toolbarForeground', 'toolbar'],
      ['placeholder', 'surfaceRaised'],
    ] as const satisfies ReadonlyArray<readonly [ThemeColorRole, ThemeColorRole]>

    for (const theme of BUILT_IN_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const colors = getThemeColorsForMode(theme, mode)!
        // A translucent role is seen over the canvas, and a foreground over the surface it sits on.
        const canvas = parseThemeRgb(colors.canvas, { r: 0, g: 0, b: 0 })
        for (const [foreground, background] of pairs) {
          const behind = parseThemeRgb(colors[background], canvas)
          const ratio = contrastRatio(parseThemeRgb(colors[foreground], behind), behind)
          expect(ratio, `${theme.id} ${mode} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('paints each half from the theme that can render it, falling back to Sotto', () => {
    const lightOnly = parseThemeFile({ version: 1, name: 'Paper', appearance: 'light', colors: { canvas: '#fffaf0' } })
    const selection = { lightTheme: lightOnly.id, darkTheme: lightOnly.id, customThemes: [lightOnly] }
    expect(resolveThemeFor(selection, 'light').theme.id).toBe(lightOnly.id)
    expect(resolveThemeFor(selection, 'dark').theme.id).toBe('t3-code')
    expect(resolveThemeFor({ lightTheme: 'missing', darkTheme: 'citrine', customThemes: [] }, 'light').colors).toEqual(T3_CODE_THEME.variants?.light ?? T3_CODE_THEME.colors)
  })

  it('sends a half saved on a retired T3 built-in back to Sotto and frees its id, while T3’s aliases stay reserved', () => {
    for (const retired of ['t3-chat', 'grove', 'ocean', 'ember', 'iris']) {
      expect(findTheme(retired, []), retired).toBeNull()
      expect(resolveThemeHalfId(retired, 'dark', []), retired).toBe(DEFAULT_THEME_ID)
      expect(uniqueThemeId(retired, new Set()), retired).toBe(retired)
    }
    for (const alias of ['t3-chat-dark', 't3-grove', 't3-ocean', 't3-ember', 't3-iris']) {
      expect(uniqueThemeId(alias, new Set()), alias).toBe(`${alias}-2`)
    }
  })
})

describe('theme files', () => {
  it('round-trips a theme file through export and import', () => {
    const theme = parseThemeFile({
      version: 1,
      name: 'Harbor',
      appearance: 'dark',
      colors: createVividThemeColors('dark', '#102a33', '#3fb6a8'),
      variants: { light: createVividThemeColors('light', '#f4fbfa', '#1f7f75') },
    })
    const reimported = parseThemeFile(JSON.parse(serializeThemeFile(theme)))
    expect(reimported).toEqual(theme)
    expect(customThemeSchema.safeParse(canonicalizeTheme(reimported)).success).toBe(true)
  })

  it('explains every way a theme file can be invalid', () => {
    const valid = { version: 1, name: 'Harbor', appearance: 'dark', colors: { canvas: '#102a33' } }
    const cases: Array<[unknown, RegExp]> = [
      [[], /JSON object/u],
      [{ ...valid, version: 2 }, /unsupported version/u],
      [{ ...valid, name: '' }, /need a name/u],
      [{ ...valid, name: 'x'.repeat(49) }, /48 characters/u],
      [{ ...valid, appearance: 'sepia' }, /appearance/u],
      [{ ...valid, colors: 'red' }, /colors object/u],
      [{ ...valid, colors: {} }, /at least one color/u],
      [{ ...valid, colors: { canvas: 'url(x)' } }, /literal CSS color/u],
      [{ ...valid, colors: { 'background-image': '#fff' } }, /not a supported theme color role/u],
      [{ ...valid, id: 'Bad Id' }, /lowercase/u],
      [{ ...valid, id: 'nocturne' }, /reserved/u],
      [{ ...valid, id: 't3-ocean' }, /reserved/u],
      [{ ...valid, name: 'Light' }, /reserved/u],
      [{ ...valid, variants: { dark: { canvas: '#000' } } }, /repeat the base appearance/u],
      [{ ...valid, variants: { sepia: { canvas: '#000' } } }, /light" or "dark/u],
      [{ ...valid, collection: { id: '' } }, /collections/u],
    ]
    for (const [value, message] of cases) expect(() => parseThemeFile(value), JSON.stringify(value)).toThrow(message)
  })

  it('reads a saved library leniently but stores it strictly, without duplicates or overflow', () => {
    const theme = canonicalizeTheme(parseThemeFile({ version: 1, name: 'Harbor', appearance: 'dark', colors: { canvas: '#102a33' } }))
    const parsed = parseCustomThemes([theme, { ...theme }, { id: 'nocturne', label: 'Nocturne', appearance: 'dark', colors: {} }, 'junk', { ...theme, id: 'other', colors: { ...theme.colors, canvas: 'url(x)', extra: '#fff' } }])
    expect(parsed.map(entry => entry.id)).toEqual([theme.id, 'other'])
    expect(parsed[1]!.colors.canvas).toBe(getDefaultThemeColors('dark').canvas)
    expect(customThemesSchema.safeParse([theme, theme]).success).toBe(false)
    expect(customThemeSchema.safeParse({ ...theme, colors: { ...theme.colors, canvas: '#102a33' } }).success).toBe(false)
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 5 }, (_, index) => ({ ...theme, id: `t-${index}` }))
    expect(parseCustomThemes(many)).toHaveLength(MAX_CUSTOM_THEMES)
    expect(customThemesSchema.safeParse(many).success).toBe(false)
  })

  it('numbers ids that are taken or reserved', () => {
    expect(uniqueThemeId('harbor', new Set())).toBe('harbor')
    expect(uniqueThemeId('harbor', new Set(['harbor', 'harbor-2']))).toBe('harbor-3')
    expect(uniqueThemeId('nocturne', new Set())).toBe('nocturne-2')
  })
})

describe('VS Code theme import', () => {
  const dracula = {
    name: 'Dracula',
    type: 'dark',
    colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', focusBorder: '#6272a4', 'button.background': '#44475a', 'sideBar.background': '#21222c' },
    tokenColors: [],
  }

  it('recognises a VS Code theme and builds a readable palette from its workbench colours', () => {
    expect(isVsCodeThemeFile(dracula)).toBe(true)
    expect(isVsCodeThemeFile({ version: 1, name: 'x', appearance: 'dark', colors: { canvas: '#000' } })).toBe(false)
    const theme = parseVsCodeThemeFile(dracula)
    expect(theme).toMatchObject({ id: 'dracula', label: 'Dracula', appearance: 'dark' })
    expect(theme.colors.canvas).toBe(toCanonicalThemeColor('#282a36'))
    const rgb = (value: string) => parseThemeRgb(value, { r: 0, g: 0, b: 0 })
    expect(contrastRatio(rgb(theme.colors.text), rgb(theme.colors.canvas))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(rgb(theme.colors.sidebarForeground), rgb(theme.colors.sidebar))).toBeGreaterThanOrEqual(4.5)
  })

  it('replaces an unreadable foreground and rejects a theme with no editor background', () => {
    const unreadable = parseVsCodeThemeFile({ name: 'Murky', colors: { 'editor.background': '#202020', 'editor.foreground': '#222222' } })
    const rgb = (value: string) => parseThemeRgb(value, { r: 0, g: 0, b: 0 })
    expect(contrastRatio(rgb(unreadable.colors.text), rgb(unreadable.colors.canvas))).toBeGreaterThanOrEqual(4.5)
    expect(unreadable.appearance).toBe('dark')
    expect(() => parseVsCodeThemeFile({ name: 'Empty', colors: { 'sideBar.background': '#000000' } })).toThrow(/editor.background/u)
  })

  it('pairs light and dark files of one family and relabels colliding names from their files', () => {
    const light = parseVsCodeThemeFile({ name: 'Harbor Light', type: 'light', colors: { 'editor.background': '#f4fbfa' } })
    const dark = parseVsCodeThemeFile({ name: 'Harbor Dark', type: 'dark', colors: { 'editor.background': '#102a33' } })
    const other = parseVsCodeThemeFile({ name: 'Solo', colors: { 'editor.background': '#000000' } })
    const paired = pairVsCodeThemes([light, other, dark])
    expect(paired.map(theme => [theme.label, theme.appearance, Object.keys(theme.variants ?? {})])).toEqual([['Harbor', 'light', ['dark']], ['Solo', 'dark', []]])

    const soft = parseVsCodeThemeFile({ name: 'Dracula', colors: { 'editor.background': '#303241' } })
    const labels = resolveThemeLabelCollisions([
      { theme: parseVsCodeThemeFile(dracula), sourceName: 'dracula.json' },
      { theme: soft, sourceName: 'dracula-soft.json' },
    ]).map(theme => theme.label)
    expect(labels).toEqual(['Dracula', 'Dracula Soft'])
  })
})
