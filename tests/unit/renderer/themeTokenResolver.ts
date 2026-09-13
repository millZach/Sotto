import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ACCENTS, type Accent } from '../../../src/shared/settings'

/**
 * Resolves tokens.css the way the browser cascade does for the main window
 * root, for one resolved mode and accent, so contrast can be checked on the
 * colours actually painted rather than on raw declarations.
 */

export type Mode = 'dark' | 'light'
export interface Rgba { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

export const TOKENS_PATH = join(process.cwd(), 'src/renderer/src/styles/tokens.css')

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

function selectorApplies(selector: string, mode: Mode, accent: Accent): number | null {
  if (!selector.startsWith(':root')) return null
  const attributes = [...selector.slice(':root'.length).matchAll(/\[data-([a-z-]+)='([a-z]+)'\]/gu)]
  if (selector.slice(':root'.length).replace(/\[data-[a-z-]+='[a-z]+'\]/gu, '') !== '') return null
  for (const [, name, value] of attributes) {
    if (name === 'theme' && value !== mode) return null
    if (name === 'accent' && value !== accent) return null
    if (name !== 'theme' && name !== 'accent') return null
  }
  return 1 + attributes.length
}

export function rootDeclarations(mode: Mode, accent: Accent, blocks: readonly Block[] = parseTokenBlocks()): Map<string, string> {
  const applicable = blocks
    .map(block => ({ block, specificity: Math.max(-1, ...block.selectors.map(selector => selectorApplies(selector, mode, accent) ?? -1)) }))
    .filter(({ specificity }) => specificity > 0)
    .sort((first, second) => first.specificity - second.specificity || first.block.index - second.block.index)
  const result = new Map<string, string>()
  for (const { block } of applicable) for (const [name, value] of block.declarations) result.set(name, value)
  return result
}

function parseHex(value: string): Rgba | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(value)
  if (match === null) return null
  const n = Number.parseInt(match[1]!, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
}

function parseRgb(value: string): Rgba | null {
  const match = /^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+(?:\.\d+)?)%)?\)$/u.exec(value)
  if (match === null) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) / 100 }
}

function mix(first: Rgba, weight: number, second: Rgba): Rgba {
  const a = first.a * weight + second.a * (1 - weight)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const channel = (key: 'r' | 'g' | 'b'): number => (first[key] * first.a * weight + second[key] * second.a * (1 - weight)) / a
  return { r: channel('r'), g: channel('g'), b: channel('b'), a }
}

export function resolveColor(name: string, declarations: ReadonlyMap<string, string>, depth = 0): Rgba {
  if (depth > 12) throw new Error(`Token cycle at ${name}`)
  const raw = declarations.get(name)
  if (raw === undefined) throw new Error(`Missing token ${name}`)
  return parseColorValue(raw, declarations, depth)
}

function parseColorValue(raw: string, declarations: ReadonlyMap<string, string>, depth: number): Rgba {
  const value = raw.trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const variable = /^var\((--[a-z0-9-]+)\)$/u.exec(value)
  if (variable !== null) return resolveColor(variable[1]!, declarations, depth + 1)
  const mixed = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, (.+)\)$/u.exec(value)
  if (mixed !== null) {
    return mix(parseColorValue(mixed[1]!, declarations, depth + 1), Number(mixed[2]) / 100, parseColorValue(mixed[3]!, declarations, depth + 1))
  }
  const color = parseHex(value) ?? parseRgb(value)
  if (color === null) throw new Error(`Unsupported colour value: ${value}`)
  return color
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

export const MODES: readonly Mode[] = ['dark', 'light']
export { ACCENTS }
