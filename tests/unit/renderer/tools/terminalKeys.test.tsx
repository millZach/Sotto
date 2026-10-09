import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import { setTerminalPreferences } from '../../../../src/renderer/src/tools/terminalPreferences'

type KeyHandler = (event: KeyboardEvent) => boolean
const xterm = vi.hoisted(() => ({ instances: [] as { options: Record<string, unknown>; keys?: KeyHandler; selection: string; cleared: number }[] }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose(): void {} onContextLoss(): void {} } }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    readonly unicode = { activeVersion: "6" }
    readonly parser = { registerOscHandler: () => ({ dispose() {} }), registerCsiHandler: () => ({ dispose() {} }) }
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
    onResize(): { dispose(): void } { return { dispose() {} } }
    getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
      return this.selection ? { start: { x: 0, y: 0 }, end: { x: 13, y: 0 } } : undefined
    }
    focus(): void {}
    open(): void {}
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions(): undefined { return undefined } } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
const clipboard = vi.hoisted(() => ({ writeText: undefined as undefined | ((text: string) => Promise<void>) }))
const links = vi.hoisted(() => ({ activate: vi.fn() as (event: MouseEvent, uri: string) => void }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { constructor(activate: typeof links.activate) { links.activate = activate } } }))
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
  it.each(['win32', 'darwin'] as const)('opens URL and OSC 8 links on the platform modifier only, and refuses other schemes on %s', async platform => {
    const { view, terminal } = terminalOn(platform)
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('sotto', { platform, openExternalLink })
    const osc = (terminal.options.linkHandler as { activate: typeof links.activate }).activate
    const modifiers = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }
    for (const activate of [links.activate, osc]) {
      activate(new MouseEvent('click'), 'https://example.com')
      activate(new MouseEvent('click', { altKey: true, ...modifiers }), 'https://example.com')
      for (const uri of ['file:///tmp/a', 'javascript:alert(1)', 'mailto:a@example.com', 'https://user:pass@example.com', 'https://example.com/\u000a']) activate(new MouseEvent('click', modifiers), uri)
      expect(openExternalLink).not.toHaveBeenCalled()
    }
    links.activate(new MouseEvent('click', modifiers), 'https://example.com')
    osc(new MouseEvent('click', modifiers), 'http://example.com/docs')
    await Promise.resolve()
    expect(openExternalLink.mock.calls).toEqual([['https://example.com'], ['http://example.com/docs']])
    view.dispose()
  })

  it('does not send claimed chords to the shell, but yields search to a conflicting dictation chord', () => {
    const { view, press } = terminalOn('win32')
    setTerminalPreferences(DEFAULT_SETTINGS, async () => true)
    expect(press('f', { ctrlKey: true })).toBe(false)
    expect(press('Escape')).toBe(false)
    expect(press('Escape')).toBe(true)
    setTerminalPreferences({ ...DEFAULT_SETTINGS, hotkey: 'Control+F' }, async () => true)
    expect(press('f', { ctrlKey: true })).toBe(true)
    setTerminalPreferences(DEFAULT_SETTINGS, async () => true)
    view.dispose()
  })
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

  it('leaves ⌘C and ⌘V to the Edit menu on macOS and Option to the keyboard layout', () => {
    const { view, terminal, press, onInterrupt, writeText } = terminalOn('darwin')
    expect(press('c', { metaKey: true })).toBe(true)
    expect(press('v', { metaKey: true })).toBe(true)
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    // Option types @, | and [ on Spanish, German and French layouts; Meta would swallow them.
    expect(terminal.options.macOptionIsMeta).toBeUndefined()
    view.dispose()
  })
})
