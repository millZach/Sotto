import { afterEach, describe, expect, it, vi } from 'vitest'

type KeyHandler = (event: KeyboardEvent) => boolean
const xterm = vi.hoisted(() => ({ instances: [] as { options: Record<string, unknown>; keys?: KeyHandler; selection: string; cleared: number }[] }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose(): void {} onContextLoss(): void {} } }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly options: Record<string, unknown>
    keys?: KeyHandler
    selection = 'selected text'
    cleared = 0
    constructor(options: Record<string, unknown>) { this.options = { ...options }; xterm.instances.push(this) }
    loadAddon(): void {}
    onData(): void {}
    attachCustomKeyEventHandler(handler: KeyHandler): void { this.keys = handler }
    hasSelection(): boolean { return this.selection.length > 0 }
    getSelection(): string { return this.selection }
    clearSelection(): void { this.selection = ''; this.cleared += 1 }
    onSelectionChange(): { dispose(): void } { return { dispose() {} } }
    getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
      return this.selection ? { start: { x: 0, y: 0 }, end: { x: 13, y: 0 } } : undefined
    }
    open(): void {}
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions(): undefined { return undefined } } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
const clipboard = vi.hoisted(() => ({ writeText: undefined as undefined | ((text: string) => Promise<void>) }))
vi.mock('../../../../src/renderer/src/agents/richActions', () => ({ writeClipboard: (text: string) => clipboard.writeText!(text) }))

const { createXtermView } = await import('../../../../src/renderer/src/tools/terminalView')

function terminalOn(platform: 'win32' | 'darwin') {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('sotto', { platform })
  const writeText = vi.fn(async () => undefined)
  clipboard.writeText = writeText
  const onInterrupt = vi.fn()
  const view = createXtermView({ onInput() {}, onInterrupt }, { resolveColor: css => css.startsWith('#') ? css : null })
  view.setInputEnabled(true)
  const terminal = xterm.instances.at(-1)!
  const press = (key: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}): boolean =>
    terminal.keys!(new KeyboardEvent('keydown', { key, ...modifiers }))
  return { view, terminal, press, onInterrupt, writeText }
}

afterEach(() => { vi.unstubAllGlobals(); xterm.instances.length = 0 })

describe('terminal keys', () => {
  it('copies a selection with Ctrl+C on Windows, interrupts without one, and leaves Ctrl+V to the paste event', async () => {
    const { view, terminal, press, onInterrupt, writeText } = terminalOn('win32')
    expect(press('c', { ctrlKey: true })).toBe(false)
    expect(writeText).toHaveBeenCalledWith('selected text')
    expect(onInterrupt).not.toHaveBeenCalled()
    // The copied selection clears once the clipboard write lands.
    await vi.waitFor(() => expect(terminal.cleared).toBe(1))
    expect(press('c', { ctrlKey: true })).toBe(false)
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(press('v', { ctrlKey: true })).toBe(false)
    expect(terminal.options.macOptionIsMeta).toBeUndefined()
    view.dispose()
  })

  it('always interrupts with Ctrl+C on macOS, even over a selection, and sends Ctrl+V to the shell', () => {
    const { view, terminal, press, onInterrupt, writeText } = terminalOn('darwin')
    expect(press('c', { ctrlKey: true })).toBe(false)
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
    expect(terminal.cleared).toBe(0)
    expect(press('v', { ctrlKey: true })).toBe(true)
    view.dispose()
  })

  it('leaves ⌘C and ⌘V to the Edit menu on macOS and treats Option as Meta', () => {
    const { view, terminal, press, onInterrupt, writeText } = terminalOn('darwin')
    expect(press('c', { metaKey: true })).toBe(true)
    expect(press('v', { metaKey: true })).toBe(true)
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(terminal.options.macOptionIsMeta).toBe(true)
    view.dispose()
  })
})
