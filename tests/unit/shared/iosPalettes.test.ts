// @vitest-environment node
/*
 * The iPhone paints Sotto's six built-in palettes (ADR-0051). Its Swift copy,
 * apps/ios/Sotto/ThemePalettes.swift, is generated from the desktop's own
 * definitions here, so the two cannot drift: this test rebuilds the Swift
 * source and fails when the committed file differs.
 *
 * Regenerate after changing a palette:
 *   SOTTO_WRITE_IOS_PALETTES=1 npx vitest run tests/unit/shared/iosPalettes.test.ts
 *
 * Besides the desktop's roles, each swatch carries four text colours the
 * iPhone derives: muted, accent, warning and danger text that keep 4.5:1 on
 * every surface the iPhone puts them on, including the cards and pills it tints
 * with the accent, the warning or the danger colour, and the wash at the top
 * of a page. The tints below are the ones the Swift design system paints
 * (apps/ios/Sotto/Design.swift); change them together.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { contrastRatio, mixRgb, oklchToRgb, parseThemeColor, rgbToOklch, type ThemeRgb } from '../../../src/shared/themes/color'
import { BUILT_IN_THEMES, getThemeColorsForMode } from '../../../src/shared/themes/library'
import type { ThemeAppearance, ThemeColorRole, ThemeColors } from '../../../src/shared/themes/palettes'

const SWIFT_FILE = fileURLToPath(new URL('../../../apps/ios/Sotto/ThemePalettes.swift', import.meta.url))
const REGENERATE = 'SOTTO_WRITE_IOS_PALETTES=1 npx vitest run tests/unit/shared/iosPalettes.test.ts'

/** The desktop roles the iPhone reads, in the order the Swift struct declares them. */
const ROLES = [
  'canvas', 'surface', 'surfaceRaised', 'surfaceOverlay', 'text', 'textMuted', 'border', 'accent', 'accentForeground',
  'accentSurface', 'warning', 'warningSurface', 'error', 'errorSurface', 'messageSurface', 'messageForeground',
  'codeBackground', 'codeForeground', 'placeholder',
] as const satisfies readonly ThemeColorRole[]

const DERIVED = ['mutedText', 'accentText', 'warningText', 'dangerText'] as const
type Derived = (typeof DERIVED)[number]
type Swatch = Record<(typeof ROLES)[number] | Derived, ThemeRgb>

/** WCAG AA for body text, with a little room for how the phone composites a tint. */
const TARGET = 4.6

/** How strongly the iPhone tints each surface. Mirrors `Tint` in Design.swift. */
const TINT = {
  needsYou: 0.11, working: 0.09, answered: 0.14, chosen: 0.2, accentPill: 0.13, failed: 0.1, dangerButton: 0.13,
  washDark: 0.34, washLight: 0.22,
  /** Where the heading, summary and search sit, the wash has faded to about this share of its peak. */
  washUnderText: 0.6,
}

function rgbOf(color: string): ThemeRgb {
  const parsed = parseThemeColor(color)
  if (!parsed) throw new Error(`Not a colour: ${color}`)
  return oklchToRgb(parsed.color)
}

/** CSS `color-mix(in oklab, a (1 - amount), b amount)`, rounded to 8-bit sRGB. */
function mixOklab(a: ThemeRgb, b: ThemeRgb, amount: number): ThemeRgb {
  const lab = (color: ThemeRgb): [number, number, number] => {
    const { L, C, h } = rgbToOklch(color)
    const radians = (h * Math.PI) / 180
    return [L, C * Math.cos(radians), C * Math.sin(radians)]
  }
  const [L1, a1, b1] = lab(a)
  const [L2, a2, b2] = lab(b)
  const L = L1 + (L2 - L1) * amount
  const A = a1 + (a2 - a1) * amount
  const B = b1 + (b2 - b1) * amount
  return oklchToRgb({ L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI })
}

/** A translucent tint over a surface, as alpha compositing paints it. */
const over = (surface: ThemeRgb, tint: ThemeRgb, amount: number): ThemeRgb => mixRgb(surface, tint, amount)

const minimum = (color: ThemeRgb, surfaces: readonly ThemeRgb[]): number => Math.min(...surfaces.map(surface => contrastRatio(color, surface)))

/** The first mix of `start` toward `ink` that reads on every surface. Ink itself always does. */
function readable(start: ThemeRgb, ink: ThemeRgb, surfaces: readonly ThemeRgb[]): ThemeRgb {
  if (minimum(start, surfaces) >= TARGET) return start
  let low = 0
  let high = 1
  for (let step = 0; step < 20; step += 1) {
    const mid = (low + high) / 2
    if (minimum(mixOklab(start, ink, mid), surfaces) >= TARGET) high = mid
    else low = mid
  }
  return mixOklab(start, ink, high)
}

interface Surfaces { readonly muted: ThemeRgb[]; readonly accent: ThemeRgb[]; readonly warning: ThemeRgb[]; readonly danger: ThemeRgb[] }

/** Every surface each derived text colour sits on, for one palette half. */
function surfacesFor(raw: Record<(typeof ROLES)[number], ThemeRgb>, appearance: ThemeAppearance): Surfaces {
  const { canvas, surface, surfaceRaised, surfaceOverlay, accent, warning, error } = raw
  const wash = over(canvas, accent, (appearance === 'dark' ? TINT.washDark : TINT.washLight) * TINT.washUnderText)
  const plain = [canvas, surface, surfaceRaised, surfaceOverlay, wash]
  const cards = [over(surface, warning, TINT.needsYou), over(surface, accent, TINT.working), over(surface, accent, TINT.answered), over(surface, error, TINT.failed)]
  return {
    muted: [...plain, ...cards],
    accent: [...plain, ...cards, over(surface, accent, TINT.chosen), over(canvas, accent, TINT.accentPill), over(surface, accent, TINT.accentPill)],
    warning: [...plain, over(surface, warning, TINT.needsYou)],
    danger: [...plain, over(surface, error, TINT.failed), over(surface, error, TINT.dangerButton), over(canvas, error, TINT.dangerButton)],
  }
}

function swatchFor(colors: ThemeColors, appearance: ThemeAppearance): Swatch {
  const raw = Object.fromEntries(ROLES.map(role => [role, rgbOf(colors[role])])) as Record<(typeof ROLES)[number], ThemeRgb>
  const on = surfacesFor(raw, appearance)
  const dark = appearance === 'dark'
  // The starting mixes are the approved study's --accent-text, --warn-text and --danger-text.
  return {
    ...raw,
    mutedText: readable(raw.textMuted, raw.text, on.muted),
    accentText: readable(mixOklab(raw.accent, raw.text, dark ? 0.16 : 0.22), raw.text, on.accent),
    warningText: readable(mixOklab(raw.warning, raw.text, dark ? 0.38 : 0.52), raw.text, on.warning),
    dangerText: readable(mixOklab(raw.error, raw.text, dark ? 0.22 : 0.3), raw.text, on.danger),
  }
}

interface IosPalette { readonly id: string; readonly name: string; readonly light: Swatch; readonly dark: Swatch }

function iosPalettes(): IosPalette[] {
  return BUILT_IN_THEMES.map(theme => {
    const light = getThemeColorsForMode(theme, 'light')
    const dark = getThemeColorsForMode(theme, 'dark')
    if (!light || !dark) throw new Error(`${theme.label} needs a light and a dark half`)
    // The desktop keeps Sotto's original id, t3-code; the iPhone names every palette by its label.
    return { id: theme.label.toLowerCase(), name: theme.label, light: swatchFor(light, 'light'), dark: swatchFor(dark, 'dark') }
  })
}

const component = (channel: number): string => (Math.round((channel / 255) * 10_000) / 10_000).toFixed(4)
const swiftRgb = (color: ThemeRgb): string => `ThemeRGB(${component(color.r)}, ${component(color.g)}, ${component(color.b)})`
const swiftName = (id: string, appearance: ThemeAppearance): string => `${id}${appearance === 'light' ? 'Light' : 'Dark'}`

function swiftSource(palettes: readonly IosPalette[]): string {
  const fields = [...ROLES, ...DERIVED]
  const lines: string[] = [
    '// Generated from src/shared/themes/palettes.ts by tests/unit/shared/iosPalettes.test.ts. Do not edit by hand.',
    `// To regenerate: ${REGENERATE}`,
    '',
    '/// A colour as sRGB components from 0 to 1.',
    'struct ThemeRGB: Equatable {',
    '    let red: Double',
    '    let green: Double',
    '    let blue: Double',
    '    init(_ red: Double, _ green: Double, _ blue: Double) {',
    '        self.red = red',
    '        self.green = green',
    '        self.blue = blue',
    '    }',
    '}',
    '',
    '/// One half of a palette: the desktop\'s roles the iPhone paints, then four text colours derived from them that',
    '/// keep 4.5:1 or better on every surface the iPhone tints (ADR-0051).',
    'struct ThemeSwatch: Equatable {',
    ...fields.map(field => `    let ${field}: ThemeRGB`),
    '}',
    '',
    '/// One of Sotto\'s built-in palettes, light and dark.',
    'struct ThemePalette: Identifiable, Equatable {',
    '    let id: String',
    '    let name: String',
    '    let light: ThemeSwatch',
    '    let dark: ThemeSwatch',
    '}',
    '',
    'enum ThemePalettes {',
    '    /// The six palettes in the order the desktop lists them. The first is the default.',
    `    static let all: [ThemePalette] = [${palettes.map(palette => palette.id).join(', ')}]`,
    '',
  ]
  for (const palette of palettes) {
    lines.push(`    static let ${palette.id} = ThemePalette(id: "${palette.id}", name: "${palette.name}", light: ${swiftName(palette.id, 'light')}, dark: ${swiftName(palette.id, 'dark')})`)
  }
  for (const palette of palettes) {
    for (const appearance of ['light', 'dark'] as const) {
      const swatch = palette[appearance]
      lines.push('')
      lines.push(`    static let ${swiftName(palette.id, appearance)} = ThemeSwatch(`)
      fields.forEach((field, index) => {
        lines.push(`        ${field}: ${swiftRgb(swatch[field])}${index === fields.length - 1 ? '' : ','}`)
      })
      lines.push('    )')
    }
  }
  lines.push('}', '')
  return lines.join('\n')
}

describe('iPhone palettes', () => {
  const palettes = iosPalettes()

  it('lists the six built-ins under their own names', () => {
    expect(palettes.map(palette => palette.id)).toEqual(['sotto', 'hush', 'linen', 'nocturne', 'tropic', 'citrine'])
  })

  it('keeps derived text readable on every tinted surface', () => {
    for (const palette of palettes) {
      for (const appearance of ['light', 'dark'] as const) {
        const swatch = palette[appearance]
        const on = surfacesFor(swatch, appearance)
        const where = `${palette.name} ${appearance}`
        expect(minimum(swatch.text, on.muted), `${where}: text`).toBeGreaterThanOrEqual(4.5)
        expect(minimum(swatch.mutedText, on.muted), `${where}: muted text`).toBeGreaterThanOrEqual(4.5)
        expect(minimum(swatch.accentText, on.accent), `${where}: accent text`).toBeGreaterThanOrEqual(4.5)
        expect(minimum(swatch.warningText, on.warning), `${where}: warning text`).toBeGreaterThanOrEqual(4.5)
        expect(minimum(swatch.dangerText, on.danger), `${where}: danger text`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(swatch.accentForeground, swatch.accent), `${where}: a primary button's label`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(swatch.messageForeground, swatch.messageSurface), `${where}: a sent message`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('matches the committed Swift copy', () => {
    const expected = swiftSource(palettes)
    if (process.env['SOTTO_WRITE_IOS_PALETTES'] === '1') writeFileSync(SWIFT_FILE, expected, 'utf8')
    let committed: string
    try {
      committed = readFileSync(SWIFT_FILE, 'utf8').replace(/\r\n/gu, '\n')
    } catch {
      committed = ''
    }
    expect(committed === expected,`apps/ios/Sotto/ThemePalettes.swift is out of date with src/shared/themes/palettes.ts. Regenerate it with: ${REGENERATE}`).toBe(true)
  })
})
