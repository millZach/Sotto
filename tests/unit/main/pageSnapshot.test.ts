// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatSnapshot, keyEvents, modifierMask, type AXNode } from '../../../src/main/tools/pageSnapshot'

const node = (nodeId: string, role: string, name: string, extra: Partial<AXNode> = {}): AXNode => ({ nodeId, role: { value: role }, name: { value: name }, ...extra })

describe('a page snapshot as an agent reads it (ADR-0220)', () => {
  it('lists what means something, with names, values, states and refs to act by', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', 'Bench', { childIds: ['2', '3', '6'] }),
      node('2', 'heading', 'Parity bench', { parentId: '1', backendDOMNodeId: 10, properties: [{ name: 'level', value: { value: 1 } }] }),
      node('3', 'generic', '', { parentId: '1', childIds: ['4', '5'] }),
      node('4', 'button', 'Confirm', { parentId: '3', backendDOMNodeId: 11, properties: [{ name: 'focused', value: { value: true } }] }),
      node('5', 'textbox', 'Name', { parentId: '3', backendDOMNodeId: 12, value: { value: 'Rez' }, properties: [{ name: 'required', value: { value: true } }, { name: 'disabled', value: { value: false } }] }),
      node('6', 'checkbox', 'Remember', { parentId: '1', backendDOMNodeId: 13, properties: [{ name: 'checked', value: { value: 'mixed' } }] }),
    ]
    const { tree, refs, truncated } = formatSnapshot(nodes)
    expect(tree.split('\n')).toEqual([
      '- heading "Parity bench" [level=1] [ref=e1]',
      '- button "Confirm" [focused] [ref=e2]',
      '- textbox "Name" value="Rez" [required] [ref=e3]',
      '- checkbox "Remember" [checked=mixed] [ref=e4]',
    ])
    expect([...refs]).toEqual([['e1', 10], ['e2', 11], ['e3', 12], ['e4', 13]])
    expect(truncated).toBe(false)
  })

  it('indents children under what they belong to and skips ignored nodes', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', '', { childIds: ['2', '4'] }),
      node('2', 'list', 'Trails', { parentId: '1', childIds: ['3'] }),
      node('3', 'listitem', 'Ridge', { parentId: '2', backendDOMNodeId: 20 }),
      node('4', 'button', 'Hidden', { parentId: '1', ignored: true, backendDOMNodeId: 21 }),
    ]
    expect(formatSnapshot(nodes).tree).toBe('- list "Trails"\n  - listitem "Ridge" [ref=e1]')
  })

  it('puts untrusted page words on one line, without control or direction characters', () => {
    const { tree } = formatSnapshot([node('1', 'button', 'Pay\nnow‮!', { backendDOMNodeId: 1 })])
    expect(tree).toBe('- button "Pay now !" [ref=e1]')
  })

  it('stops at its line limit and says so', () => {
    const nodes: AXNode[] = [node('0', 'RootWebArea', '', { childIds: Array.from({ length: 10 }, (_, index) => String(index + 1)) }),
      ...Array.from({ length: 10 }, (_, index) => node(String(index + 1), 'link', `Link ${index}`, { parentId: '0', backendDOMNodeId: index }))]
    const { tree, refs, truncated } = formatSnapshot(nodes, 3)
    expect(tree.split('\n')).toHaveLength(3)
    expect(refs.size).toBe(3)
    expect(truncated).toBe(true)
  })

  it('hides only the text inside a field while its page holds a secret, and reads a control inside one as ever (the third review)', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', 'Sign in', { childIds: ['2', '6'] }),
      // A combobox whose inner editor holds what was typed, with a button to open it and a list of its options.
      node('2', 'combobox', 'Country', { parentId: '1', backendDOMNodeId: 20, value: { value: 'hunter2' }, childIds: ['3', '4', '5'] }),
      node('3', 'generic', '', { parentId: '2', childIds: ['3a'] }),
      node('3a', 'StaticText', 'hunter2', { parentId: '3', childIds: ['3b'] }),
      node('3b', 'InlineTextBox', 'hunter2', { parentId: '3a' }),
      node('4', 'button', 'Open the list', { parentId: '2', backendDOMNodeId: 21 }),
      node('5', 'listbox', 'Countries', { parentId: '2', backendDOMNodeId: 22, childIds: ['5a'] }),
      node('5a', 'option', 'Norway', { parentId: '5', backendDOMNodeId: 23, childIds: ['5b'] }),
      node('5b', 'StaticText', 'Norway', { parentId: '5a' }),
      // A rich editor's lines are its text too.
      node('6', 'textbox', 'Notes', { parentId: '1', backendDOMNodeId: 30, childIds: ['7'] }),
      node('7', 'paragraph', '', { parentId: '6', childIds: ['8', '9'] }),
      node('8', 'StaticText', 'hunter2 again', { parentId: '7' }),
      { nodeId: '9', parentId: '7' },
    ]
    const { tree } = formatSnapshot(nodes, undefined, true)
    expect(tree.split('\n')).toEqual([
      '- combobox "Country" [value hidden: this page holds a secret you saved] [ref=e1]',
      '  - button "Open the list" [ref=e2]',
      '  - listbox "Countries" [ref=e3]',
      '    - option "Norway" [ref=e4]',
      '- textbox "Notes" [ref=e5]',
      '  - paragraph',
    ])
    expect(tree).not.toContain('hunter2')
  })
})

describe('keys with modifiers (ADR-0220)', () => {
  it('types a character and names its code', () => {
    expect(keyEvents('a', [], 'win32')).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 },
    ])
  })

  it('holds a shortcut modifier without typing the character', () => {
    const [down] = keyEvents('a', ['Control'], 'win32')
    expect(down).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 })
    expect(down).not.toHaveProperty('text')
  })

  it('sends macOS editing commands with Command, and redo with Shift', () => {
    expect(keyEvents('a', ['Meta'], 'darwin')[0]).toMatchObject({ commands: ['selectAll'], modifiers: 4 })
    expect(keyEvents('z', ['Meta', 'Shift'], 'darwin')[0]).toMatchObject({ commands: ['redo'], modifiers: 12 })
    expect(keyEvents('a', ['Meta'], 'win32')[0]).not.toHaveProperty('commands')
  })

  it('knows named keys, shifted digits and punctuation', () => {
    expect(keyEvents('Enter')[0]).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    expect(keyEvents('Space')[0]).toMatchObject({ key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 })
    expect(keyEvents('Delete')[0]).toMatchObject({ type: 'rawKeyDown', key: 'Delete', windowsVirtualKeyCode: 46 })
    expect(keyEvents('!', ['Shift'])[0]).toMatchObject({ code: 'Digit1', windowsVirtualKeyCode: 49, text: '!', modifiers: 8 })
    expect(keyEvents('/')[0]).toMatchObject({ windowsVirtualKeyCode: 191, text: '/' })
  })

  it('adds modifier bits as CDP does', () => {
    expect(modifierMask(['Alt', 'Control', 'Meta', 'Shift'])).toBe(15)
    expect(modifierMask()).toBe(0)
  })
})
