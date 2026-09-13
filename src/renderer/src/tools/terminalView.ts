import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalViewFactory, TerminalViewLike } from './terminalStore'

/** ANSI colours per appearance, tuned to stay readable on the panel field in each mode. */
const ANSI_DARK = {
  black: '#1a1d1b', red: '#f0a89c', green: '#8fd18a', yellow: '#f0c67a', blue: '#8fb8f2', magenta: '#c9b3f7', cyan: '#7fd6ca', white: '#c3c9c6',
  brightBlack: '#6b7370', brightRed: '#ffbcb0', brightGreen: '#aee3a9', brightYellow: '#f7d99e', brightBlue: '#b0d0fa', brightMagenta: '#ddd0fb', brightCyan: '#a6e7de', brightWhite: '#f3f4f3',
}
const ANSI_LIGHT = {
  black: '#141816', red: '#b42318', green: '#2f7433', yellow: '#8a5300', blue: '#2860c4', magenta: '#6a4bc9', cyan: '#146e63', white: '#59625d',
  brightBlack: '#3a423e', brightRed: '#9a1f14', brightGreen: '#1b5e20', brightYellow: '#6e4300', brightBlue: '#1d4c9e', brightMagenta: '#553aa6', brightCyan: '#0f5a51', brightWhite: '#7b847f',
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

/** The terminal's colours from the Crossing tokens, so the accent and appearance settings carry into it. */
export function terminalTheme(root: HTMLElement = document.documentElement): ITheme {
  const style = getComputedStyle(root)
  const light = root.dataset.theme === 'light'
  const accent = token(style, '--tt-accent', light ? '#146e63' : '#47b8a9')
  return {
    ...(light ? ANSI_LIGHT : ANSI_DARK),
    background: token(style, '--tt-sidebar', light ? '#eef0ec' : '#050706'),
    foreground: token(style, '--tt-code-text', light ? '#1f2522' : '#dfe4e1'),
    cursor: accent,
    cursorAccent: token(style, '--tt-sidebar', light ? '#eef0ec' : '#050706'),
    selectionBackground: withAlpha(accent, 0x52),
    selectionInactiveBackground: withAlpha(accent, 0x2e),
  }
}

/** xterm reads only plain colours, so the accent wash is written as #rrggbbaa. */
function withAlpha(hex: string, alpha: number): string {
  return /^#[0-9a-f]{6}$/iu.test(hex) ? `${hex}${alpha.toString(16).padStart(2, '0')}` : hex
}

function monoFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--tt-font-mono').trim() || 'Consolas, monospace'
}

/**
 * The real terminal: xterm over the main-process PTY. Ctrl+C copies a selection and otherwise interrupts;
 * Ctrl+V pastes; Ctrl+Tab and Ctrl+Shift+Tab leave the terminal, since Tab itself belongs to the shell.
 */
export const createXtermView: TerminalViewFactory = handlers => {
  const platform = (window.sotto as { platform?: string } | undefined)?.platform
  const reducedMotion = document.documentElement.dataset.reducedMotion === 'on' || matchMedia('(prefers-reduced-motion: reduce)').matches
  const terminal = new Terminal({
    fontFamily: monoFont(), fontSize: 13, lineHeight: 1.25, scrollback: 5_000, cursorBlink: !reducedMotion, allowProposedApi: false,
    theme: terminalTheme(), disableStdin: true, convertEol: false, screenReaderMode: false,
    ...(platform === 'win32' ? { windowsPty: { backend: 'conpty' as const } } : {}),
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const element = document.createElement('div')
  element.className = 'terminal-view__screen'
  let opened = false
  let inputEnabled = false

  terminal.onData(data => { if (inputEnabled) handlers.onInput(data) })
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

  const retheme = new MutationObserver(() => { terminal.options.theme = terminalTheme() })
  retheme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-reduced-motion'] })

  const view: TerminalViewLike = {
    mount(container) {
      if (element.parentElement !== container) container.replaceChildren(element)
      if (!opened) { terminal.open(element); opened = true }
    },
    unmount() { element.remove() },
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
    dispose() { retheme.disconnect(); terminal.dispose(); element.remove() },
  }
  return view
}

/** Moves keyboard focus to the next or previous focusable element outside the terminal. */
function moveFocusOut(from: HTMLElement, direction: 1 | -1): void {
  const outside = [...document.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(item => !item.matches(':disabled') && item.getClientRects().length > 0 && !from.contains(item))
  const after = (item: HTMLElement): boolean => (from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  const next = direction === 1 ? outside.find(after) : outside.filter(item => !after(item) && !item.contains(from)).at(-1)
  next?.focus()
}
