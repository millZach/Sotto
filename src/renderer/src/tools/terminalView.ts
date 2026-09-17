import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalViewHandlers, TerminalViewLike } from './terminalStore'

/** ANSI colours per appearance, tuned to stay readable on the panel field in each mode. */
const ANSI_DARK = {
  black: '#1a1d1b', red: '#f0a89c', green: '#8fd18a', yellow: '#f0c67a', blue: '#8fb8f2', magenta: '#c9b3f7', cyan: '#7fd6ca', white: '#c3c9c6',
  brightBlack: '#6b7370', brightRed: '#ffbcb0', brightGreen: '#aee3a9', brightYellow: '#f7d99e', brightBlue: '#b0d0fa', brightMagenta: '#ddd0fb', brightCyan: '#a6e7de', brightWhite: '#f3f4f3',
}
const ANSI_LIGHT = {
  black: '#141816', red: '#b42318', green: '#2f7433', yellow: '#8a5300', blue: '#2860c4', magenta: '#6a4bc9', cyan: '#146e63', white: '#59625d',
  brightBlack: '#3a423e', brightRed: '#9a1f14', brightGreen: '#1b5e20', brightYellow: '#6e4300', brightBlue: '#1d4c9e', brightMagenta: '#553aa6', brightCyan: '#0f5a51', brightWhite: '#7b847f',
}

/** A CSS colour as the `#rrggbb` or `#rrggbbaa` xterm parses exactly, or null when the page cannot paint it. */
export type ColorResolver = (css: string) => string | null

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu

/**
 * Resolves any colour the page can paint (OKLCH, color-mix) by drawing it on a 1x1 canvas. xterm parses such
 * values itself only when they are opaque and blends its selection from them, so it is given hex.
 */
function canvasColorResolver(): ColorResolver {
  let context: CanvasRenderingContext2D | null | undefined
  return css => {
    const value = css.trim()
    if (HEX.test(value)) return value.toLowerCase()
    if (!value) return null
    context ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!context) return null
    // An invalid value leaves fillStyle as it was, so two different starting points tell it apart.
    context.fillStyle = '#000000'
    context.fillStyle = value
    const first = context.fillStyle
    context.fillStyle = '#ffffff'
    context.fillStyle = value
    if (context.fillStyle !== first) return null
    context.globalCompositeOperation = 'copy'
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
    if (a === 0) return null
    const hex = (channel: number): string => channel.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? '' : hex(a)}`
  }
}

let sharedResolver: ColorResolver | undefined
function defaultResolver(): ColorResolver {
  return sharedResolver ??= canvasColorResolver()
}

/** Relative luminance of `#rrggbb`, for the ANSI set that stays readable on the terminal's field. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** xterm reads only plain colours, so the accent wash is written as #rrggbbaa. */
function withAlpha(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${alpha.toString(16).padStart(2, '0')}`
}

/**
 * The terminal's colours from the theme's terminal roles, or the Crossing tokens where there are none. A theme's
 * selection is opaque, which xterm supports by drawing selected text above it; the accent fallback is a wash.
 */
export function terminalTheme(root: HTMLElement = document.documentElement, resolve: ColorResolver = defaultResolver()): ITheme {
  const style = getComputedStyle(root)
  const color = (fallback: string, ...names: string[]): { readonly css: string; readonly hex: string } => {
    for (const name of names) {
      const css = style.getPropertyValue(name).trim()
      const hex = css ? resolve(css) : null
      if (hex) return { css, hex: hex.slice(0, 7) }
    }
    return { css: fallback, hex: fallback }
  }
  const background = color(root.dataset.theme === 'light' ? '#eef0ec' : '#050706', '--tt-terminal-background', '--tt-sidebar')
  const light = luminance(background.hex) > 0.4
  const foreground = color(light ? '#1f2522' : '#dfe4e1', '--tt-terminal-foreground', '--tt-code-text')
  const cursor = color(light ? '#146e63' : '#47b8a9', '--tt-terminal-cursor', '--tt-accent')
  const selection = color('', '--tt-terminal-selection')
  const scrollbar = color('', '--tt-terminal-scrollbar')
  const scrollbarHover = color(scrollbar.hex, '--tt-terminal-scrollbar-hover')
  return {
    ...(light ? ANSI_LIGHT : ANSI_DARK),
    background: background.hex,
    foreground: foreground.hex,
    cursor: cursor.hex,
    cursorAccent: background.hex,
    ...selection.hex ? {
      selectionBackground: selection.hex,
      selectionInactiveBackground: resolve(`color-mix(in srgb, ${selection.css} 60%, ${background.css})`)?.slice(0, 7) ?? selection.hex,
    } : {
      selectionBackground: withAlpha(cursor.hex, 0x52),
      selectionInactiveBackground: withAlpha(cursor.hex, 0x2e),
    },
    ...scrollbar.hex ? { scrollbarSliderBackground: scrollbar.hex, scrollbarSliderHoverBackground: scrollbarHover.hex, scrollbarSliderActiveBackground: scrollbarHover.hex } : {},
  }
}

function monoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--tt-font-mono').trim() || 'Consolas, monospace'
}

/**
 * The real terminal: xterm over the main-process PTY. Ctrl+C copies a selection and otherwise interrupts;
 * Ctrl+V pastes; Ctrl+Tab and Ctrl+Shift+Tab leave the terminal, since Tab itself belongs to the shell.
 */
export const createXtermView = (handlers: TerminalViewHandlers, { resolveColor = defaultResolver() }: { readonly resolveColor?: ColorResolver } = {}): TerminalViewLike => {
  const platform = (window.sotto as { platform?: string } | undefined)?.platform
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const blinks = (): boolean => document.documentElement.dataset.reducedMotion !== 'on' && !systemMotion.matches
  let theme = terminalTheme(document.documentElement, resolveColor)
  let painted = JSON.stringify(theme)
  const terminal = new Terminal({
    fontFamily: monoFont(), fontSize: 13, lineHeight: 1.25, scrollback: 5_000, cursorBlink: blinks(), allowProposedApi: false,
    theme, minimumContrastRatio: 4.5, disableStdin: true, convertEol: false, screenReaderMode: false,
    ...(platform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const element = document.createElement('div')
  element.className = 'terminal-view__screen'
  let opened = false
  let inputEnabled = false
  let renderer: WebglAddon | undefined
  const releaseRenderer = (): void => {
    const current = renderer
    renderer = undefined
    current?.dispose()
  }
  const paintGrid = (): void => {
    if (renderer) return
    try {
      renderer = new WebglAddon()
      renderer.onContextLoss(releaseRenderer)
      terminal.loadAddon(renderer)
    } catch {
      // A remote desktop or unavailable GPU must still leave a usable DOM terminal.
      releaseRenderer()
    }
  }

  terminal.onData(data => { if (inputEnabled) handlers.onInput(data) })
  // An image on the clipboard goes to the handler as PNG; text keeps flowing through xterm's own paste.
  element.addEventListener('paste', event => {
    const image = handlers.onPasteImage ? [...event.clipboardData?.items ?? []].find(item => item.kind === 'file' && item.type.startsWith('image/')) : undefined
    const file = image?.getAsFile()
    if (!file || !inputEnabled) return
    event.preventDefault()
    event.stopPropagation()
    void pngDataUrl(file).then(dataUrl => { if (dataUrl) handlers.onPasteImage?.(dataUrl) })
  }, true)
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey
    if (ctrl && event.key === 'Tab') {
      event.preventDefault()
      moveFocusOut(element, event.shiftKey ? -1 : 1)
      return false
    }
    if (ctrl && !event.shiftKey && (event.key === 'c' || event.key === 'C')) {
      if (terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined)
        terminal.clearSelection()
        return false
      }
      if (inputEnabled) handlers.onInterrupt()
      return false
    }
    if (ctrl && (event.key === 'v' || event.key === 'V')) {
      // The browser's paste event reaches xterm's textarea and arrives through onData once.
      return false
    }
    return true
  })

  // Both xterm renderers observe cursorBlink, so reduced motion updates the existing terminal.
  const followMotion = (): void => {
    const blink = blinks()
    if (terminal.options.cursorBlink !== blink) terminal.options.cursorBlink = blink
  }
  systemMotion.addEventListener('change', followMotion)

  // Appearance writes the mode and theme as root attributes and each colour as a root custom property, so a theme,
  // mode, contrast or editor change repaints this same terminal. A root change that leaves its colours alone does not.
  const retheme = new MutationObserver(() => {
    followMotion()
    const next = terminalTheme(document.documentElement, resolveColor)
    const key = JSON.stringify(next)
    if (key === painted) return
    theme = next
    painted = key
    terminal.options.theme = theme
  })
  retheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id', 'data-accent', 'data-reduced-motion', 'style', 'class'] })

  const view: TerminalViewLike = {
    mount(container) {
      if (element.parentElement !== container) container.replaceChildren(element)
      if (!opened) { terminal.open(element); opened = true }
      // The GPU renderer draws box/block glyphs to cell edges, independent of font and line spacing.
      paintGrid()
    },
    unmount() { releaseRenderer(); element.remove() },
    write(data, done) { terminal.write(data, done) },
    reset() { terminal.reset() },
    setInputEnabled(enabled) {
      inputEnabled = enabled
      terminal.options.disableStdin = !enabled
      terminal.options.cursorInactiveStyle = enabled ? 'outline' : 'none'
    },
    fit() {
      if (!opened || !element.isConnected || element.clientWidth === 0 || element.clientHeight === 0) return null
      const size = fit.proposeDimensions()
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return null
      if (size.cols !== terminal.cols || size.rows !== terminal.rows) terminal.resize(size.cols, size.rows)
      return { cols: terminal.cols, rows: terminal.rows }
    },
    focus() { terminal.focus() },
    dispose() { retheme.disconnect(); systemMotion.removeEventListener('change', followMotion); releaseRenderer(); terminal.dispose(); element.remove() },
  }
  return view
}

/** The clipboard image as a PNG data URL, redrawn when the clipboard gave another format. */
async function pngDataUrl(file: Blob): Promise<string | null> {
  const read = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  try {
    if (file.type === 'image/png') return await read(file)
    if (typeof createImageBitmap !== 'function') return null
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    return canvas.toDataURL('image/png')
  } catch { return null }
}

/** Moves keyboard focus to the next or previous focusable element outside the terminal. */
function moveFocusOut(from: HTMLElement, direction: 1 | -1): void {
  const outside = [...document.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(item => !item.matches(':disabled') && item.getClientRects().length > 0 && !from.contains(item))
  const after = (item: HTMLElement): boolean => (from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const next = direction === 1 ? outside.find(after) : outside.filter(item => !after(item) && !item.contains(from)).at(-1)
  next?.focus()
}
