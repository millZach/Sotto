import { z } from 'zod'

import { acceleratorKey, acceleratorModifier, formatAccelerator } from '../../shared/accelerator'
import { canonicalChord, chordTokens, type DictationShortcutSet, type ShortcutRole } from '../../shared/dictationShortcuts'
import { defaultHoldShortcuts, defaultHotkey } from '../../shared/platform'

/** What Sotto's keys bind when nobody has changed them: F9 held to talk, Super+Ctrl+X pressed to start and stop. */
export const DEFAULT_OMARCHY_SHORTCUTS: DictationShortcutSet = Object.freeze({
  press: Object.freeze([defaultHotkey('linux')]),
  hold: Object.freeze([...defaultHoldShortcuts('linux')]),
})

// Hyprland's modifier mask bits and names.
const MODIFIERS: Readonly<Record<string, { readonly name: string; readonly mask: number }>> = Object.freeze({
  Super: { name: 'SUPER', mask: 64 },
  CommandOrControl: { name: 'CTRL', mask: 4 },
  Alt: { name: 'ALT', mask: 8 },
  Shift: { name: 'SHIFT', mask: 1 },
})
// Sotto's key names as the xkb keysyms Hyprland binds, which it matches without case.
const KEYSYMS: Readonly<Record<string, string>> = Object.freeze({
  Space: 'SPACE', Enter: 'RETURN', Tab: 'TAB', Backspace: 'BACKSPACE', Delete: 'DELETE',
  Up: 'UP', Down: 'DOWN', Left: 'LEFT', Right: 'RIGHT', Home: 'HOME', End: 'END', PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN',
})
// Other spellings of the same keysym that a configuration may use.
const KEYSYM_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RETURN: ['RETURN', 'ENTER'], PAGE_UP: ['PAGE_UP', 'PRIOR'], PAGE_DOWN: ['PAGE_DOWN', 'NEXT'],
})

export interface HyprlandChord {
  /** As a binding names it: `SUPER + CTRL + X`. */
  readonly bind: string
  readonly key: string
  readonly modmask: number
}

/** A chord as Hyprland binds it, or null when it is not one Sotto can bind (no key, two keys, an unknown key). */
export function hyprlandChord(chord: string): HyprlandChord | null {
  const tokens = chordTokens(chord).map(token => acceleratorModifier(token, 'linux') ?? acceleratorKey(token))
  const canonical = canonicalChord(tokens, 'linux')
  if (canonical === null) return null
  const parts = chordTokens(canonical)
  const modifiers = parts.filter(part => MODIFIERS[part] !== undefined)
  const key = parts.find(part => MODIFIERS[part] === undefined)
  if (key === undefined || key === 'Escape') return null
  const keysym = KEYSYMS[key] ?? key.toUpperCase()
  return {
    bind: [...modifiers.map(modifier => MODIFIERS[modifier]!.name), keysym].join(' + '),
    key: keysym,
    modmask: modifiers.reduce((mask, modifier) => mask | MODIFIERS[modifier]!.mask, 0),
  }
}

/** The chord in Omarchy's own words: Super+Ctrl+X. */
export function linuxChordWords(chord: string): string {
  return formatAccelerator(chord, 'linux', 'editing')
}

/** "F9 and Super+Ctrl+X", in the order the snippet binds them. */
export function linuxKeyList(set: DictationShortcutSet): string {
  const words = [...new Set([...set.hold, ...set.press].map(linuxChordWords))]
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** One entry per chord, holds first, as the snippet binds them; unbindable or repeated chords are left out. */
export function boundChords(set: DictationShortcutSet): { readonly chord: string; readonly role: ShortcutRole; readonly hypr: HyprlandChord }[] {
  const seen = new Set<string>()
  return (['hold', 'press'] as const).flatMap(role => set[role].flatMap(chord => {
    const hypr = hyprlandChord(chord)
    if (hypr === null || seen.has(hypr.bind)) return []
    seen.add(hypr.bind)
    return [{ chord, role, hypr }]
  }))
}

const bindSchema = z.object({ key: z.string(), modmask: z.number() }).passthrough()

/** Whether a binding from `hyprctl binds -j` is on this chord. */
export function bindIsOn(bind: { key: string; modmask: number }, hypr: HyprlandChord): boolean {
  if (bind.modmask !== hypr.modmask) return false
  const key = bind.key.toUpperCase()
  return (KEYSYM_ALIASES[hypr.key] ?? [hypr.key]).includes(key)
}

/** The chord a binding sits on, among the given ones. */
export function chordOfBind(value: unknown, chords: ReturnType<typeof boundChords>): ReturnType<typeof boundChords>[number] | undefined {
  const bind = bindSchema.safeParse(value)
  return bind.success ? chords.find(entry => bindIsOn(bind.data, entry.hypr)) : undefined
}

export const SOTTO_BIND_LABELS = Object.freeze({
  start: 'Start Sotto dictation (push-to-talk)',
  stop: 'Stop Sotto dictation (push-to-talk)',
  toggle: 'Toggle Sotto dictation',
})

/**
 * Sotto's snippet for these shortcuts, from the bundled `apps/omarchy/bindings.lua`: its `hl.unbind` and `o.bind` lines
 * give way to one set for these chords, and every other line stays. It unbinds exactly the chords it binds, so a key
 * Sotto gives up runs what Omarchy gave it again. With the default shortcuts the bundled file comes back unchanged.
 * Null when the template has no binding lines to replace.
 */
export function renderSottoBindings(set: DictationShortcutSet, template: string): string | null {
  const chords = boundChords(set)
  const quote = (value: string): string => JSON.stringify(value)
  const unbinds = chords.map(({ hypr }) => `hl.unbind(${quote(hypr.bind)})`)
  const binds = chords.flatMap(({ role, hypr }) => role === 'hold'
    ? [`o.bind(${quote(hypr.bind)}, ${quote(SOTTO_BIND_LABELS.start)}, dictation("start"))`,
      `o.bind(${quote(hypr.bind)}, ${quote(SOTTO_BIND_LABELS.stop)}, dictation("stop"), { release = true })`]
    : [`o.bind(${quote(hypr.bind)}, ${quote(SOTTO_BIND_LABELS.toggle)}, dictation("toggle"))`])
  const lines = template.split('\n')
  const isUnbind = (line: string): boolean => /^\s*hl\.unbind\(/.test(line)
  const isBind = (line: string): boolean => /^\s*o\.bind\(/.test(line)
  if (!lines.some(isUnbind) || !lines.some(isBind)) return null
  const out: string[] = []
  let unbound = false, bound = false
  for (const line of lines) {
    if (isUnbind(line)) { if (!unbound) out.push(...unbinds); unbound = true }
    else if (isBind(line)) { if (!bound) out.push(...binds); bound = true }
    else out.push(line)
  }
  return out.join('\n')
}
