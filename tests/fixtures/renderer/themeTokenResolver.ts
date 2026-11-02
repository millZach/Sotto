import { join } from 'node:path'

import { oklchToRgb, parseThemeColor, rgbToOklch } from '../../../src/shared/themes/color'
import { DEFAULT_THEME_ID, EVERY_BUILT_IN_THEME, THEME_COLOR_ROLES, type ThemeColors } from '../../../src/shared/themes/library'
import { glassTintDeclarations } from '../../../src/shared/themes/glass'
import { themeColorVariable } from '../../../src/renderer/src/state/appearance'

/**
 * Resolves tokens.css the way the browser cascade does for the main window
 * root: the stylesheet's blocks for one mode, then the theme roles and
 * contrast strength applyAppearance writes inline. Colours are computed
 * through var(), oklch() (relative `oklch(from …)` too) and color-mix() in
 * srgb or oklab, so contrast is checked on the colours actually painted
 * rather than on raw declarations.
 */

export type Mode = 'dark' | 'light'
export interface Rgba {
  readonly r: number; readonly g: number; readonly b: number; readonly a: number
  /** A relative colour's own OKLab, kept outside the sRGB gamut, which a color-mix() in oklab reads as the browser does. */
  readonly oklab?: { readonly L: number; readonly A: number; readonly B: number }
}

export const TOKENS_PATH = join(process.cwd(), 'src/renderer/src/styles/tokens.css')
export const MODES: readonly Mode[] = ['dark', 'light']
/** Every built-in, Glass included: its roles are solid, so it is held to every check the others are (ADR-0150). */
export const THEME_IDS: readonly string[] = EVERY_BUILT_IN_THEME.map(theme => theme.id)

interface Block {
  readonly selectors: readonly string[]
  readonly declarations: ReadonlyMap<string, string>
  readonly index: number
}

export function parseTokenBlocks(css: string): Block[] {
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
function selectorApplies(selector: string, mode: Mode, effortColor: string, glass = false): number | null {
  const attributes = [...selector.matchAll(/\[data-([a-z-]+)(?:='([a-z]+)')?\]/gu)]
  const rest = selector.replace(/\[data-[a-z-]+(?:='[a-z]+')?\]/gu, '')
  if (rest !== ':root' && rest !== '') return null
  if (rest === '' && attributes.length === 0) return null
  for (const [, name, value] of attributes) {
    if (name === 'theme') { if (value !== mode) return null }
    else if (name === 'effort-color') { if (value !== undefined && value !== effortColor) return null }
    else if (name === 'glass') { if (!glass) return null }
    else return null
  }
  return (rest === ':root' ? 1 : 0) + attributes.length
}

export interface PaintOptions {
  readonly colors?: ThemeColors
  readonly contrast?: number
  /** The effort colourway on the root; Ember, the default, when unsaid. */
  readonly effortColor?: string
  /** Paint as Glass's see-through room does: the root marked data-glass, with its tints written inline. */
  readonly glass?: boolean
}

/** The custom properties on the root for one mode, with a palette and strengths written inline as applyAppearance does. */
export function rootDeclarations(mode: Mode, themeId: string = DEFAULT_THEME_ID, options: PaintOptions = {}, blocks: readonly Block[]): Map<string, string> {
  const effortColor = options.effortColor ?? 'ember'
  const applicable = blocks
    .map(block => ({ block, specificity: Math.max(-1, ...block.selectors.map(selector => selectorApplies(selector, mode, effortColor, options.glass === true) ?? -1)) }))
    .filter(({ specificity }) => specificity > 0)
    .sort((first, second) => first.specificity - second.specificity || first.block.index - second.block.index)
  const result = new Map<string, string>()
  for (const { block } of applicable) for (const [name, value] of block.declarations) result.set(name, value)
  const theme = EVERY_BUILT_IN_THEME.find(candidate => candidate.id === themeId)
  const colors = options.colors ?? (theme && (mode === theme.appearance ? theme.colors : theme.variants?.[mode]))
  if (!colors) throw new Error(`No ${mode} palette for ${themeId}`)
  for (const role of THEME_COLOR_ROLES) result.set(themeColorVariable(role), colors[role])
  if (options.glass === true) for (const [name, value] of glassTintDeclarations(mode)) result.set(name, value)
  const contrast = options.contrast ?? 100
  result.set('--theme-contrast-base', `${Math.min(contrast, 100)}%`)
  result.set('--theme-contrast-boost', `${Math.max(contrast - 100, 0)}%`)
  result.set('--theme-contrast-border-boost', `${Math.max(contrast - 100, 0) / 4}%`)
  result.set('--theme-contrast-hint-boost', `${Math.max(contrast - 100, 0) / 2}%`)
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
  if (color.oklab !== undefined) return color.oklab
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
  const relative = /^oklch\(from ([\s\S]+)\)$/u.exec(value)
  if (relative !== null) return relativeOklch(relative[1]!, declarations, depth)
  const parsed = value.startsWith('oklch(') ? parseThemeColor(value) : null
  if (parsed) return { ...oklchToRgb(parsed.color), a: parsed.alpha }
  throw new Error(`Unsupported colour value: ${value}`)
}

/**
 * CSS relative colour, `oklch(from <origin> <L> <C> <H>)`: the origin's l, c and h feed each channel's expression.
 * A theme role written as oklch() is read exactly, as the browser does, rather than through 8-bit sRGB, whose
 * rounding would scatter the hue of a nearly grey surface.
 */
function relativeOklch(body: string, declarations: ReadonlyMap<string, string>, depth: number): Rgba {
  const parts = splitTopLevel(body, ' ')
  if (parts.length !== 4) throw new Error(`Unsupported relative colour: oklch(from ${body})`)
  const [originText, ...channels] = parts as [string, string, string, string]
  let origin = originText
  for (let variable = /^var\((--[a-z0-9-]+)\)$/u.exec(origin); variable !== null; variable = /^var\((--[a-z0-9-]+)\)$/u.exec(origin)) {
    if (depth > 16) throw new Error('Token cycle')
    origin = declarations.get(variable[1]!)?.trim() ?? ''
    depth += 1
  }
  const literal = origin.startsWith('oklch(') && !origin.startsWith('oklch(from ') ? parseThemeColor(origin) : null
  const painted = literal === null ? parseColorValue(origin, declarations, depth + 1) : null
  const { L, C, h } = literal?.color ?? rgbToOklch(painted!)
  const scope = { l: L, c: C, h }
  const [lightness, chroma, hue] = channels.map(channel => evaluateChannel(substituteVariables(channel, declarations, depth), scope))
  const color = { L: Math.min(1, Math.max(0, lightness!)), C: Math.max(0, chroma!), h: ((hue! % 360) + 360) % 360 }
  const radians = (color.h * Math.PI) / 180
  return { ...oklchToRgb(color), a: literal?.alpha ?? painted!.a, oklab: { L: color.L, A: color.C * Math.cos(radians), B: color.C * Math.sin(radians) } }
}

/** Custom properties substitute as text, so a channel expression may come from another token. */
function substituteVariables(text: string, declarations: ReadonlyMap<string, string>, depth: number): string {
  if (depth > 16) throw new Error('Token cycle')
  const next = text.replace(/var\((--[a-z0-9-]+)\)/gu, (_, name: string) => {
    const raw = declarations.get(name)
    if (raw === undefined) throw new Error(`Missing token ${name}`)
    return raw
  })
  return next === text ? text : substituteVariables(next, declarations, depth + 1)
}

/** A channel expression: numbers, the channel keywords, + - * /, parentheses, and calc(), min(), max() and clamp(). */
function evaluateChannel(expression: string, scope: Readonly<Record<string, number>>): number {
  // Every character is a number, a name, an operator or a parenthesis; anything else, a unit or a percentage, is refused.
  const tokens: string[] = []
  const pattern = /\s*(\d*\.?\d+(?:e[+-]?\d+)?|[a-z]+|[-+*/(),])/iuy
  let read = 0
  for (let match = pattern.exec(expression); match !== null; match = pattern.exec(expression)) { tokens.push(match[1]!); read = pattern.lastIndex }
  if (expression.slice(read).trim() !== '') throw new Error(`Unsupported channel expression: ${expression}`)
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const take = (expected?: string): string => {
    const token = tokens[at++]
    if (token === undefined || (expected !== undefined && token !== expected)) throw new Error(`Unsupported channel expression: ${expression}`)
    return token
  }
  const sum = (): number => {
    let value = product()
    while (peek() === '+' || peek() === '-') value = take() === '+' ? value + product() : value - product()
    return value
  }
  const product = (): number => {
    let value = unary()
    while (peek() === '*' || peek() === '/') value = take() === '*' ? value * unary() : value / unary()
    return value
  }
  const unary = (): number => {
    if (peek() === '-') { take(); return -unary() }
    const token = take()
    if (token === '(') { const value = sum(); take(')'); return value }
    if (/^[\d.]/u.test(token)) return Number(token)
    if (peek() !== '(') {
      if (!(token in scope)) throw new Error(`Unknown channel keyword ${token} in ${expression}`)
      return scope[token]!
    }
    take('(')
    const args = [sum()]
    while (peek() === ',') { take(); args.push(sum()) }
    take(')')
    if (token === 'calc' && args.length === 1) return args[0]!
    if (token === 'min') return Math.min(...args)
    if (token === 'max') return Math.max(...args)
    if (token === 'clamp' && args.length === 3) return Math.max(args[0]!, Math.min(args[1]!, args[2]!))
    throw new Error(`Unsupported function ${token}() in ${expression}`)
  }
  const value = sum()
  if (at !== tokens.length) throw new Error(`Unsupported channel expression: ${expression}`)
  return value
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

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

export function contrast(first: Rgba, second: Rgba): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}
