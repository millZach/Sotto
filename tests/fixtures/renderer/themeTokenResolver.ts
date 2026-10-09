import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { oklchToRgb, parseThemeColor, rgbToOklch } from '../../../src/shared/themes/color'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, THEME_COLOR_ROLES, type ThemeColors } from '../../../src/shared/themes/library'
import { themeColorVariable } from '../../../src/renderer/src/state/appearance'

/**
 * Resolves tokens.css the way the browser cascade does for the main window
 * root: the stylesheet's blocks for one mode, then the theme roles, contrast
 * and glass strengths applyAppearance writes inline. Colours are computed
 * through var(), oklch() and color-mix() in srgb or oklab, so contrast is
 * checked on the colours actually painted rather than on raw declarations.
 */

export type Mode = 'dark' | 'light'
export interface Rgba { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

export const TOKENS_PATH = join(process.cwd(), 'src/renderer/src/styles/tokens.css')
export const MODES: readonly Mode[] = ['dark', 'light']
export const THEME_IDS: readonly string[] = BUILT_IN_THEMES.map(theme => theme.id)

interface Block {
  readonly selectors: readonly string[]
  readonly declarations: ReadonlyMap<string, string>
  readonly index: number
}

export function parseTokenBlocks(css: string = readFileSync(TOKENS_PATH, 'utf8')): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  const blocks: Block[] = []
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]!.split(',').map(selector => selector.trim()).filter(Boolean)
    const declarations = new Map<string, string>()
    for (const declaration of match[2]!.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      const name = declaration.slice(0, colon).trim()
      if (name.startsWith('--')) declarations.set(name, declaration.slice(colon + 1).replace(/\s+/gu, ' ').trim())
    }
    blocks.push({ selectors, declarations, index: blocks.length })
  }
  return blocks
}

/**
 * Whether a tokens.css selector reaches the root painted in `mode` with `effortColor`, and its specificity if so.
 * The root carries `data-theme` and `data-effort-color`; a bare attribute selector (the effort colourway blocks,
 * which a Settings swatch also wears) matches the root too, at the same specificity as `:root`.
 */
function selectorApplies(selector: string, mode: Mode, effortColor: string): number | null {
  const attributes = [...selector.matchAll(/\[data-([a-z-]+)(?:='([a-z]+)')?\]/gu)]
  const rest = selector.replace(/\[data-[a-z-]+(?:='[a-z]+')?\]/gu, '')
  if (rest !== ':root' && rest !== '') return null
  if (rest === '' && attributes.length === 0) return null
  for (const [, name, value] of attributes) {
    if (name === 'theme') { if (value !== mode) return null }
    else if (name === 'effort-color') { if (value !== undefined && value !== effortColor) return null }
    else return null
  }
  return (rest === ':root' ? 1 : 0) + attributes.length
}

export interface PaintOptions {
  readonly colors?: ThemeColors
  readonly contrast?: number
  readonly glass?: number
  /** The effort colourway on the root; Ember, the default, when unsaid. */
  readonly effortColor?: string
}

/** The custom properties on the root for one mode, with a palette and strengths written inline as applyAppearance does. */
export function rootDeclarations(mode: Mode, themeId: string = DEFAULT_THEME_ID, options: PaintOptions = {}, blocks: readonly Block[] = parseTokenBlocks()): Map<string, string> {
  const effortColor = options.effortColor ?? 'ember'
  const applicable = blocks
    .map(block => ({ block, specificity: Math.max(-1, ...block.selectors.map(selector => selectorApplies(selector, mode, effortColor) ?? -1)) }))
    .filter(({ specificity }) => specificity > 0)
    .sort((first, second) => first.specificity - second.specificity || first.block.index - second.block.index)
  const result = new Map<string, string>()
  for (const { block } of applicable) for (const [name, value] of block.declarations) result.set(name, value)
  const theme = BUILT_IN_THEMES.find(candidate => candidate.id === themeId)
  const colors = options.colors ?? (theme && (mode === theme.appearance ? theme.colors : theme.variants?.[mode]))
  if (!colors) throw new Error(`No ${mode} palette for ${themeId}`)
  for (const role of THEME_COLOR_ROLES) result.set(themeColorVariable(role), colors[role])
  const contrast = options.contrast ?? 100
  result.set('--theme-contrast-base', `${Math.min(contrast, 100)}%`)
  result.set('--theme-contrast-boost', `${Math.max(contrast - 100, 0)}%`)
  result.set('--theme-contrast-border-boost', `${Math.max(contrast - 100, 0) / 4}%`)
  result.set('--theme-glass-opacity', `${options.glass ?? 80}%`)
  return result
}

// ---------------------------------------------------------------------------
// Colour evaluation

function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function resolvePercent(token: string, declarations: ReadonlyMap<string, string>, depth: number): number | null {
  const variable = /^var\((--[a-z0-9-]+)\)$/u.exec(token)
  if (variable) {
    if (depth > 12) throw new Error('Token cycle')
    const raw = declarations.get(variable[1]!)
    return raw === undefined ? null : resolvePercent(raw.trim(), declarations, depth + 1)
  }
  const match = /^(-?\d+(?:\.\d+)?)%$/u.exec(token)
  return match ? Number(match[1]) : null
}

interface Lab { readonly L: number; readonly A: number; readonly B: number }

function toLab(color: Rgba): Lab {
  const oklch = rgbToOklch(color)
  const radians = (oklch.h * Math.PI) / 180
  return { L: oklch.L, A: oklch.C * Math.cos(radians), B: oklch.C * Math.sin(radians) }
}

function fromLab(lab: Lab, alpha: number): Rgba {
  const rgb = oklchToRgb({ L: lab.L, C: Math.hypot(lab.A, lab.B), h: ((Math.atan2(lab.B, lab.A) * 180) / Math.PI + 360) % 360 })
  return { ...rgb, a: alpha }
}

/** CSS color-mix(): premultiplied interpolation, with the alpha scaled when the percentages sum below 100. */
function colorMix(space: string, first: Rgba, firstPercent: number | null, second: Rgba, secondPercent: number | null): Rgba {
  let p1 = firstPercent
  let p2 = secondPercent
  if (p1 === null && p2 === null) [p1, p2] = [50, 50]
  else if (p1 === null) p1 = 100 - p2!
  else if (p2 === null) p2 = 100 - p1
  const sum = p1 + p2!
  if (sum <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const w1 = p1 / sum
  const w2 = p2! / sum
  const alpha = first.a * w1 + second.a * w2
  const scale = sum < 100 ? sum / 100 : 1
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  if (space === 'srgb') {
    const channel = (key: 'r' | 'g' | 'b'): number => (first[key] * first.a * w1 + second[key] * second.a * w2) / alpha
    return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha * scale }
  }
  // A fully transparent colour carries no hue: it takes the other's components.
  const labFirst = first.a === 0 ? toLab(second) : toLab(first)
  const labSecond = second.a === 0 ? toLab(first) : toLab(second)
  const component = (key: keyof Lab): number => (labFirst[key] * first.a * w1 + labSecond[key] * second.a * w2) / alpha
  return fromLab({ L: component('L'), A: component('A'), B: component('B') }, alpha * scale)
}

export function resolveColor(name: string, declarations: ReadonlyMap<string, string>, depth = 0): Rgba {
  if (depth > 16) throw new Error(`Token cycle at ${name}`)
  const raw = declarations.get(name)
  if (raw === undefined) throw new Error(`Missing token ${name}`)
  return parseColorValue(raw, declarations, depth)
}

export function parseColorValue(raw: string, declarations: ReadonlyMap<string, string>, depth = 0): Rgba {
  const value = raw.trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  const variable = /^var\((--[a-z0-9-]+)\)$/u.exec(value)
  if (variable !== null) return resolveColor(variable[1]!, declarations, depth + 1)
  const mixed = /^color-mix\(in (srgb|oklab), ([\s\S]+)\)$/u.exec(value)
  if (mixed !== null) {
    const args = splitTopLevel(mixed[2]!, ',')
    if (args.length !== 2) throw new Error(`Unsupported color-mix: ${value}`)
    const [first, second] = args.map(arg => {
      const tokens = splitTopLevel(arg, ' ')
      const percent = tokens.length > 1 ? resolvePercent(tokens.at(-1)!, declarations, depth) : null
      const colorText = percent === null ? arg : tokens.slice(0, -1).join(' ')
      return { color: parseColorValue(colorText, declarations, depth + 1), percent }
    }) as [{ color: Rgba; percent: number | null }, { color: Rgba; percent: number | null }]
    return colorMix(mixed[1]!, first.color, first.percent, second.color, second.percent)
  }
  const hex = /^#([0-9a-f]{6})$/iu.exec(value)
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+(?:\.\d+)?)%)?\)$/u.exec(value)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100 }
  const parsed = value.startsWith('oklch(') ? parseThemeColor(value) : null
  if (parsed) return { ...oklchToRgb(parsed.color), a: parsed.alpha }
  throw new Error(`Unsupported colour value: ${value}`)
}

/** Paint a translucent colour over an opaque one. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const channel = (key: 'r' | 'g' | 'b'): number => top[key] * top.a + bottom[key] * (1 - top.a)
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: 1 }
}

function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function contrast(first: Rgba, second: Rgba): number {
  const luminance = (color: Rgba): number => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}
