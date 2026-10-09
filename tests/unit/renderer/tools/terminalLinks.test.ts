import { expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { terminalLinkCatalog, terminalLinkPicker } from '../../../../src/renderer/src/tools/terminalLinks'

const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
const osc = (uri: string, label: string) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`

it('offers safe plain URLs and named OSC 8 links across writes, wraps and buffers', async () => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 8, scrollback: 10 })
  const catalog = terminalLinkCatalog(terminal)
  try {
    await write(terminal, 'OSC \x1b]8;;https://example.com/docs\x1b\\project ')
    await write(terminal, 'docs\x1b]8;;\x1b\\\r\nURL https://example.com/long-path\r\n')
    await write(terminal, osc('file:///tmp/no', 'blocked file') + '\r\n' + osc('https://user:pass@example.com', 'blocked credentials'))
    expect(catalog.list()).toEqual([{ uri: 'https://example.com/docs', label: 'project docs' }, { uri: 'https://example.com/long-path', label: 'https://example.com/long-path' }])
    terminal.resize(16, 8)
    expect(catalog.list()).toContainEqual({ uri: 'https://example.com/docs', label: 'project docs' })
    await write(terminal, '\x1b[?1049h' + osc('https://example.com/alternate', 'alternate docs'))
    expect(catalog.list()).toEqual([{ uri: 'https://example.com/alternate', label: 'alternate docs' }])
    await write(terminal, '\x1b[?1049l')
    expect(catalog.list()).toContainEqual({ uri: 'https://example.com/docs', label: 'project docs' })
    await write(terminal, '\x1b[2J\x1b[Hdifferent output')
    expect(catalog.list()).not.toContainEqual({ uri: 'https://example.com/docs', label: 'project docs' })
    catalog.clear()
    expect(catalog.list()).toEqual([])
  } finally { catalog.dispose(); terminal.dispose() }
})

it('drops named links when their rows leave scrollback', async () => {
  const terminal = new Terminal({ allowProposedApi: true, rows: 2, scrollback: 2 })
  const catalog = terminalLinkCatalog(terminal)
  try {
    await write(terminal, osc('https://example.com/old', 'old docs') + '\r\n')
    expect(catalog.list()).toHaveLength(1)
    await write(terminal, 'new output\r\n'.repeat(8))
    expect(catalog.list()).toEqual([])
  } finally { catalog.dispose(); terminal.dispose() }
})

it('provides named destinations, native keyboard controls, empty feedback and focus restoration', () => {
  const element = document.createElement('div'), trigger = document.createElement('button')
  document.body.append(element, trigger); trigger.focus()
  const catalog = { list: vi.fn(() => [{ uri: 'https://example.com/docs', label: 'project docs' }]), clear() {}, dispose() {} }
  const open = vi.fn(), picker = terminalLinkPicker(element, catalog, open)
  try {
    picker.open()
    const link = element.querySelector<HTMLButtonElement>('[aria-label="Open project docs"]')!
    expect(document.activeElement).toBe(link)
    expect(link.textContent).toContain('https://example.com/docs')
    link.click()
    expect(open).toHaveBeenCalledWith('https://example.com/docs')
    expect(document.activeElement).toBe(trigger)
    expect(picker.close()).toBe(false)
    catalog.list.mockReturnValue([]); picker.open()
    expect(element.textContent).toContain('No web links in this output.')
    expect(picker.close()).toBe(true)
    expect(document.activeElement).toBe(trigger)
  } finally { picker.dispose(); element.remove(); trigger.remove() }
})
