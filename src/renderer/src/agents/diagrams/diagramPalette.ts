import { useEffect, useState } from 'react'

/** The Sotto colours a drawing uses, read from the theme tokens of the window that shows it. */
export interface DiagramPalette {
  readonly dark: boolean
  readonly text: string
  readonly muted: string
  readonly line: string
  readonly node: string
  readonly nodeBorder: string
  readonly group: string
  readonly note: string
  readonly block: string
  readonly accent: string
}

// The default Ocean theme, used when the tokens cannot be read (tests, detached documents).
const DARK_FALLBACK = { text: '#fffaff', muted: '#a5aab3', node: '#333b45', border: '#848e9b', group: '#324e66', block: '#252e38', accent: '#70b9ee' }
const LIGHT_FALLBACK = { text: '#241523', muted: '#635b66', node: '#edeff1', border: '#837f8a', group: '#d8e4ee', block: '#f0f1f3', accent: '#2672af' }
const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/iu

function hexChannels(hex: string): [number, number, number] {
  const value = hex.length === 4 ? hex.slice(1).split('').map(part => part + part).join('') : hex.slice(1)
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number]
}

/** `amount` of `top` over `bottom`, as hex; Mermaid's colour maths needs plain colours, not color-mix(). */
export function mixHex(top: string, bottom: string, amount: number): string {
  const a = hexChannels(top)
  const b = hexChannels(bottom)
  return `#${a.map((channel, index) => Math.round(channel * amount + b[index]! * (1 - amount)).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Theme tokens are oklch() and color-mix() expressions, which Mermaid cannot
 * read. The browser resolves one by painting it: a hidden probe takes the
 * token as its colour, and a one-pixel canvas flattens that colour over the
 * room's canvas into sRGB bytes. Null where there is no canvas (jsdom).
 */
function createTokenPainter(root: HTMLElement): { paint: (name: string) => string | null; dispose: () => void } | null {
  const document = root.ownerDocument
  let context: CanvasRenderingContext2D | null = null
  try {
    context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  } catch {
    context = null
  }
  if (!context) return null
  const probe = document.createElement('span')
  probe.hidden = true
  ;(document.body ?? root).appendChild(probe)
  const computed = (name: string): string | null => {
    probe.style.color = `var(${name})`
    const value = getComputedStyle(probe).color
    return value === '' ? null : value
  }
  const canvas = computed('--tt-canvas')
  const paint = (name: string): string | null => {
    const value = computed(name)
    if (value === null || !context) return null
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = canvas ?? '#000000'
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  }
  return { paint, dispose: () => probe.remove() }
}

export function readDiagramPalette(root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement): DiagramPalette {
  const dark = root?.dataset.theme !== 'light'
  const fallback = dark ? DARK_FALLBACK : LIGHT_FALLBACK
  const styles = root ? getComputedStyle(root) : undefined
  let painter: ReturnType<typeof createTokenPainter> | undefined
  const token = (name: string, otherwise: string): string => {
    const value = styles?.getPropertyValue(name).trim() ?? ''
    if (HEX.test(value)) return value.toLowerCase()
    if (root === undefined || value === '') return otherwise
    if (painter === undefined) painter = createTokenPainter(root)
    return painter?.paint(name) ?? otherwise
  }
  try {
    return paletteFrom(dark, fallback, token)
  } finally {
    painter?.dispose()
  }
}

function paletteFrom(dark: boolean, fallback: typeof DARK_FALLBACK, token: (name: string, otherwise: string) => string): DiagramPalette {
  const block = token('--tt-code-bg', fallback.block)
  const accent = token('--tt-accent', fallback.accent)
  return {
    dark,
    text: token('--tt-text', fallback.text),
    muted: token('--tt-text-muted', fallback.muted),
    line: token('--tt-text-muted', fallback.muted),
    node: token('--tt-surface-elevated', fallback.node),
    nodeBorder: token('--tt-border', fallback.border),
    group: token('--tt-hover-strong', fallback.group),
    note: mixHex(accent, block, dark ? 0.16 : 0.12),
    block,
    accent,
  }
}

export function samePalette(a: DiagramPalette, b: DiagramPalette): boolean {
  return (Object.keys(a) as (keyof DiagramPalette)[]).every(key => a[key] === b[key])
}

/** The current palette, updated when the window's mode, theme, contrast or editor draft changes. */
export function useDiagramPalette(): DiagramPalette {
  const [palette, setPalette] = useState(readDiagramPalette)
  useEffect(() => {
    const root = document.documentElement
    const update = (): void => setPalette(current => {
      const next = readDiagramPalette(root)
      return samePalette(current, next) ? current : next
    })
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id', 'style'] })
    return () => observer.disconnect()
  }, [])
  return palette
}
