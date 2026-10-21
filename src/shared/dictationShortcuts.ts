import { acceleratorKey, acceleratorModifier, formatAccelerator } from './accelerator'
import type { SottoPlatform } from './platform'

export type ShortcutRole = 'hold' | 'press'

export interface DictationShortcutSet {
  readonly press: readonly string[]
  readonly hold: readonly string[]
}

export const MAX_SHORTCUTS_PER_ROLE = 4

export type ChordRefusal = 'escape' | 'plain-key' | 'needs-key' | 'lone-modifier' | 'reserved' | 'duplicate' | 'overlap' | 'too-many' | 'hold-modifier'

type ChordValidation = { ok: true } | { ok: false; code: ChordRefusal; message: string }

const darwinModifierOrder = ['Fn', 'Control', 'Alt', 'Shift', 'CommandOrControl'] as const
const win32ModifierOrder = ['CommandOrControl', 'Alt', 'Shift', 'Super'] as const
// Hyprland and Omarchy write Super first: Super+Ctrl+X.
const linuxModifierOrder = ['Super', 'CommandOrControl', 'Alt', 'Shift'] as const
const modifierTokens = new Set<string>([...darwinModifierOrder, ...win32ModifierOrder])

const keyTokens = new Set<string>([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape',
])

const codeKeys = new Map<string, string>([
  ['Space', 'Space'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['Delete', 'Delete'],
  ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
  ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'], ['Escape', 'Escape'],
  ['AltLeft', 'Alt'], ['AltRight', 'Alt'], ['ShiftLeft', 'Shift'], ['ShiftRight', 'Shift'],
])

const rowNames: Readonly<Record<ShortcutRole, string>> = Object.freeze({
  hold: 'Hold to dictate',
  press: 'Press to start and stop',
})

const reservedChords: Readonly<Record<SottoPlatform, readonly (readonly [string, string])[]>> = Object.freeze({
  darwin: [
    ['CommandOrControl+Space', 'Spotlight'],
    ['CommandOrControl+Tab', 'switching apps'],
    ['CommandOrControl+Q', 'quitting apps'],
    ['CommandOrControl+Shift+3', 'taking screenshots'],
    ['CommandOrControl+Shift+4', 'taking screenshots'],
    ['CommandOrControl+Shift+5', 'taking screenshots'],
  ],
  win32: [
    ['Super+L', 'locking Windows'],
    ['Alt+Tab', 'switching windows'],
    ['Alt+F4', 'closing windows'],
    ['Super', 'opening Start'],
    ['CommandOrControl+Alt+Delete', 'the security screen'],
  ],
  linux: [],
})

export function chordTokens(chord: string): string[] {
  return chord.split('+').map((token) => token.trim()).filter(Boolean)
}

// Platform-free on purpose: any modifier spelling on either platform counts, so legacy strings classify too.
function isModifierWord(token: string): boolean {
  return acceleratorModifier(token, 'darwin') !== undefined || acceleratorModifier(token, 'win32') !== undefined
}

export function chordHasKey(chord: string): boolean {
  return chordTokens(chord).some((token) => !isModifierWord(token))
}

export function chordNeedsListener(chord: string, role: ShortcutRole): boolean {
  return role === 'hold' || chordTokens(chord).some((token) => token.toLowerCase() === 'fn') || !chordHasKey(chord)
}

function modifierOrder(platform: SottoPlatform): readonly string[] {
  return platform === 'darwin' ? darwinModifierOrder : platform === 'linux' ? linuxModifierOrder : win32ModifierOrder
}

/** Who already uses a chord, in each platform's own words. */
const systemName: Readonly<Record<SottoPlatform, string>> = Object.freeze({ darwin: 'macOS', win32: 'Windows', linux: 'Hyprland' })

export function canonicalChord(tokens: readonly string[], platform: SottoPlatform): string | null {
  const unique = [...new Set(tokens)]
  const order = modifierOrder(platform)
  const keys = unique.filter((token) => !modifierTokens.has(token))
  if (unique.length === 0 || keys.length > 1 || keys.some((key) => !keyTokens.has(key))) return null
  if (unique.some((token) => modifierTokens.has(token) && !order.includes(token))) return null
  return [...order.filter((modifier) => unique.includes(modifier)), ...keys].join('+')
}

export function keyTokenFromCode(code: string, key: string, platform: SottoPlatform): string | null {
  const darwin = platform === 'darwin'
  if (code === 'ControlLeft' || code === 'ControlRight') return darwin ? 'Control' : 'CommandOrControl'
  if (/^(?:Meta|OS)(?:Left|Right)$/u.test(code)) return darwin ? 'CommandOrControl' : 'Super'
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9]))$/u.exec(code)
  // Hyprland binds the symbol a key types in the first layout, not its place on a US keyboard, so on Linux a
  // letter or digit is the one the key types (A on the AZERTY key a US keyboard calls Q), or its place when it types neither.
  if (letterOrDigit && platform === 'linux' && /^[a-z0-9]$/iu.test(key)) return key.toUpperCase()
  if (letterOrDigit) return letterOrDigit[1] ?? letterOrDigit[2]!
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(code)) return code
  return codeKeys.get(code) ?? null
}

export function chordFromKeyboardEvent(
  event: { code: string; key: string },
  held: readonly string[],
  platform: SottoPlatform,
): string[] {
  const token = keyTokenFromCode(event.code, event.key, platform)
  if (token === null || held.includes(token)) return [...held]
  const kept = modifierTokens.has(token) ? held : held.filter((existing) => modifierTokens.has(existing))
  return [...kept, token]
}

export function chordWords(chord: string, platform: SottoPlatform): string {
  return chordTokens(chord).map((token) => formatAccelerator(token, platform, 'editing')).join(' ')
}

export function chordInline(chord: string, platform: SottoPlatform): string {
  return chordTokens(chord)
    .map((token) => {
      const word = formatAccelerator(token, platform, 'editing')
      const glyph = formatAccelerator(token, platform, 'display')
      return glyph === word ? word : `${glyph} ${word}`
    })
    .join(' + ')
}

function normalTokens(chord: string, platform: SottoPlatform): Set<string> {
  return new Set(chordTokens(chord).map((token) => (acceleratorModifier(token, platform) ?? acceleratorKey(token)).toLowerCase()))
}

function sameTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((token) => right.has(token))
}

/** Same keys, whatever the spelling or order (legacy `hotkey` strings included). */
export function sameChord(left: string, right: string, platform: SottoPlatform): boolean {
  return sameTokens(normalTokens(left, platform), normalTokens(right, platform))
}

function properSubset(inner: ReadonlySet<string>, outer: ReadonlySet<string>): boolean {
  return inner.size < outer.size && [...inner].every((token) => outer.has(token))
}

function modifierOnly(tokens: ReadonlySet<string>): boolean {
  return tokens.size > 0 && [...tokens].every((token) => isModifierWord(token))
}

function refuse(code: ChordRefusal, message: string): ChordValidation {
  return { ok: false, code, message }
}

export function validateChord(
  chord: string,
  target: { role: ShortcutRole; index: number | null },
  set: DictationShortcutSet,
  platform: SottoPlatform,
  options: { listener: boolean },
): ChordValidation {
  const darwin = platform === 'darwin'
  const linux = platform === 'linux'
  const tokens = normalTokens(chord, platform)
  const keys = chordInline(chord, platform)
  const row = set[target.role]
  const needsKey = 'Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere.'
  // Hyprland binds every Linux shortcut, held or pressed, and each needs a key. A key Hyprland already binds never
  // reaches Sotto's window, so a recording of it ends with only the modifiers.
  const linuxNeedsKey = 'A shortcut needs a key besides Super, Ctrl, Alt and Shift. If you pressed one, Hyprland already uses it for one of its own shortcuts. Pick another key.'
  if (tokens.size === 0) return refuse('needs-key', linux ? linuxNeedsKey : needsKey)
  if (tokens.has('escape')) return refuse('escape', 'Esc cancels a recording, so it can’t start one. Pick other keys.')
  if (target.index === null && row.length >= MAX_SHORTCUTS_PER_ROLE) {
    return refuse('too-many', `Each row holds up to ${MAX_SHORTCUTS_PER_ROLE} shortcuts.`)
  }
  if (linux && !chordHasKey(chord)) return refuse('needs-key', linuxNeedsKey)
  // Hyprland matches a release against the modifiers still down, so letting go of one first would never stop the hold.
  if (linux && target.role === 'hold' && chordTokens(chord).some(isModifierWord)) {
    return refuse('hold-modifier', 'On Linux a hold shortcut is one F key on its own, such as F9. With a modifier, Hyprland can miss the release and keep listening.')
  }
  const mainSlot = target.role === 'press' && (target.index ?? row.length) === 0
  if (!linux && chordNeedsListener(chord, target.role) && (mainSlot || !options.listener)) {
    const owl = options.listener ? ' Add this one with + Add instead.' : ''
    return refuse('needs-key', `${needsKey}${owl}`)
  }
  // Shift alone still types (capitals), so only F keys may go without another modifier.
  const plainKeys = [...tokens].filter((token) => !isModifierWord(token))
  const plain = plainKeys.length > 0
    && plainKeys.every((token) => !/^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(token))
    && [...tokens].every((token) => !isModifierWord(token) || token === 'shift')
  if (plain) {
    return refuse('plain-key', `${keys} on its own would start dictation while you type. Add a modifier such as ${darwin ? '⌃ Control' : linux ? 'Super' : 'Ctrl'}.`)
  }
  const reserved = reservedChords[platform].find(([reservedChord]) => sameTokens(tokens, normalTokens(reservedChord, platform)))
  if (reserved) return refuse('reserved', `${systemName[platform]} uses ${keys} for ${reserved[1]}. Pick other keys.`)
  // After reserved, so Win alone keeps its more useful "opening Start" answer.
  // The normalised set, so Shift+Shift or Control+Ctrl is still one modifier.
  const only = [...tokens]
  if (only.length === 1 && isModifierWord(only[0]!) && only[0] !== 'fn') {
    return refuse('lone-modifier', `${keys} on its own is part of too many shortcuts. Use ${darwin ? 'Fn, or ' : ''}two modifiers together.`)
  }
  const others = (['press', 'hold'] as const).flatMap((role) =>
    set[role]
      .map((other, index) => ({ role, other, index }))
      .filter((entry) => !(entry.role === target.role && entry.index === target.index)),
  )
  const duplicate = others.find(({ other }) => sameTokens(tokens, normalTokens(other, platform)))
  if (duplicate) return refuse('duplicate', `${rowNames[duplicate.role]} already uses ${keys}.`)
  for (const { other } of others) {
    const otherTokens = normalTokens(other, platform)
    const [held, pressed] = modifierOnly(tokens) && properSubset(tokens, otherTokens)
      ? [chord, other]
      : modifierOnly(otherTokens) && properSubset(otherTokens, tokens) ? [other, chord] : []
    if (held !== undefined && pressed !== undefined) {
      return refuse('overlap', `Holding ${chordInline(held, platform)} would start dictation every time you press ${chordInline(pressed, platform)}. Pick keys that don’t overlap.`)
    }
  }
  return { ok: true }
}
