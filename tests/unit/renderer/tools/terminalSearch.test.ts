import { afterEach, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
const search = vi.hoisted(() => ({ next: vi.fn(), previous: vi.fn(), clear: vi.fn(), results: vi.fn() as (result: { resultIndex: number; resultCount: number }) => void }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {
  findNext = search.next
  findPrevious = search.previous
  clearDecorations = search.clear
  onDidChangeResults(listener: typeof search.results) { search.results = listener; return { dispose: vi.fn() } }
} }))
import { terminalSearch } from '../../../../src/renderer/src/tools/terminalSearch'

afterEach(() => { document.body.replaceChildren(); document.documentElement.style.removeProperty('--tt-text'); vi.clearAllMocks() })

it('searches incrementally, shows results, navigates both ways and closes from any control with terminal focus restored', () => {
  const element = document.createElement('div'); document.body.append(element)
  const terminal = { options: { theme: { foreground: '#eeeeee' } }, loadAddon: vi.fn(), focus: vi.fn(), clearSelection: vi.fn() }
  const visibility = vi.fn()
  const view = terminalSearch(terminal as unknown as Terminal, element, () => '#123456', visibility)
  view.mount(); view.open()
  const input = element.querySelector('input')!, count = element.querySelector('output')!
  const [previous, next, close] = element.querySelectorAll('button')
  expect(document.activeElement).toBe(input)
  expect(visibility).toHaveBeenLastCalledWith(true)
  const pageKey = vi.fn()
  element.addEventListener('keydown', pageKey)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }))
  expect(pageKey).toHaveBeenCalledOnce()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
  expect(pageKey).toHaveBeenCalledTimes(2)
  for (const control of [input, previous!, next!, close!]) {
    for (const chord of [{ key: 'F6' }, { key: 'F6', shiftKey: true }, { key: 'M', ctrlKey: true, shiftKey: true }, { key: 'k', ctrlKey: true }, { key: 'k', metaKey: true }]) {
      pageKey.mockClear()
      control.dispatchEvent(new KeyboardEvent('keydown', { ...chord, bubbles: true }))
      expect(pageKey).toHaveBeenCalledOnce()
    }
  }
  expect(next!.disabled).toBe(true)
  input.value = 'match'; input.dispatchEvent(new Event('input'))
  expect(search.next).toHaveBeenLastCalledWith('match', expect.objectContaining({ incremental: true, decorations: expect.objectContaining({ matchBorder: '#123456' }) }))
  search.results({ resultIndex: 2, resultCount: 9 })
  expect(count.textContent).toBe('3 of 9')
  search.results({ resultIndex: 0, resultCount: 1_000 })
  expect(count.textContent).toBe('1 of 1000+')
  search.results({ resultIndex: -1, resultCount: 1_000 })
  expect(count.textContent).toBe('1000+ matches')
  expect(previous!.disabled).toBe(false)
  view.refresh()
  expect(search.clear).toHaveBeenCalled()
  expect(terminal.clearSelection).toHaveBeenCalled()
  expect(search.next).toHaveBeenLastCalledWith('match', expect.objectContaining({ incremental: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(search.next).toHaveBeenLastCalledWith('match', expect.objectContaining({ incremental: false }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
  expect(search.previous).toHaveBeenCalledWith('match', expect.anything())
  previous!.click(); next!.click()
  search.results({ resultIndex: -1, resultCount: 0 })
  expect(count.textContent).toBe('No matches')
  expect(next!.disabled).toBe(true)
  input.value = ''; input.dispatchEvent(new Event('input'))
  expect(count.textContent).toBe('')
  close!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(element.querySelector<HTMLElement>('[role="search"]')!.hidden).toBe(true)
  expect(visibility).toHaveBeenLastCalledWith(false)
  expect(terminal.focus).toHaveBeenCalledOnce()
  expect(search.clear).toHaveBeenCalled()
  view.open(); close!.click()
  expect(terminal.focus).toHaveBeenCalledTimes(2)
  view.dispose()
})

it('repaints a changed Text role even when the terminal theme is unchanged, and ignores unrelated root mutations', () => {
  const element = document.createElement('div'); document.body.append(element)
  const terminal = { options: { theme: { foreground: '#eeeeee' } }, loadAddon: vi.fn(), focus: vi.fn(), clearSelection: vi.fn() }
  const view = terminalSearch(terminal as unknown as Terminal, element, css => css || null)
  view.mount(); view.open()
  const input = element.querySelector('input')!
  input.value = 'match'; input.dispatchEvent(new Event('input'))
  search.next.mockClear(); search.clear.mockClear()
  view.refreshTheme()
  expect(search.next).not.toHaveBeenCalled()
  document.documentElement.style.setProperty('--tt-text', '#123456')
  view.refreshTheme()
  expect(search.clear).toHaveBeenCalledOnce()
  expect(search.next).toHaveBeenLastCalledWith('match', expect.objectContaining({ decorations: expect.objectContaining({ activeMatchBorder: '#123456' }) }))
  view.refreshTheme()
  expect(search.next).toHaveBeenCalledOnce()
  view.dispose()
})
