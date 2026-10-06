import { afterEach, describe, expect, it } from 'vitest'
import { paneTerminalChord, paneTerminalShortcutLabel, paneTerminalTarget, type PaneTerminalShortcut } from '../../../../src/renderer/src/tools/paneTerminalShortcut'

const windows: PaneTerminalShortcut = { chord: 'mod+j', platform: 'win32', label: 'Ctrl+J', keys: 'Control+J' }
const mac: PaneTerminalShortcut = { chord: 'mod+j', platform: 'darwin', label: 'Cmd+J', keys: 'Meta+J' }

type ChordEvent = Parameters<typeof paneTerminalTarget>[0]
const keydown = (patch: Partial<ChordEvent> = {}): ChordEvent =>
  ({ key: 'j', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, repeat: false, target: document.body, ...patch })

/** Two panes, as a split shows them: each with a composer, and a drawer terminal in the first. */
function panes(): { readonly first: HTMLElement; readonly second: HTMLElement; readonly drawerTerminal: HTMLElement } {
  document.body.innerHTML = `
    <section class="thread-pane" data-thread-id="first"><button data-pane-terminal-toggle></button><textarea></textarea><div class="pane-terminal"><div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div></div></section>
    <section class="thread-pane" data-thread-id="second"><button data-pane-terminal-toggle></button><textarea></textarea></section>`
  const [first, second] = [...document.querySelectorAll<HTMLElement>('.thread-pane')] as [HTMLElement, HTMLElement]
  return { first, second, drawerTerminal: first.querySelector<HTMLElement>('.xterm-helper-textarea')! }
}

describe('the Terminal drawer shortcut', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('is Ctrl+J, or Cmd+J on a Mac, and steps aside when the dictation hotkey means it', () => {
    expect(paneTerminalChord(undefined, 'win32')).toBe('mod+j')
    expect(paneTerminalChord('Control+J', 'win32')).toBeNull()
    expect(paneTerminalChord('Command+J', 'darwin')).toBeNull()
    expect(paneTerminalChord('Control+Shift+Space', 'win32')).toBe('mod+j')
    expect(paneTerminalShortcutLabel('win32')).toBe('Ctrl+J')
    expect(paneTerminalShortcutLabel('darwin')).toBe('Cmd+J')
  })

  it('toggles the pane the key lands in, including from inside that pane’s own drawer terminal', () => {
    const { second, drawerTerminal } = panes()
    expect(paneTerminalTarget(keydown({ target: second.querySelector('textarea') }), windows, 'first')).toBe('second')
    expect(paneTerminalTarget(keydown({ target: drawerTerminal }), windows, 'second')).toBe('first')
    expect(paneTerminalTarget(keydown({ ctrlKey: false, metaKey: true, target: drawerTerminal }), mac, 'second')).toBe('first')
  })

  it('falls back to the selected thread’s pane only while that pane is on screen', () => {
    const { second } = panes()
    expect(paneTerminalTarget(keydown(), windows, 'second')).toBe('second')
    second.setAttribute('data-hidden', '')
    expect(paneTerminalTarget(keydown(), windows, 'second')).toBeNull()
    // No pane at all: Terminal mode or another page. The key is not the drawer's.
    document.body.innerHTML = ''
    expect(paneTerminalTarget(keydown(), windows, 'second')).toBeNull()
  })

  it('leaves the key alone in a pane with no drawer: Terminal mode’s panes, and a thread on a paired host', () => {
    // Terminal mode lays its terminals out in the same pane grid, with no drawer button in their headers.
    document.body.innerHTML = '<section class="thread-pane" data-thread-id="terminal-1"><button>Stop</button></section>'
    const control = document.querySelector('button')!
    expect(paneTerminalTarget(keydown({ target: control }), windows, 'terminal-1')).toBeNull()
    expect(paneTerminalTarget(keydown(), windows, 'terminal-1')).toBeNull()
  })

  it('leaves the key to a terminal that is not a drawer, so Tools and Terminal mode shells still get Ctrl+J', () => {
    panes()
    const tools = document.createElement('aside')
    tools.innerHTML = '<div class="xterm"><textarea></textarea></div>'
    document.body.appendChild(tools)
    expect(paneTerminalTarget(keydown({ target: tools.querySelector('textarea') }), windows, 'first')).toBeNull()
  })

  it('ignores another key, a handled or repeating keydown, and any keydown while a dialog is open', () => {
    panes()
    expect(paneTerminalTarget(keydown({ key: 'k' }), windows, 'first')).toBeNull()
    expect(paneTerminalTarget(keydown({ defaultPrevented: true }), windows, 'first')).toBeNull()
    expect(paneTerminalTarget(keydown({ repeat: true }), windows, 'first')).toBeNull()
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.appendChild(dialog)
    expect(paneTerminalTarget(keydown(), windows, 'first')).toBeNull()
  })
})
