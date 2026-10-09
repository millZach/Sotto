import type { IBuffer, IMarker, Terminal } from '@xterm/xterm'
import { externalLinkSchema } from '../../../shared/externalLinks'

// The pinned web-links addon's URL boundaries, shared with its mouse provider (xterm.js authors, MIT).
export const TERMINAL_URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/u
export const isTerminalLink = (uri: string): boolean => /^https?:/iu.test(uri) && externalLinkSchema.safeParse(uri).success

interface NamedLink { uri: string; buffer: IBuffer; marker: IMarker; prefix: string; label: string }

/** Read a logical line across soft wraps, optionally ending at the current cursor. */
function lineText(buffer: IBuffer, row: number, end?: { row: number; column: number }): string {
  let first = row
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let text = ''
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line || (y > first && !line.isWrapped)) break
    if (end && y === end.row) return text + line.translateToString(false, 0, end.column)
    const wraps = buffer.getLine(y + 1)?.isWrapped
    text += line.translateToString(!wraps)
  }
  return text
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
    named.add(link)
    link.marker.onDispose(() => named.delete(link))
  }
  const osc = terminal.parser.registerOscHandler(8, data => {
    finish()
    const separator = data.indexOf(';'), uri = separator < 0 ? '' : data.slice(separator + 1)
    if (isTerminalLink(uri)) {
      const buffer = terminal.buffer.active, row = buffer.baseY + buffer.cursorY
      pending = { uri, buffer, marker: terminal.registerMarker(0), prefix: lineText(buffer, row, { row, column: buffer.cursorX }), label: '' }
    }
    return false
  })
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
    dispose(): void { osc.dispose(); clear() },
  }
}

/** A keyboard path to both visible URL text and the destinations behind OSC 8 labels. */
export function terminalLinkPicker(element: HTMLElement, catalog: ReturnType<typeof terminalLinkCatalog>, openLink: (uri: string) => void) {
  const panel = document.createElement('section')
  panel.className = 'terminal-links'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Open terminal link')
  let returnFocus: HTMLElement | null = null
  const hide = (): void => { panel.hidden = true; panel.remove(); returnFocus?.focus() }
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
      ;(list.querySelector('button') ?? close).focus()
    },
    close(): boolean { if (panel.hidden) return false; hide(); return true },
    dispose(): void { panel.remove() },
  }
}
