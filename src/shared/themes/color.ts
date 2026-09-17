/*
 * Colour maths for themes: CSS colour literals in, canonical OKLCH out.
 *
 * The OKLab conversions, gamut mapping, contrast search and the canonical
 * `oklch(L C H[ / A])` form follow T3 Code's apps/web/src/themePalette.ts
 * (commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3, MIT, Copyright (c) 2026
 * T3 Tools Inc.). T3 parses input with culori; Sotto parses the literal forms
 * a theme file or a VS Code theme actually carries (hex, rgb, hsl, oklch,
 * oklab, color(srgb), transparent/black/white) so no colour library is added.
 *
 * A canonical colour is the only colour text that ever reaches a style
 * property: digits, dots, spaces and a slash inside `oklch()`, so a theme can
 * never smuggle a url(), var() or a second declaration into the stylesheet.
 */

export interface ThemeRgb { readonly r: number; readonly g: number; readonly b: number }
export interface ThemeOklch { readonly L: number; readonly C: number; readonly h: number }
export interface ParsedThemeColor { readonly color: ThemeOklch; readonly alpha: number }

/** Longest colour text accepted from a file or a pasted field. */
const MAX_COLOR_TEXT = 96

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`
const NUMBER_PATTERN = new RegExp(`^${NUMBER}$`, 'iu')

function isNumberText(text: string): boolean {
  return NUMBER_PATTERN.test(text)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearChannelToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.round(clamp(c, 0, 1) * 255)
}

export function rgbToOklch(color: ThemeRgb): ThemeOklch {
  const r = srgbChannelToLinear(color.r)
  const g = srgbChannelToLinear(color.g)
  const b = srgbChannelToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

function oklabToOklch(L: number, a: number, b: number): ThemeOklch {
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }
}

function oklchToLinearRgb({ L, C, h }: ThemeOklch): { r: number; g: number; b: number } {
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const bb = C * Math.sin(hr)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

/** The greatest chroma along the same lightness and hue that fits in sRGB. */
export function mapOklchToSrgbGamut(color: ThemeOklch): ThemeOklch {
  const isInGamut = (C: number): boolean => {
    const linear = oklchToLinearRgb({ ...color, C })
    return [linear.r, linear.g, linear.b].every(channel => channel >= -0.0001 && channel <= 1.0001)
  }
  if (isInGamut(color.C)) return color
  let low = 0
  let high = color.C
  const resolution = 0.000001
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(color.C, resolution)) - Math.log2(resolution)))
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2
    if (isInGamut(mid)) low = mid
    else high = mid
  }
  return { ...color, C: low }
}

export function oklchToRgb(color: ThemeOklch): ThemeRgb {
  const linear = oklchToLinearRgb(mapOklchToSrgbGamut(color))
  return { r: linearChannelToSrgb(linear.r), g: linearChannelToSrgb(linear.g), b: linearChannelToSrgb(linear.b) }
}

function formatNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/u, '$1')
}

export function formatOklch(color: ThemeOklch, alpha = 1): string {
  const L = clamp(color.L, 0, 1)
  const C = Math.max(0, color.C)
  const hue = C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360
  let hueText = formatNumber(hue, 3)
  // 359.9996 rounds to "360"; the canonical form keeps hue below a full turn.
  if (hueText === '360') hueText = '0'
  const body = `${formatNumber(L, 6)} ${formatNumber(C, 6)} ${hueText}`
  return alpha < 1 ? `oklch(${body} / ${formatNumber(clamp(alpha, 0, 1), 4)})` : `oklch(${body})`
}

// ---------------------------------------------------------------------------
// Parsing

function parseHex(input: string): { rgb: ThemeRgb; alpha: number } | null {
  if (!/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(input)) return null
  let hex = input.slice(1)
  if (hex.length <= 4) hex = hex.split('').map(part => part + part).join('')
  const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return {
    rgb: { r: channel(0), g: channel(2), b: channel(4) },
    alpha: hex.length === 8 ? channel(6) / 255 : 1,
  }
}

interface FunctionArguments { readonly name: string; readonly channels: readonly string[]; readonly alpha: string | null }

function splitFunction(input: string): FunctionArguments | null {
  const match = /^([a-z]+)\(([^()]*)\)$/iu.exec(input)
  if (!match) return null
  const name = match[1]!.toLowerCase()
  const inner = match[2]!.trim()
  let channels: string[]
  let alpha: string | null = null
  if (inner.includes(',')) {
    if (inner.includes('/')) return null
    channels = inner.split(',').map(part => part.trim())
    if (channels.length === 4) alpha = channels.pop()!
  } else {
    const [main, slashAlpha, ...extra] = inner.split('/')
    if (extra.length > 0) return null
    channels = main!.trim().split(/\s+/u)
    if (slashAlpha !== undefined) alpha = slashAlpha.trim()
  }
  if (channels.some(part => part.length === 0)) return null
  return { name, channels, alpha }
}

/** A plain or percentage number; `percentScale` is the value 100% stands for. `none` is zero. */
function parseComponent(text: string, percentScale: number): number | null {
  const value = text.toLowerCase()
  if (value === 'none') return 0
  if (value.endsWith('%')) {
    const number = value.slice(0, -1)
    return isNumberText(number) ? (Number(number) / 100) * percentScale : null
  }
  return isNumberText(value) ? Number(value) : null
}

function parseHue(text: string): number | null {
  const value = text.toLowerCase()
  if (value === 'none') return 0
  const match = /^(.*?)(deg|grad|rad|turn)?$/u.exec(value)
  if (!match || !isNumberText(match[1]!)) return null
  const number = Number(match[1])
  switch (match[2]) {
    case 'grad': return number * 0.9
    case 'rad': return (number * 180) / Math.PI
    case 'turn': return number * 360
    default: return number
  }
}

function parseAlpha(text: string | null): number | null {
  if (text === null) return 1
  const alpha = parseComponent(text, 1)
  return alpha === null ? null : clamp(alpha, 0, 1)
}

function hslToRgb(h: number, s: number, l: number): ThemeRgb {
  const hue = ((h % 360) + 360) % 360
  const saturation = clamp(s, 0, 1)
  const lightness = clamp(l, 0, 1)
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lightness - chroma / 2
  const [r, g, b] = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

function fromRgb(rgb: ThemeRgb, alpha: number): ParsedThemeColor {
  return {
    color: rgbToOklch({ r: clamp(rgb.r, 0, 255), g: clamp(rgb.g, 0, 255), b: clamp(rgb.b, 0, 255) }),
    alpha,
  }
}

/** Parse a literal CSS colour into OKLCH, or null when it is not one Sotto accepts. */
export function parseThemeColor(value: unknown): ParsedThemeColor | null {
  if (typeof value !== 'string') return null
  const input = value.trim()
  if (input.length === 0 || input.length > MAX_COLOR_TEXT) return null
  const lower = input.toLowerCase()
  if (lower === 'transparent') return { color: { L: 0, C: 0, h: 0 }, alpha: 0 }
  if (lower === 'black') return { color: { L: 0, C: 0, h: 0 }, alpha: 1 }
  if (lower === 'white') return { color: { L: 1, C: 0, h: 0 }, alpha: 1 }
  if (lower.startsWith('#')) {
    const hex = parseHex(lower)
    return hex ? fromRgb(hex.rgb, hex.alpha) : null
  }
  const parts = splitFunction(lower)
  if (!parts) return null
  const alpha = parseAlpha(parts.alpha)
  if (alpha === null) return null
  const { name, channels } = parts
  let parsed: ParsedThemeColor
  switch (name) {
    case 'rgb':
    case 'rgba': {
      if (channels.length !== 3) return null
      const [r, g, b] = channels.map(channel => parseComponent(channel, 255))
      if (r === null || g === null || b === null) return null
      parsed = fromRgb({ r: r!, g: g!, b: b! }, alpha)
      break
    }
    case 'hsl':
    case 'hsla': {
      if (channels.length !== 3) return null
      const h = parseHue(channels[0]!)
      const s = parseComponent(channels[1]!, 1)
      const l = parseComponent(channels[2]!, 1)
      if (h === null || s === null || l === null) return null
      // Legacy hsl() spells saturation and lightness as percentages; a bare
      // number is the modern 0-100 form.
      const scale = (text: string, number: number): number => (text.endsWith('%') ? number : number / 100)
      parsed = fromRgb(hslToRgb(h, scale(channels[1]!, s), scale(channels[2]!, l)), alpha)
      break
    }
    case 'oklch': {
      if (channels.length !== 3) return null
      const L = parseComponent(channels[0]!, 1)
      const C = parseComponent(channels[1]!, 0.4)
      const h = parseHue(channels[2]!)
      if (L === null || C === null || h === null) return null
      parsed = { color: { L, C, h }, alpha }
      break
    }
    case 'oklab': {
      if (channels.length !== 3) return null
      const L = parseComponent(channels[0]!, 1)
      const a = parseComponent(channels[1]!, 0.4)
      const b = parseComponent(channels[2]!, 0.4)
      if (L === null || a === null || b === null) return null
      parsed = { color: oklabToOklch(L, a, b), alpha }
      break
    }
    case 'color': {
      if (channels.length !== 4 || channels[0] !== 'srgb') return null
      const [r, g, b] = channels.slice(1).map(channel => parseComponent(channel, 1))
      if (r === null || g === null || b === null) return null
      parsed = fromRgb({ r: r! * 255, g: g! * 255, b: b! * 255 }, alpha)
      break
    }
    default:
      return null
  }
  const { L, C, h } = parsed.color
  if (![L, C, h, parsed.alpha].every(Number.isFinite)) return null
  return { color: { L: clamp(L, 0, 1), C: Math.max(0, C), h }, alpha: parsed.alpha }
}

/** A literal CSS colour in the canonical OKLCH form every stored theme uses. */
export function toCanonicalThemeColor(value: unknown): string | null {
  const parsed = parseThemeColor(value)
  return parsed ? formatOklch(parsed.color, parsed.alpha) : null
}

const CANONICAL_COLOR = /^oklch\((0|1|0\.\d{1,6}) (0|\d\.\d{1,6}|\d) (\d{1,3}(?:\.\d{1,3})?)(?: \/ (0|0\.\d{1,4}))?\)$/u

/**
 * Whether a value is already in canonical form: the check stored settings and
 * every IPC patch pass before a colour may be painted.
 */
export function isCanonicalThemeColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = CANONICAL_COLOR.exec(value)
  if (!match) return false
  return Number(match[2]) <= 1 && Number(match[3]) < 360 && toCanonicalThemeColor(value) === value
}

export function rgbToHex(color: ThemeRgb): string {
  return `#${[color.r, color.g, color.b]
    .map(channel => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`
}

/** A theme colour as hex (with alpha when translucent), for hex-only editors and exports. */
export function themeColorToHex(value: string): string | null {
  const parsed = parseThemeColor(value)
  if (!parsed) return null
  const opaque = rgbToHex(oklchToRgb(parsed.color))
  if (parsed.alpha >= 1) return opaque
  return `${opaque}${Math.round(parsed.alpha * 255).toString(16).padStart(2, '0')}`
}

export function parseThemeRgb(value: string, fallback: ThemeRgb): ThemeRgb {
  const parsed = parseThemeColor(value)
  return parsed ? oklchToRgb(parsed.color) : fallback
}

export function rgbToThemeColor(color: ThemeRgb): string {
  return formatOklch(rgbToOklch(color))
}

export function oklchToThemeColor(color: ThemeOklch): string {
  return formatOklch(mapOklchToSrgbGamut(color))
}

export function mixRgb(base: ThemeRgb, overlay: ThemeRgb, amount: number): ThemeRgb {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  }
}

export function relativeLuminance(color: ThemeRgb): number {
  const linearize = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
}

export function contrastRatio(first: ThemeRgb, second: ThemeRgb): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** 0.179 is the luminance where white and black text have equal contrast headroom. */
export function isDarkRgb(color: ThemeRgb): boolean {
  return relativeLuminance(color) < 0.179
}

/** Binary-search the lightness that reaches a contrast target against a background. */
export function solveOklchLightness(
  base: ThemeOklch,
  against: ThemeRgb,
  minContrast: number,
  direction: 'lighter' | 'darker',
): ThemeOklch {
  let low = direction === 'lighter' ? base.L : 0
  let high = direction === 'lighter' ? 1 : base.L
  if (contrastRatio(oklchToRgb(base), against) >= minContrast) return { ...base }
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2
    const contrast = contrastRatio(oklchToRgb({ ...base, L: mid }), against)
    if (contrast >= minContrast) {
      if (direction === 'lighter') high = mid
      else low = mid
    } else if (direction === 'lighter') low = mid
    else high = mid
  }
  return { ...base, L: direction === 'lighter' ? high : low }
}

export const THEME_LIGHT_FOREGROUND: ThemeRgb = { r: 255, g: 250, b: 255 }
const THEME_DARK_FOREGROUND: ThemeRgb = { r: 36, g: 21, b: 35 }
export const THEME_WHITE_FOREGROUND: ThemeRgb = { r: 255, g: 255, b: 255 }
export const THEME_BLACK_FOREGROUND: ThemeRgb = { r: 0, g: 0, b: 0 }

export function readableForeground(background: ThemeRgb): ThemeRgb {
  const light = contrastRatio(background, THEME_LIGHT_FOREGROUND)
  const dark = contrastRatio(background, THEME_DARK_FOREGROUND)
  if (Math.max(light, dark) >= 4.5) return light >= dark ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND
  return contrastRatio(background, THEME_WHITE_FOREGROUND) >= contrastRatio(background, THEME_BLACK_FOREGROUND)
    ? THEME_WHITE_FOREGROUND
    : THEME_BLACK_FOREGROUND
}

/** The quietest mix of `foreground` toward `background` that still clears `minimumRatio`. */
export function readableText(background: ThemeRgb, foreground: ThemeRgb, amount: number, minimumRatio: number): ThemeRgb {
  const softened = mixRgb(foreground, background, amount)
  if (contrastRatio(softened, background) >= minimumRatio) return softened
  let readable = foreground
  let lower = 0
  let upper = amount
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lower + upper) / 2
    const candidate = mixRgb(foreground, background, candidateAmount)
    if (contrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate
      lower = candidateAmount
    } else {
      upper = candidateAmount
    }
  }
  return readable
}
