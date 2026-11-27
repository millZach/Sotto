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
