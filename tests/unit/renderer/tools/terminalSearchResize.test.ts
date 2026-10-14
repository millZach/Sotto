import { expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
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

it('keeps navigation on the same logical match after a narrower grid reflows its long prefix', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  try {
    terminal.open(element)
    await new Promise<void>(resolve => terminal.write(`needle one\r\n${'x'.repeat(30)}needle two\r\nneedle three`, resolve))
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('2 of 3')
    terminal.clearSelection(); terminal.resize(20, 8)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(element.querySelector('output')!.textContent).toBe('3 of 3'))
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.unstubAllGlobals() }
})

it.each(['a界b', 'a😀b'])('keeps the whole %s match when a narrow grid wraps its wide glyph past an empty cell', async match => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  try {
    terminal.open(element)
    await new Promise<void>(resolve => terminal.write(`${match} one\r\n${'x'.repeat(18)}${match} two\r\n${match} three`, resolve))
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = match; field.dispatchEvent(new Event('input'))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('2 of 3')
    terminal.clearSelection(); terminal.resize(20, 8)
    expect(terminal.getSelection()).toBe(match)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(element.querySelector('output')!.textContent).toBe('3 of 3'))
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.unstubAllGlobals() }
})

it('follows the current match when ConPTY repaints the screen at a new buffer row', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    await write('ready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    expect(element.querySelector('output')!.textContent).toBe('1 of 3')
    await write('\x1b[Hready\x1b[K\r\nready\x1b[K\r\nalpha needle one\x1b[K\r\nbeta needle two\x1b[K\r\ngamma needle three\x1b[K')
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(element.querySelector('output')!.textContent).toBe('2 of 3'))
    expect(terminal.getSelectionPosition()?.start.y).toBe(3)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.unstubAllGlobals() }
})

it('advances from the retained match after an erased screen disposes its marker during drawer reopen', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const markers = vi.spyOn(terminal, 'registerMarker')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    const output = 'ready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three'
    await write(output)
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    expect(element.querySelector('output')!.textContent).toBe('1 of 3')
    const marker = markers.mock.results.at(-1)!.value
    vi.useFakeTimers()
    element.remove()
    const repaint = write('\x1b[H\x1b[2J' + output)
    await vi.advanceTimersByTimeAsync(0); await repaint
    expect(marker.isDisposed).toBe(true)
    terminal.clearSelection(); terminal.resize(40, 6)
    document.body.append(element); search.open(); search.open()
    expect(element.querySelector('output')!.textContent).toBe('1 of 3')
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 6])
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('2 of 3')
  } finally { search.dispose(); terminal.dispose(); element.remove(); markers.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals() }
})

it.each(['before Enter', 'after Enter'])('keeps the second erased-screen match when refresh runs %s', async order => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    await write('ready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    search.mount(); search.open()
    const field = element.querySelector('input')!, count = element.querySelector('output')!
    const enter = (backwards = false) => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: backwards, bubbles: true }))
    field.value = 'needle'; field.dispatchEvent(new Event('input')); enter()
    expect(count.textContent).toBe('2 of 3')
    vi.useFakeTimers()
    const repaint = write('\x1b[H\x1b[2Jready\r\nready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    await vi.advanceTimersByTimeAsync(0); await repaint
    terminal.clearSelection(); terminal.resize(40, 6)
    search.open(); search.open()
    if (order === 'before Enter') { search.refresh(); expect(count.textContent).toBe('2 of 3') }
    enter(); expect(count.textContent).toBe('3 of 3')
    if (order === 'after Enter') search.refresh()
    await vi.advanceTimersByTimeAsync(200)
    expect(count.textContent).toBe('3 of 3')
    enter(true); expect(count.textContent).toBe('2 of 3')
    expect(terminal.getSelectionPosition()?.start.y).toBe(3)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals() }
})

it.each(['missing', 'changed'])('forgets an erased-screen match whose original logical line is %s', async scenario => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    await write('ready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    search.mount(); search.open()
    const field = element.querySelector('input')!, count = element.querySelector('output')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    expect(count.textContent).toBe('1 of 3')
    vi.useFakeTimers()
    const first = scenario === 'changed' ? 'changed needle first\r\n' : ''
    const repaint = write('\x1b[H\x1b[2Jready\r\n' + first + 'beta needle two\r\ngamma needle three')
    await vi.advanceTimersByTimeAsync(0); await repaint
    terminal.clearSelection(); terminal.resize(40, 6)
    expect(terminal.hasSelection()).toBe(false)
    search.refresh()
    const total = scenario === 'changed' ? 3 : 2
    expect(count.textContent).toBe(`1 of ${total}`)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(count.textContent).toBe(`2 of ${total}`)
    expect(terminal.getSelectionPosition()?.start.y).toBe(2)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals() }
})

it('relocates a disposed marker to the nearest surviving duplicate line using its last known row', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    const output = 'ready\r\nneedle same\r\nneedle same\r\nneedle same'
    await write(output)
    search.mount(); search.open()
    const field = element.querySelector('input')!
    field.value = 'needle'; field.dispatchEvent(new Event('input'))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(terminal.getSelectionPosition()?.start.y).toBe(2)
    vi.useFakeTimers()
    const repaint = write('\x1b[H\x1b[2J' + output)
    await vi.advanceTimersByTimeAsync(0); await repaint
    terminal.clearSelection(); terminal.resize(40, 6)
    search.refresh()
    expect(terminal.getSelectionPosition()?.start.y).toBe(2)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(element.querySelector('output')!.textContent).toBe('3 of 3')
    expect(terminal.getSelectionPosition()?.start.y).toBe(3)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals() }
})

it.each(['previous', 'empty query', 'close'] as const)('handles %s while repaint highlights are waiting to rebuild', async action => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  const element = document.body.appendChild(document.createElement('div'))
  const search = terminalSearch(terminal, element, () => '#123456')
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
  try {
    terminal.open(element)
    await write('ready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    search.mount(); search.open()
    const field = element.querySelector('input')!, count = element.querySelector('output')!
    const enter = (backwards = false) => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: backwards, bubbles: true }))
    field.value = 'needle'; field.dispatchEvent(new Event('input')); enter()
    expect(count.textContent).toBe('2 of 3')
    vi.useFakeTimers()
    const repaint = write('\x1b[H\x1b[2Jready\r\nready\r\nalpha needle one\r\nbeta needle two\r\ngamma needle three')
    await vi.advanceTimersByTimeAsync(0); await repaint
    terminal.clearSelection(); terminal.resize(40, 6)
    if (action === 'previous') enter(true)
    else if (action === 'empty query') {
      field.value = ''; field.dispatchEvent(new Event('input'))
      expect(count.textContent).toBe(''); expect(terminal.hasSelection()).toBe(false)
      field.value = 'needle'; field.dispatchEvent(new Event('input'))
    } else {
      expect(search.close()).toBe(true); expect(terminal.hasSelection()).toBe(false)
      search.open()
    }
    expect(count.textContent).toBe('1 of 3')
    expect(terminal.getSelectionPosition()?.start.y).toBe(2)
    enter(); expect(count.textContent).toBe('2 of 3')
    expect(terminal.getSelectionPosition()?.start.y).toBe(3)
  } finally { search.dispose(); terminal.dispose(); element.remove(); vi.useRealTimers(); vi.unstubAllGlobals() }
})
