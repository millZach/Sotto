import type { IMarker, Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'

const HIGHLIGHT_LIMIT = 1_000

/** The approved inline search bar, owned by the view so hiding a pane keeps its query and scrollback. */
export function terminalSearch(terminal: Terminal, element: HTMLElement, resolve: (css: string) => string | null, onVisibilityChange?: (open: boolean) => void, onOpenLinks?: () => void) {
  const addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT })
  terminal.loadAddon(addon)
  const bar = document.createElement('div')
  bar.className = 'terminal-search'
  bar.hidden = true
  bar.setAttribute('role', 'search')
  bar.setAttribute('aria-label', 'Search terminal output')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Find'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Find in terminal')
  const count = document.createElement('output')
  count.setAttribute('aria-live', 'polite')
  const button = (label: string, title: string, path: string): HTMLButtonElement => {
    const control = document.createElement('button')
    control.type = 'button'
    control.setAttribute('aria-label', label)
    control.title = title
    control.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`
    return control
  }
  const previous = button('Previous match', 'Previous match (Shift+Enter)', 'm18 15-6-6-6 6')
  const next = button('Next match', 'Next match (Enter)', 'm6 9 6 6 6-6')
  const close = button('Close search', 'Close search (Escape)', 'M18 6 6 18M6 6l12 12')
  bar.append(input, count, previous, next, close)
  if (onOpenLinks) {
    const links = button('Open terminal link', 'Open terminal link', 'M15 3h6v6M10 14 21 3M21 14v7H3V3h7')
    links.addEventListener('click', onOpenLinks)
    bar.insertBefore(links, close)
  }
  let selected: { marker: IMarker; column: number; length: number; term: string; line: string } | undefined
  const rememberSelection = (): void => {
    const range = terminal.getSelectionPosition()
    if (!range || terminal.getSelection().toLowerCase() !== input.value.toLowerCase()) return
    selected?.marker.dispose()
    selected = { marker: terminal.registerMarker(range.start.y - terminal.buffer.active.baseY - terminal.buffer.active.cursorY), column: range.start.x,
      length: (range.end.y - range.start.y) * terminal.cols + range.end.x - range.start.x, term: input.value,
      line: terminal.buffer.active.getLine(range.start.y)?.translateToString(true) ?? '' }
  }
  const restoreSelection = (): void => {
    if (!selected || selected.marker.isDisposed || selected.term !== input.value || terminal.getSelection().toLowerCase() === selected.term.toLowerCase()) return
    const buffer = terminal.buffer.active
    if (buffer.getLine(selected.marker.line)?.translateToString(true) !== selected.line) {
      // ConPTY can repaint the same screen at a new buffer row after a resize, without moving old markers.
      let nearest: number | undefined
      for (let row = 0; row < buffer.length; row++) {
        if (buffer.getLine(row)?.translateToString(true) !== selected.line) continue
        if (nearest === undefined || Math.abs(row - selected.marker.line) < Math.abs(nearest - selected.marker.line)) nearest = row
      }
      if (nearest === undefined) { selected.marker.dispose(); selected = undefined; return }
      selected.marker.dispose()
      selected.marker = terminal.registerMarker(nearest - buffer.baseY - buffer.cursorY)
    }
    terminal.select(selected.column, selected.marker.line, selected.length)
    // A width change or repaint can replace the cells; never preserve an unrelated selection.
    if (terminal.getSelection().toLowerCase() !== selected.term.toLowerCase()) terminal.clearSelection()
  }
  const resultChanges = addon.onDidChangeResults(result => {
    const total = `${result.resultCount}${result.resultCount >= HIGHLIGHT_LIMIT ? '+' : ''}`
    count.textContent = !input.value ? '' : result.resultCount === 0 ? 'No matches' : result.resultIndex < 0 ? `${total} matches` : `${result.resultIndex + 1} of ${total}`
    previous.disabled = next.disabled = result.resultCount === 0
    if (result.resultIndex >= 0) rememberSelection()
  })
  const resizeChanges = terminal.onResize(restoreSelection)
  let paintedDecorations = ''
  const decorationColors = () => {
    const style = getComputedStyle(document.documentElement)
    const color = (name: string): string => resolve(style.getPropertyValue(name).trim())?.slice(0, 7) ?? terminal.options.theme?.foreground ?? '#dfe4e1'
    const border = color('--tt-accent')
    return {
      matchBorder: border, matchOverviewRuler: border,
      activeMatchBorder: color('--tt-text'), activeMatchColorOverviewRuler: border,
    }
  }
  const find = (backwards = false, incremental = false): void => {
    if (!input.value) {
      selected?.marker.dispose(); selected = undefined
      addon.clearDecorations()
      terminal.clearSelection()
      count.textContent = ''
      previous.disabled = next.disabled = true
      return
    }
    const decorations = decorationColors()
    paintedDecorations = JSON.stringify(decorations)
    const options = { incremental, decorations }
    restoreSelection()
    if (backwards) addon.findPrevious(input.value, options)
    else addon.findNext(input.value, options)
  }
  const hide = (): void => { bar.hidden = true; selected?.marker.dispose(); selected = undefined; onVisibilityChange?.(false); addon.clearDecorations(); terminal.clearSelection(); terminal.focus() }
  input.addEventListener('input', () => find(false, true))
  previous.addEventListener('click', () => find(true))
  next.addEventListener('click', () => find())
  close.addEventListener('click', hide)
  // Consume search actions only. Pane navigation, pane zoom and app shortcuts keep their existing route.
  bar.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide() }
    if (event.key === 'Enter') {
      if (event.target === input) { event.preventDefault(); find(event.shiftKey) }
      event.stopPropagation()
    }
  })
  previous.disabled = next.disabled = true
  return {
    mount(): void { element.append(bar) },
    open(): void { if (bar.hidden) { bar.hidden = false; onVisibilityChange?.(true); find(false, true) } input.focus(); input.select() },
    close(): boolean { if (bar.hidden) return false; hide(); return true },
    // The addon caches by query, not decoration colours. Rebuild highlights when the theme or grid changes.
    refresh(): void { if (!bar.hidden) { addon.clearDecorations(); find(false, true) } },
    refreshTheme(): void {
      if (!bar.hidden && paintedDecorations !== JSON.stringify(decorationColors())) { addon.clearDecorations(); find(false, true) }
    },
    dispose(): void { resultChanges.dispose(); resizeChanges.dispose(); selected?.marker.dispose(); bar.remove() },
  }
}
