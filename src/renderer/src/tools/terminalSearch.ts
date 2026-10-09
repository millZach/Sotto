import type { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'

const HIGHLIGHT_LIMIT = 1_000

/** The approved inline search bar, owned by the view so hiding a pane keeps its query and scrollback. */
export function terminalSearch(terminal: Terminal, element: HTMLElement, resolve: (css: string) => string | null) {
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
  const resultChanges = addon.onDidChangeResults(result => {
    const total = `${result.resultCount}${result.resultCount >= HIGHLIGHT_LIMIT ? '+' : ''}`
    count.textContent = !input.value ? '' : result.resultCount === 0 ? 'No matches' : result.resultIndex < 0 ? `${total} matches` : `${result.resultIndex + 1} of ${total}`
    previous.disabled = next.disabled = result.resultCount === 0
  })
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
      addon.clearDecorations()
      terminal.clearSelection()
      count.textContent = ''
      previous.disabled = next.disabled = true
      return
    }
    const decorations = decorationColors()
    paintedDecorations = JSON.stringify(decorations)
    const options = { incremental, decorations }
    if (backwards) addon.findPrevious(input.value, options)
    else addon.findNext(input.value, options)
  }
  const hide = (): void => { bar.hidden = true; addon.clearDecorations(); terminal.clearSelection(); terminal.focus() }
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
    open(): void { if (bar.hidden) { bar.hidden = false; find(false, true) } input.focus(); input.select() },
    close(): boolean { if (bar.hidden) return false; hide(); return true },
    // The addon caches by query, not decoration colours. Rebuild highlights when the theme or grid changes.
    refresh(): void { if (!bar.hidden) { addon.clearDecorations(); find(false, true) } },
    refreshTheme(): void {
      if (!bar.hidden && paintedDecorations !== JSON.stringify(decorationColors())) { addon.clearDecorations(); find(false, true) }
    },
    dispose(): void { resultChanges.dispose(); bar.remove() },
  }
}
