import { i18n } from '@lingui/core'
import { plural, t } from '@lingui/core/macro'
import type { IMarker, Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { terminalLineStart, terminalLineText, terminalTextPosition } from './terminalBuffer'
import { shownCount } from '../state/interfaceNumbers'

const HIGHLIGHT_LIMIT = 1_000

/** The approved inline search bar, owned by the view so hiding a pane keeps its query and scrollback. */
export function terminalSearch(terminal: Terminal, element: HTMLElement, resolve: (css: string) => string | null, onVisibilityChange?: (open: boolean) => void, onOpenLinks?: () => void) {
  const addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT })
  terminal.loadAddon(addon)
  const bar = document.createElement('div')
  bar.className = 'terminal-search'
  bar.hidden = true
  bar.setAttribute('role', 'search')
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  const count = document.createElement('output')
  count.setAttribute('aria-live', 'polite')
  const button = (path: string): HTMLButtonElement => {
    const control = document.createElement('button')
    control.type = 'button'
    control.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`
    return control
  }
  const previous = button('m18 15-6-6-6 6')
  const next = button('m6 9 6 6 6-6')
  const close = button('M18 6 6 18M6 6l12 12')
  bar.append(input, count, previous, next, close)
  const links = onOpenLinks ? button('M15 3h6v6M10 14 21 3M21 14v7H3V3h7') : null
  if (links && onOpenLinks) {
    links.addEventListener('click', onOpenLinks)
    bar.insertBefore(links, close)
  }
  let results: { readonly resultIndex: number; readonly resultCount: number } | null = null
  /** The count in the interface language. English writes it as it always has, ungrouped: "1000+", "3 of 1000". */
  const showCount = (): void => {
    if (!input.value || results === null) { count.textContent = ''; return }
    const found = results.resultCount, position = shownCount(results.resultIndex + 1)
    const total = `${shownCount(found)}${found >= HIGHLIGHT_LIMIT ? '+' : ''}`
    count.textContent = found === 0 ? t`No matches`
      : results.resultIndex < 0 ? plural(found, { other: `${total} matches` })
        : t({ message: `${position} of ${total}`, comment: 'Which match of the found ones is selected, as in "3 of 12".' })
  }
  const label = (control: HTMLButtonElement, name: string, title: string): void => { control.setAttribute('aria-label', name); control.title = title }
  /** The bar's words in the interface language: set again whenever the language changes, and each time the bar opens. */
  const showWords = (): void => {
    bar.setAttribute('aria-label', t`Search terminal output`)
    input.placeholder = t({ message: 'Find', comment: 'Placeholder of the field that finds text in a terminal\'s output.' })
    input.setAttribute('aria-label', t`Find in terminal`)
    label(previous, t`Previous match`, t`Previous match (Shift+Enter)`)
    label(next, t`Next match`, t`Next match (Enter)`)
    label(close, t`Close search`, t`Close search (Escape)`)
    if (links) label(links, t`Open terminal link`, t`Open terminal link`)
    showCount()
  }
  showWords()
  const languageChanges = i18n.on('change', showWords)
  let selected: { marker: IMarker; row: number; offset: number; endOffset: number; term: string; line: string } | undefined
  let rebuildHighlights = false
  const rememberSelection = (): void => {
    const range = terminal.getSelectionPosition()
    if (!range || terminal.getSelection().toLowerCase() !== input.value.toLowerCase()) return
    selected?.marker.dispose()
    const buffer = terminal.buffer.active, row = terminalLineStart(buffer, range.start.y)
    const offset = terminalLineText(buffer, row, { row: range.start.y, column: range.start.x }).length
    selected = { marker: terminal.registerMarker(row - buffer.baseY - buffer.cursorY), row, offset,
      endOffset: offset + terminal.getSelection().length, term: input.value,
      line: terminalLineText(buffer, row) }
  }
  const restoreSelection = (): void => {
    if (!selected || selected.term !== input.value) return
    const buffer = terminal.buffer.active
    const range = terminal.getSelectionPosition()
    if (range && terminal.getSelection().toLowerCase() === selected.term.toLowerCase() && terminalLineText(buffer, range.start.y) === selected.line && terminalLineText(buffer, range.start.y, { row: range.start.y, column: range.start.x }).length === selected.offset) {
      selected.row = terminalLineStart(buffer, range.start.y)
      return
    }
    const rememberedRow = selected.marker.isDisposed ? selected.row : selected.marker.line
    if (selected.marker.isDisposed || terminalLineText(buffer, rememberedRow) !== selected.line) {
      rebuildHighlights = true
      // ConPTY can erase a marker or repaint its logical line at a new row after a resize.
      let nearest: number | undefined
      for (let row = 0; row < buffer.length; row++) {
        if (buffer.getLine(row)?.isWrapped || terminalLineText(buffer, row) !== selected.line) continue
        if (nearest === undefined || Math.abs(row - rememberedRow) < Math.abs(nearest - rememberedRow)) nearest = row
      }
      if (nearest === undefined) { selected.marker.dispose(); selected = undefined; return }
      selected.marker.dispose()
      selected.marker = terminal.registerMarker(nearest - buffer.baseY - buffer.cursorY)
    }
    selected.row = selected.marker.line
    const firstRow = terminalLineStart(buffer, selected.marker.line)
    const position = terminalTextPosition(buffer, firstRow, selected.offset)
    const last = terminalTextPosition(buffer, firstRow, selected.endOffset - 1)
    const width = last && buffer.getLine(last.row)?.getCell(last.column)?.getWidth()
    if (!position || !last || !width) return
    // Reflow can add an empty cell before a wrapped wide glyph; both endpoints belong to the current grid.
    const length = (last.row - position.row) * terminal.cols + last.column + width - position.column
    terminal.select(position.column, position.row, length)
    // A width change or repaint can replace the cells; never preserve an unrelated selection.
    if (terminal.getSelection().toLowerCase() !== selected.term.toLowerCase()) terminal.clearSelection()
  }
  const resultChanges = addon.onDidChangeResults(result => {
    results = { resultIndex: result.resultIndex, resultCount: result.resultCount }
    showCount()
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
      rebuildHighlights = false
      addon.clearDecorations()
      terminal.clearSelection()
      results = null
      count.textContent = ''
      previous.disabled = next.disabled = true
      return
    }
    const decorations = decorationColors()
    paintedDecorations = JSON.stringify(decorations)
    const options = { incremental, decorations }
    restoreSelection()
    if (rebuildHighlights) {
      rebuildHighlights = false
      addon.clearDecorations()
      // Repainted result positions must be rebuilt at the retained match before navigation advances.
      if (selected && selected.term === input.value && !incremental) addon.findNext(input.value, { incremental: true, decorations })
    }
    if (backwards) addon.findPrevious(input.value, options)
    else addon.findNext(input.value, options)
  }
  const hide = (): void => { bar.hidden = true; selected?.marker.dispose(); selected = undefined; rebuildHighlights = false; onVisibilityChange?.(false); addon.clearDecorations(); terminal.clearSelection(); terminal.focus() }
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
    isOpen(): boolean { return !bar.hidden },
    open(): void { if (bar.hidden) { bar.hidden = false; showWords(); onVisibilityChange?.(true); find(false, true) } input.focus(); input.select() },
    close(): boolean { if (bar.hidden) return false; hide(); return true },
    // The addon caches by query, not decoration colours. Rebuild highlights when the theme or grid changes.
    refresh(): void { if (!bar.hidden) { addon.clearDecorations(); find(false, true) } },
    refreshTheme(): void {
      if (!bar.hidden && paintedDecorations !== JSON.stringify(decorationColors())) { addon.clearDecorations(); find(false, true) }
    },
    dispose(): void { languageChanges(); resultChanges.dispose(); resizeChanges.dispose(); selected?.marker.dispose(); bar.remove() },
  }
}
