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

// Crossing dark with the Teal accent, used when the tokens cannot be read (tests, detached documents).
const DARK_FALLBACK = { text: '#f3f4f3', muted: '#858c88', node: '#121514', border: '#6b7370', group: '#171a18', block: '#0a0d0b', accent: '#47b8a9' }
const LIGHT_FALLBACK = { text: '#141816', muted: '#59625d', node: '#ffffff', border: '#7b847f', group: '#e4e7e2', block: '#eef0ec', accent: '#146e63' }
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

export function readDiagramPalette(root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement): DiagramPalette {
  const dark = root?.dataset.theme !== 'light'
  const fallback = dark ? DARK_FALLBACK : LIGHT_FALLBACK
  const styles = root ? getComputedStyle(root) : undefined
  const token = (name: string, otherwise: string): string => {
    const value = styles?.getPropertyValue(name).trim() ?? ''
    return HEX.test(value) ? value.toLowerCase() : otherwise
  }
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

/** The current palette, updated when the window's appearance or accent changes. */
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
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] })
    return () => observer.disconnect()
  }, [])
  return palette
}
