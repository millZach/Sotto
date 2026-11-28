import { BROWSER_NAMED_KEYS, type BROWSER_MODIFIERS } from '../../shared/browser'
import { maskSecrets, tidyWords, type Tidy } from './secretMask'

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

/** Untrusted page words, quoted on one line: no control or direction-changing character, and each run of spaces one. */
const oneLine = (value: unknown, max: number): string => tidyWords(String(value ?? ''), 'line').slice(0, max)

/** Roles whose value is text the user or an agent typed. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
/** What a field's value reads as while its page holds a typed secret. */
export const FIELD_VALUE_HIDDEN = '[value hidden: this page holds a secret you saved]'
/** Roles that carry a field's text beneath it, as Chromium lists an input's inner editor and a rich editor's lines. */
const FIELD_TEXT_ROLES = new Set([...PASS_THROUGH, 'paragraph'])
/**
 * The nodes inside a field that carry the text it holds, which Chromium lists under it. While a page holds a typed
 * secret they are not read out: a site's "show password" button and an edit to the field would let its value out a
 * piece at a time, past a mask that matches only the whole of it. A control inside a field, such as a combobox's
 * button or its options, is not its text, so it and what is under it are read as ever.
 */
export function fieldContents(nodes: readonly AXNode[]): Set<string> {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const inside = new Set<string>()
  const add = (node: AXNode): void => {
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId), role = child ? oneLine(child.role?.value, 60) : ''
      // One whose role is not known is taken for text.
      if (inside.has(childId) || (role !== '' && !FIELD_TEXT_ROLES.has(role))) continue
      inside.add(childId)
      if (child) add(child)
    }
  }
  for (const node of nodes) if (FIELD_ROLES.has(oneLine(node.role?.value, 60))) add(node)
  return inside
}

/**
 * The page's accessibility tree as an agent reads it (ADR-0220): one indented line per element that means something,
 * its role, its name in quotes, its value and states, and a ref to act on it by. Refs count from 1 in each snapshot and
 * stand for the DOM node, so an action by ref reaches exactly the element the snapshot named. `hideFields` leaves out
 * what each field holds, for a page that holds a typed secret. `told` says each name and value on one line and at most
 * its length, as a page's words are told (`maskSecrets`): given them whole, it tidies them, then masks them, then cuts
 * them, so neither the cut nor the spaces the tidy closes up can leave part of a secret out of a mask.
 */
export function formatSnapshot(nodes: readonly AXNode[], maxLines = SNAPSHOT_LINES, hideFields = false, told: (words: string, max: number, tidy: Tidy) => string = (words, max, tidy) => maskSecrets(words, [], '', max, tidy)): { tree: string; refs: Map<string, number>; truncated: boolean } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const root = nodes.find(node => !node.parentId) ?? nodes[0]
  const refs = new Map<string, number>()
  const lines: string[] = []
  const hidden = hideFields ? fieldContents(nodes) : new Set<string>()
  let truncated = false
  const visit = (node: AXNode, depth: number): void => {
    if (lines.length >= maxLines) { truncated = true; return }
    const role = oneLine(node.role?.value, 60)
    const name = hidden.has(node.nodeId) ? '' : told(String(node.name?.value ?? ''), 200, 'line')
    const listed = !node.ignored && role !== '' && role !== 'RootWebArea' && !(PASS_THROUGH.has(role) && !(role !== 'StaticText' && name))
    let childDepth = depth
    if (listed) {
      const words = [`- ${role}`]
      if (name) words.push(JSON.stringify(name))
      const value = hidden.has(node.nodeId) ? '' : told(String(node.value?.value ?? ''), 200, 'line')
      if (value && hideFields && FIELD_ROLES.has(role)) words.push(FIELD_VALUE_HIDDEN)
      else if (value && value !== name) words.push(`value=${JSON.stringify(value)}`)
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
