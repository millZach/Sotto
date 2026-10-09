import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TerminalViewHandlers, TerminalViewLike } from './terminalStore'
import { writeClipboard } from '../agents/richActions'
import { isTerminalLink, TERMINAL_URL_PATTERN, terminalLinkCatalog, terminalLinkPicker } from './terminalLinks'
import { terminalSearch } from './terminalSearch'
import { followTerminalFontSize, terminalFontSize, terminalShortcut, zoomTerminal } from './terminalPreferences'

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
 * See-through, the background keeps its colour at zero alpha, so the drawer behind it shows and xterm still
 * measures text contrast against the theme's own terminal background.
 */
export function terminalTheme(root: HTMLElement = document.documentElement, resolve: ColorResolver = defaultResolver(), seeThrough = false): ITheme {
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
    background: seeThrough ? withAlpha(background.hex, 0) : background.hex,
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
 * The real terminal: xterm over the main-process PTY. On Windows Ctrl+C copies a selection and otherwise
 * interrupts, and Ctrl+V pastes. On macOS Ctrl+C always interrupts and Ctrl+V goes to the shell, as in Terminal;
 * ⌘C and ⌘V copy and paste through the Edit menu, and Option types the keyboard layout's characters. Ctrl+Tab and Ctrl+Shift+Tab leave the
 * terminal, since Tab itself belongs to the shell.
 */
export const createXtermView = (handlers: TerminalViewHandlers, { resolveColor = defaultResolver() }: { readonly resolveColor?: ColorResolver } = {}): TerminalViewLike => {
  const platform = window.sotto?.platform ?? 'win32'
  const systemMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const blinks = (): boolean => document.documentElement.dataset.reducedMotion !== 'on' && !systemMotion.matches
  // A drawer's terminal is see-through while the room is frosted; its drawer paints the frosted colour behind it.
  const seeThrough = (): boolean => handlers.followsFrost === true && document.documentElement.dataset.frost !== undefined
  let theme = terminalTheme(document.documentElement, resolveColor, seeThrough())
  let painted = JSON.stringify(theme)
  const openLink = (uri: string): void => {
    if (!isTerminalLink(uri)) return
    const open = window.sotto?.openExternalLink
    if (!open) { handlers.onNotice?.('The link could not open. Copy it into your browser.'); return }
    void open(uri).then(result => {
      if (!disposed) handlers.onNotice?.(result.ok ? null : 'The link could not open. Copy it into your browser.')
    }, () => { if (!disposed) handlers.onNotice?.('The link could not open. Copy it into your browser.') })
  }
  const clickLink = (event: MouseEvent, uri: string): void => {
    if (event.button !== 0 || event.altKey || !(platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    openLink(uri)
  }
  const terminal = new Terminal({
    // Search decorations and the Unicode provider are xterm's proposed APIs, supplied by its pinned addons.
    fontFamily: monoFont(), fontSize: terminalFontSize(), lineHeight: 1.25, scrollback: 5_000, cursorBlink: blinks(), allowProposedApi: true,
    linkHandler: { activate: clickLink, allowNonHttpProtocols: false },
    theme, minimumContrastRatio: 4.5, disableStdin: true, convertEol: false, screenReaderMode: false, allowTransparency: handlers.followsFrost === true,
    ...(platform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(new WebLinksAddon(clickLink, { urlRegex: TERMINAL_URL_PATTERN }))
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const element = document.createElement('div')
  element.className = 'terminal-view__screen'
  const output = document.createElement('div')
  output.className = 'terminal-view__output'
  element.append(output)
  const reportFocus = (focused: boolean): void => { void window.sotto?.terminal?.setFocused?.(focused).catch(() => undefined) }
  element.addEventListener('focusin', () => reportFocus(true))
  element.addEventListener('focusout', event => { if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) reportFocus(false) })
  let opened = false
  let inputEnabled = false
  let disposed = false
  const catalog = terminalLinkCatalog(terminal)
  const picker = terminalLinkPicker(element, catalog, openLink)
  const search = terminalSearch(terminal, element, resolveColor, visible => {
    element.toggleAttribute('data-search-open', visible)
    const grid = view.fit()
    if (grid) handlers.onResize?.(grid)
    respace()
  }, () => picker.open())
  let selectionRevision = 0
  const selectionChanges = terminal.onSelectionChange(() => { selectionRevision++ })
  // xterm reports a dragged selection on release. Protect it from queued copies from the first press.
  const startSelection = (): void => { selectionRevision++ }
  element.addEventListener('pointerdown', startSelection, true)
  element.addEventListener('mousedown', startSelection, true)
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
      renderer.onContextLoss(() => { releaseRenderer(); respace() })
      terminal.loadAddon(renderer)
    } catch {
      // A remote desktop or unavailable GPU must still leave a usable DOM terminal.
      releaseRenderer()
      respace()
    }
  }
  // xterm's DOM renderer spaces its letters from a width it measures in the same moment the text size changes, before
  // the page has laid the new size out, and measures nothing while the view is off the page. Either way the text drifts
  // off its cells, and off the search highlights drawn on them. Any option change measures again, so once the page has
  // laid out, set the weight to its twin and back.
  let respacing = 0
  const respace = (): void => {
    cancelAnimationFrame(respacing)
    respacing = requestAnimationFrame(() => {
      if (disposed || renderer || !element.isConnected) return
      const weight = terminal.options.fontWeight ?? 'normal'
      terminal.options.fontWeight = weight === 'normal' ? 400 : 'normal'
      terminal.options.fontWeight = weight
    })
  }

  terminal.onData(data => { if (inputEnabled) handlers.onInput(data) })
  // An image on the clipboard goes to the handler as PNG; text keeps flowing through xterm's own paste.
  element.addEventListener('paste', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.xterm')) return
    const image = handlers.onPasteImage ? [...event.clipboardData?.items ?? []].find(item => item.kind === 'file' && item.type.startsWith('image/')) : undefined
    const file = image?.getAsFile()
    if (!file || !inputEnabled) return
    event.preventDefault()
    event.stopPropagation()
    handlers.onPasteImage?.(pngDataUrl(file))
  }, true)
  const handleShortcut = (event: KeyboardEvent): boolean => {
    const shortcut = terminalShortcut(event, platform)
    if (shortcut) {
      event.preventDefault()
      event.stopPropagation()
      if (shortcut === 'search') { picker.close(); search.open() }
      else void zoomTerminal(shortcut).then(saved => {
        if (!saved && !disposed) handlers.onNotice?.('The text size could not be saved. Try the shortcut again.')
      })
      return true
    }
    if (!event.isComposing && event.key === 'Escape' && (picker.close() || search.close())) { event.preventDefault(); event.stopPropagation(); return true }
    return false
  }
  // Capture also covers the search controls; only keys from this view can claim terminal shortcuts.
  element.addEventListener('keydown', handleShortcut, true)
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true
    if (event.defaultPrevented || handleShortcut(event)) return false
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey
    if (ctrl && event.key === 'Tab') {
      event.preventDefault()
      moveFocusOut(element, event.shiftKey ? -1 : 1)
      return false
    }
    if (ctrl && !event.shiftKey && (event.key === 'c' || event.key === 'C')) {
      if (platform !== 'darwin' && terminal.hasSelection()) {
        const selection = terminal.getSelection()
        if (!selection.trim()) { handlers.onNotice?.('Nothing to copy. Select some text first.'); return false }
        const copiedRevision = selectionRevision
        const copiedRange = terminal.getSelectionPosition()
        void writeClipboard(selection).then(() => {
          if (disposed) return
          const range = terminal.getSelectionPosition()
          if (selectionRevision === copiedRevision && range && copiedRange &&
            range.start.x === copiedRange.start.x && range.start.y === copiedRange.start.y &&
            range.end.x === copiedRange.end.x && range.end.y === copiedRange.end.y) terminal.clearSelection()
          handlers.onNotice?.(null)
        }, () => { if (!disposed) handlers.onNotice?.('Could not copy. Your selection is kept. Try Ctrl+C again.') })
        return false
      }
      if (inputEnabled) handlers.onInterrupt()
      return false
    }
    // On macOS Ctrl+V is the shell's own (quoted insert); ⌘V pastes through the Edit menu's paste event.
    if (platform !== 'darwin' && ctrl && (event.key === 'v' || event.key === 'V')) {
      // The browser's paste event reaches xterm's textarea and arrives through onData once.
      return false
    }
    // A key the page acts on (a drawer's own toggle) goes to the page, never to the shell.
    if (handlers.isPageShortcut?.(event)) return false
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
    const next = terminalTheme(document.documentElement, resolveColor, seeThrough())
    const key = JSON.stringify(next)
    if (key === painted) { search.refreshTheme(); return }
    theme = next
    painted = key
    terminal.options.theme = theme
    search.refresh()
  })
  retheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-id', 'data-accent', 'data-reduced-motion', 'data-frost', 'style', 'class'] })

  const view: TerminalViewLike = {
    mount(container) {
      if (element.parentElement !== container) container.replaceChildren(element)
      if (!opened) { terminal.open(output); search.mount(); opened = true }
      // The GPU renderer draws box/block glyphs to cell edges, independent of font and line spacing.
      paintGrid()
    },
    unmount() { if (element.contains(document.activeElement)) reportFocus(false); releaseRenderer(); element.remove() },
    write(data, done) { terminal.write(data, done) },
    reset() { catalog.clear(); terminal.reset() },
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
    dispose() {
      disposed = true
      cancelAnimationFrame(respacing)
      if (element.contains(document.activeElement)) reportFocus(false)
      selectionChanges.dispose()
      element.removeEventListener('pointerdown', startSelection, true)
      element.removeEventListener('mousedown', startSelection, true)
      retheme.disconnect()
      systemMotion.removeEventListener('change', followMotion)
      stopFollowingFont()
      search.dispose()
      picker.dispose()
      catalog.dispose()
      releaseRenderer()
      terminal.dispose()
      element.remove()
    },
  }
  const stopFollowingFont = followTerminalFontSize(() => {
    const size = terminalFontSize()
    if (terminal.options.fontSize === size) return
    terminal.options.fontSize = size
    const grid = view.fit()
    if (grid) handlers.onResize?.(grid)
    search.refresh()
    respace()
  })
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
