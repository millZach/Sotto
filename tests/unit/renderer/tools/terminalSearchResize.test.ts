import { expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { terminalSearch } from '../../../../src/renderer/src/tools/terminalSearch'

it.each(['needle', 'NEEDLE'])('keeps the selected %s match when a grid resize clears xterm selection before the next key', async match => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  try {
    terminal.open(element)
    await new Promise<void>(resolve => terminal.write(`alpha ${match} one\r\nbeta ${match} two\r\ngamma ${match} three`, resolve))
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    expect(element.querySelector('output')!.textContent).toBe('1 of 3')
    terminal.clearSelection(); terminal.resize(40, 6)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('2 of 3')
    // A second lost selection still advances from the remembered match, not from the buffer start.
    terminal.clearSelection()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('3 of 3')
    search.close()
    expect(terminal.hasSelection()).toBe(false)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.unstubAllGlobals() }
})
