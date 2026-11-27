import { BROWSER_NAMED_KEYS, type BROWSER_MODIFIERS } from '../../shared/browser'

/** An accessibility node as `Accessibility.getFullAXTree` returns it. */
export interface AXNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: { readonly value?: unknown }
  readonly name?: { readonly value?: unknown }
  readonly value?: { readonly value?: unknown }
  readonly properties?: readonly { readonly name: string; readonly value?: { readonly value?: unknown } }[]
  readonly childIds?: readonly string[]
  readonly parentId?: string
  readonly backendDOMNodeId?: number
}

/** Roles that only group or carry text, listed through their children rather than as a line of their own. */
const PASS_THROUGH = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'StaticText', 'ignored', 'Section', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])
/** States worth a word on a node's line. */
const STATES = ['focused', 'disabled', 'checked', 'pressed', 'selected', 'expanded', 'required', 'invalid', 'readonly', 'multiselectable'] as const
/** How many lines a snapshot's tree holds at most. */
export const SNAPSHOT_LINES = 1200
/** How much of the page's visible text a snapshot carries. */
export const SNAPSHOT_TEXT = 20_000

// eslint-disable-next-line no-control-regex -- Untrusted page words, quoted on one line.
const oneLine = (value: unknown, max: number): string => String(value ?? '').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)

/**
 * The page's accessibility tree as an agent reads it (ADR-0220): one indented line per element that means something,
 * its role, its name in quotes, its value and states, and a ref to act on it by. Refs count from 1 in each snapshot and
 * stand for the DOM node, so an action by ref reaches exactly the element the snapshot named.
 */
export function formatSnapshot(nodes: readonly AXNode[], maxLines = SNAPSHOT_LINES): { tree: string; refs: Map<string, number>; truncated: boolean } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const root = nodes.find(node => !node.parentId) ?? nodes[0]
  const refs = new Map<string, number>()
  const lines: string[] = []
  let truncated = false
  const visit = (node: AXNode, depth: number): void => {
    if (lines.length >= maxLines) { truncated = true; return }
    const role = oneLine(node.role?.value, 60)
    const name = oneLine(node.name?.value, 200)
    const listed = !node.ignored && role !== '' && role !== 'RootWebArea' && !(PASS_THROUGH.has(role) && !(role !== 'StaticText' && name))
    let childDepth = depth
    if (listed) {
      const words = [`- ${role}`]
      if (name) words.push(JSON.stringify(name))
      const value = oneLine(node.value?.value, 200)
      if (value && value !== name) words.push(`value=${JSON.stringify(value)}`)
      for (const state of STATES) {
        const property = node.properties?.find(entry => entry.name === state)?.value?.value
        if (property === true || property === 'true' || property === 'mixed') words.push(`[${state}${property === 'mixed' ? '=mixed' : ''}]`)
      }
      const level = node.properties?.find(entry => entry.name === 'level')?.value?.value
      if (typeof level === 'number') words.push(`[level=${level}]`)
      if (node.backendDOMNodeId !== undefined) {
        const ref = `e${refs.size + 1}`
        refs.set(ref, node.backendDOMNodeId)
        words.push(`[ref=${ref}]`)
      }
      lines.push(`${'  '.repeat(depth)}${words.join(' ')}`)
      childDepth = depth + 1
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) visit(child, childDepth)
    }
  }
  if (root) visit(root, 0)
  return { tree: lines.join('\n'), refs, truncated }
}

type Modifier = typeof BROWSER_MODIFIERS[number]
const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
/** macOS edits with Command through commands rather than key events; Chromium needs them named. */
const MAC_COMMANDS: Readonly<Record<string, string>> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }
/** Windows virtual key codes for punctuation on a US keyboard, which Chromium reads for key events. */
const PUNCTUATION: Readonly<Record<string, number>> = { ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, '\'': 222, '"': 222 }
const SHIFTED_DIGITS = ')!@#$%^&*('

/** The key-down and key-up events one `key` action sends, with its modifiers held. */
export function keyEvents(key: string, modifiers: readonly Modifier[] = [], platform: NodeJS.Platform = process.platform): Record<string, unknown>[] {
  const mask = modifiers.reduce((total, modifier) => total | MODIFIER_BITS[modifier], 0)
  const named = Object.hasOwn(BROWSER_NAMED_KEYS, key)
  const keyName = named ? (key === 'Space' ? ' ' : key) : key
  let code: string, keyCode: number
  if (named) { code = key === 'Space' ? 'Space' : key; keyCode = BROWSER_NAMED_KEYS[key]! }
  else if (/^[a-z]$/iu.test(key)) { code = `Key${key.toUpperCase()}`; keyCode = key.toUpperCase().charCodeAt(0) }
  else if (/^[0-9]$/u.test(key)) { code = `Digit${key}`; keyCode = key.charCodeAt(0) }
  else if (SHIFTED_DIGITS.includes(key)) { code = `Digit${SHIFTED_DIGITS.indexOf(key)}`; keyCode = 48 + SHIFTED_DIGITS.indexOf(key) }
  else { code = ''; keyCode = PUNCTUATION[key] ?? 0 }
  // A character types itself unless a shortcut modifier is held; Enter and Space type theirs.
  const shortcut = modifiers.some(modifier => modifier === 'Control' || modifier === 'Meta' || modifier === 'Alt')
  const text = shortcut ? undefined : key === 'Enter' ? '\r' : key === 'Space' ? ' ' : named ? undefined : key
  const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mask }
  const commands = platform === 'darwin' && modifiers.includes('Meta') && MAC_COMMANDS[key.toLowerCase()]
    ? [modifiers.includes('Shift') && key.toLowerCase() === 'z' ? 'redo' : MAC_COMMANDS[key.toLowerCase()]!] : undefined
  return [
    { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) },
    { type: 'keyUp', ...base },
  ]
}
/** The bit mask CDP's input events take for held modifiers. */
export function modifierMask(modifiers: readonly Modifier[] = []): number {
  return modifiers.reduce((total, modifier) => total | MODIFIER_BITS[modifier], 0)
}
