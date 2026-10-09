import type { IBuffer, IMarker, Terminal } from '@xterm/xterm'
import { externalLinkSchema } from '../../../shared/externalLinks'
import { terminalLineStart as firstRow, terminalLineText as lineText } from './terminalBuffer'

// The pinned web-links addon's URL boundaries, shared with its mouse provider (xterm.js authors, MIT).
export const TERMINAL_URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/u
export const isTerminalLink = (uri: string): boolean => /^https?:/iu.test(uri) && externalLinkSchema.safeParse(uri).success

interface NamedLink { uri: string; buffer: IBuffer; marker: IMarker; prefix: string; label: string }

/** The current cells under a named label, with Unicode widths and soft wraps accounted for. */
function labelCells(link: NamedLink): { row: number; start: number; end: number }[] {
  const cells: { row: number; start: number; end: number }[] = []
  const first = firstRow(link.buffer, link.marker.line), endOffset = link.prefix.length + link.label.length
  let offset = 0
  for (let row = first; row < link.buffer.length && offset < endOffset; row++) {
    const line = link.buffer.getLine(row)
    if (!line || row > first && !line.isWrapped) break
    for (let column = 0; column < line.length && offset < endOffset; column++) {
      const cell = line.getCell(column)
      if (!cell || !cell.getWidth()) continue
      const end = offset + (cell.getChars() || ' ').length
      if (end > link.prefix.length) {
        const previous = cells.at(-1)
        if (previous?.row === row) previous.end = column + cell.getWidth()
        else cells.push({ row, start: column, end: column + cell.getWidth() })
      }
      offset = end
    }
  }
  return cells
}

/** Observe OSC 8 through the public parser without consuming it; markers keep named links tied to scrollback. */
export function terminalLinkCatalog(terminal: Terminal) {
  const named = new Set<NamedLink>()
  let pending: NamedLink | undefined
  const finish = (): void => {
    if (!pending) return
    const link = pending
    pending = undefined
    const buffer = terminal.buffer.active
    if (buffer !== link.buffer || link.marker.isDisposed) { link.marker.dispose(); return }
    const text = lineText(buffer, link.marker.line, { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX })
    if (!text.startsWith(link.prefix)) { link.marker.dispose(); return }
    link.label = text.slice(link.prefix.length)
    if (!link.label.trim()) { link.marker.dispose(); return }
    for (const previous of named) {
      if (previous.buffer !== buffer || firstRow(buffer, previous.marker.line) !== firstRow(buffer, link.marker.line)) continue
      const overlap = previous.prefix.length < link.prefix.length + link.label.length && link.prefix.length < previous.prefix.length + previous.label.length
      if (overlap) previous.marker.dispose()
    }
    // Unsafe destinations also replace an older link at these cells, but never become picker entries.
    if (!isTerminalLink(link.uri)) { link.marker.dispose(); return }
    named.add(link)
    link.marker.onDispose(() => named.delete(link))
  }
  const osc = terminal.parser.registerOscHandler(8, data => {
    finish()
    const separator = data.indexOf(';'), uri = separator < 0 ? '' : data.slice(separator + 1)
    if (uri) {
      const buffer = terminal.buffer.active, row = buffer.baseY + buffer.cursorY
      pending = { uri, buffer, marker: terminal.registerMarker(0), prefix: lineText(buffer, row, { row, column: buffer.cursorX }), label: '' }
    }
    return false
  })
  const erasures = ['J', 'K'].map(final => terminal.parser.registerCsiHandler({ final }, params => {
    const mode = params[0] ?? 0
    const buffer = terminal.buffer.active, row = buffer.baseY + buffer.cursorY
    for (const link of named) {
      if (link.buffer !== buffer) continue
      const affected = labelCells(link).some(cells => {
        if (final === 'K') return cells.row === row && (mode === 2 || mode === 0 && cells.end > buffer.cursorX || mode === 1 && cells.start <= buffer.cursorX)
        if (mode === 0) return cells.row > row || cells.row === row && cells.end > buffer.cursorX
        if (mode === 1) return cells.row >= buffer.baseY && (cells.row < row || cells.row === row && cells.start <= buffer.cursorX)
        return mode === 2 && cells.row >= buffer.baseY
      })
      if (affected) link.marker.dispose()
    }
    return false
  }))
  const clear = (): void => {
    pending?.marker.dispose(); pending = undefined
    for (const link of named) link.marker.dispose()
    named.clear()
  }
  return {
    list(): { uri: string; label: string }[] {
      const buffer = terminal.buffer.active
      const links = new Map<string, { uri: string; label: string }>()
      for (const link of named) {
        if (link.marker.isDisposed) { named.delete(link); continue }
        if (link.buffer !== buffer) continue
        // A repaint can erase a label without trimming its row; do not offer a link whose text disappeared.
        if (!lineText(buffer, link.marker.line).startsWith(link.prefix + link.label)) { link.marker.dispose(); continue }
        links.set(`${link.uri}\n${link.label}`, { uri: link.uri, label: link.label.trim() })
      }
      let text = ''
      const collect = (): void => {
        for (const match of text.matchAll(new RegExp(TERMINAL_URL_PATTERN.source, 'gu'))) {
          const uri = match[0]
          if (isTerminalLink(uri)) links.set(`${uri}\n${uri}`, { uri, label: uri })
        }
        text = ''
      }
      for (let y = 0; y < buffer.length; y++) {
        const wraps = buffer.getLine(y + 1)?.isWrapped
        text += buffer.getLine(y)?.translateToString(!wraps) ?? ''
        if (!wraps) collect()
      }
      return [...links.values()]
    },
    clear,
    dispose(): void { osc.dispose(); for (const erase of erasures) erase.dispose(); clear() },
  }
}

/** A keyboard path to both visible URL text and the destinations behind OSC 8 labels. */
export function terminalLinkPicker(element: HTMLElement, catalog: ReturnType<typeof terminalLinkCatalog>, openLink: (uri: string) => void) {
  const panel = document.createElement('section')
  panel.className = 'terminal-links'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Open terminal link')
  panel.setAttribute('popover', 'auto')
  let returnFocus: HTMLElement | null = null
  const hide = (): void => { panel.hidePopover?.(); panel.hidden = true; panel.remove(); returnFocus?.focus() }
  panel.addEventListener('toggle', event => { if ((event as ToggleEvent).newState === 'closed' && !panel.hidden) hide() })
  return {
    open(): void {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      panel.replaceChildren()
      const header = document.createElement('header'), title = document.createElement('strong'), close = document.createElement('button')
      title.textContent = 'Open terminal link'
      close.type = 'button'; close.textContent = 'Close'; close.setAttribute('aria-label', 'Close terminal links')
      close.addEventListener('click', hide)
      header.append(title, close); panel.append(header)
      const list = document.createElement('div')
      list.className = 'terminal-links__list'
      for (const link of catalog.list()) {
        const button = document.createElement('button'), label = document.createElement('span'), destination = document.createElement('small')
        button.type = 'button'; button.setAttribute('aria-label', `Open ${link.label}`)
        label.textContent = link.label; destination.textContent = link.uri
        button.append(label, destination)
        button.addEventListener('click', () => { openLink(link.uri); hide() })
        list.append(button)
      }
      if (!list.childElementCount) { const empty = document.createElement('p'); empty.textContent = 'No web links in this output.'; list.append(empty) }
      panel.append(list); panel.hidden = false; element.append(panel)
      // The top layer escapes a short drawer's clipping while the DOM stays inside its keyboard/focus boundary.
      const anchor = returnFocus?.getBoundingClientRect() ?? element.getBoundingClientRect()
      const width = Math.min(360, window.innerWidth - 24)
      panel.style.width = `${width}px`
      panel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`
      panel.style.top = '12px'
      panel.style.maxHeight = `${window.innerHeight - 24}px`
      panel.showPopover?.()
      const height = panel.getBoundingClientRect().height
      panel.style.top = `${Math.max(12, Math.min(anchor.bottom + 8 + height <= window.innerHeight - 12 ? anchor.bottom + 8 : anchor.top - height - 8, window.innerHeight - height - 12))}px`
      ;(list.querySelector('button') ?? close).focus()
    },
    close(): boolean { if (panel.hidden) return false; hide(); return true },
    dispose(): void { panel.remove() },
  }
}
