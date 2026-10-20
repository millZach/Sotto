import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'

import type {
  DictationShortcutsChange,
  DictationShortcutsResult,
  HotkeyChangeResult,
  KeyListenerPermission,
} from '../../../../shared/contracts'
import {
  chordInline,
  chordNeedsListener,
  chordTokens,
  chordWords,
  MAX_SHORTCUTS_PER_ROLE,
  sameChord,
  validateChord,
  type DictationShortcutSet,
  type ShortcutRole,
} from '../../../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ShortcutKey } from '../../components/ShortcutKey'
import { useOwlFeature } from '../../state/owlFeature'
import { useChordRecorder } from './useChordRecorder'
import './dictationShortcuts.css'

export interface DictationShortcutsProps {
  readonly settings: Pick<AppSettings, 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>
  readonly platform: SottoPlatform
  readonly onReplaceHotkey: (accelerator: string) => Promise<HotkeyChangeResult>
  readonly onReplaceDictationShortcuts?: ((change: DictationShortcutsChange) => Promise<DictationShortcutsResult>) | undefined
  /** Linux: why Sotto's Hyprland keys can't change right now, and what to do about it. The rows only show their keys meanwhile. */
  readonly locked?: { readonly message: string; readonly action?: ReactNode } | null | undefined
}

interface Slot { readonly role: ShortcutRole; readonly index: number | null }
interface RowMessage { readonly role: ShortcutRole; readonly text: string; readonly alert: boolean }

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const
const UNSUPPORTED_KEY = 'That key can’t be part of a shortcut. Try a letter, a number, an F key, Space or an arrow key.'
// Linux: Hyprland ran one of Sotto's own bindings, so the recording never saw the keys.
const TAKEN = {
  'taken-press': 'Sotto’s start-and-stop shortcut already uses those keys. Pick other keys.',
  'taken-hold': 'Sotto’s hold-to-talk shortcut already uses those keys. Pick other keys.',
} as const

const rowCopy: Readonly<Record<ShortcutRole, { label: string; one: (keys: string) => string; several: string; none: string }>> = {
  hold: {
    label: 'Hold to dictate',
    one: (keys) => `Hold ${keys}, speak, then let go.`,
    several: 'Hold any of these, speak, then let go.',
    none: 'Add a shortcut to talk only while you hold it.',
  },
  press: {
    label: 'Press to start and stop',
    one: (keys) => `Press ${keys} to start, and again to finish.`,
    several: 'Press any of these to start, and again to finish.',
    none: 'Add a shortcut to start and stop without holding keys.',
  },
}

export function DictationShortcuts({ settings, platform, onReplaceHotkey, onReplaceDictationShortcuts, locked }: DictationShortcutsProps): ReactNode {
  const owl = useOwlFeature('dictation-hold-shortcuts')
  const darwin = platform === 'darwin'
  const linux = platform === 'linux'
  // Stable shows only the main shortcut and leaves the saved extras and holds alone. Linux's first hold shortcut stays bound
  // in Hyprland, F9 by default, so the press shortcut is checked against it though its row is not shown.
  const set: DictationShortcutSet = owl
    ? { press: [settings.hotkey, ...settings.pressShortcuts], hold: settings.holdShortcuts }
    : { press: [settings.hotkey], hold: linux ? settings.holdShortcuts.slice(0, 1) : [] }
  // Linux has no key listener: Wayland gives keys only to the focused window, so the page records.
  const recorder = useChordRecorder(platform, owl && !linux)
  const [target, setTarget] = useState<Slot | null>(null)
  const [message, setMessage] = useState<RowMessage | null>(null)
  const [menuRole, setMenuRole] = useState<ShortcutRole | null>(null)
  const [permission, setPermission] = useState<KeyListenerPermission | null>(null)
  const [focusKeys, setFocusKeys] = useState<readonly string[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)
  const saveRef = useRef(0)
  const id = useId()
  const inline = (chord: string): string => chordInline(chord, platform)
  const all = [...set.press, ...set.hold]

  const listenerInUse = owl && darwin && (['press', 'hold'] as const).some((role) => set[role].some((chord) => chordNeedsListener(chord, role)))
  // Main answers `unsupported` when no key listener can run here, so only Electron-registerable chords fit.
  const listener = owl && permission !== 'unsupported'
  useEffect(() => {
    if (!owl) return
    let live = true
    void window.sotto?.getKeyListenerPermission?.().then((value) => { if (live) setPermission(value) }).catch(() => undefined)
    const unsubscribe = window.sotto?.onKeyListenerPermission?.(setPermission)
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [owl])
  const denied = listenerInUse && permission === 'denied'

  // Focus returns to the shortcut once its row has re-rendered without the recording box.
  useEffect(() => {
    if (focusKeys === null) return
    const root = rootRef.current
    const found = focusKeys.map((key) => root?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)).find(Boolean)
    found?.focus()
    setFocusKeys(null)
  })

  const show = (role: ShortcutRole, text: string, alert: boolean): void => setMessage({ role, text, alert })

  const save = async (next: DictationShortcutSet, role: ShortcutRole, chord: string, previous: string): Promise<boolean> => {
    const mine = ++saveRef.current
    const result: HotkeyChangeResult | DictationShortcutsResult = await Promise.resolve(owl
      ? onReplaceDictationShortcuts?.({ press: next.press, hold: next.hold }) ?? UNAVAILABLE
      : onReplaceHotkey(next.press[0] ?? settings.hotkey)
    ).catch(() => UNAVAILABLE)
    // A newer save answers for the row; this slower, older answer must not overwrite it.
    if (mine !== saveRef.current) return result.ok
    if (result.ok) show(role, 'Shortcut saved.', false)
    else if (result.message !== undefined) {
      // Linux says why in Hyprland's terms; a refused chord leaves the previous one bound.
      show(role, result.reason === 'unavailable' ? result.message : `${result.message} ${inline(previous)} still works.`, true)
    } else if (result.reason === 'conflict') {
      const refused = 'chord' in result && result.chord !== undefined ? result.chord : chord
      show(role, `Another app already uses ${inline(refused)}. ${inline(previous)} still works. Pick other keys, or free that shortcut in the other app.`, true)
    } else show(role, `The shortcut could not be changed. ${inline(previous)} still works.`, true)
    return result.ok
  }

  const commit = async (slot: Slot, chord: string): Promise<boolean> => {
    const row = set[slot.role]
    const current = slot.index === null ? undefined : row[slot.index]
    if (current !== undefined && sameChord(current, chord, platform)) {
      show(slot.role, 'Shortcut saved.', false)
      return true
    }
    const check = validateChord(chord, slot, set, platform, { listener })
    if (!check.ok) {
      show(slot.role, check.message, true)
      return false
    }
    const nextRow = [...row]
    if (slot.index === null) nextRow.push(chord)
    else nextRow[slot.index] = chord
    const previous = slot.index === null ? set.press[0] ?? settings.hotkey : row[slot.index] ?? chord
    return save({ ...set, [slot.role]: nextRow }, slot.role, chord, previous)
  }

  const record = async (slot: Slot): Promise<void> => {
    setMenuRole(null)
    setMessage(null)
    setTarget(slot)
    // A newer recording (a click with no pointerdown, as screen readers send) outlives this one's cancel.
    const generation = ++generationRef.current
    const chord = await recorder.record()
    if (generation !== generationRef.current) return
    setTarget(null)
    if (chord === 'unsupported-key') show(slot.role, UNSUPPORTED_KEY, true)
    else if (chord === 'taken-press' || chord === 'taken-hold') show(slot.role, TAKEN[chord], true)
    const saved = chord !== null && chord !== 'unsupported-key' && chord !== 'taken-press' && chord !== 'taken-hold' && await commit(slot, chord)
    const self = `${slot.role}-${slot.index ?? 'add'}`
    setFocusKeys(slot.index === null && saved ? [`${slot.role}-${set[slot.role].length}`, self, `${slot.role}-0`] : [self, `${slot.role}-0`])
  }

  const addFn = async (role: ShortcutRole): Promise<void> => {
    setMenuRole(null)
    setMessage(null)
    await commit({ role, index: null }, 'Fn')
    setFocusKeys([`${role}-add`, `${role}-0`])
  }

  const promotable = (index: number): boolean => index > 0 && !chordNeedsListener(set.press[index] ?? '', 'press')
  const removable = (role: ShortcutRole, index: number): boolean =>
    owl && !locked && all.length > 1 && (role === 'hold' || index > 0 || set.press.some((_, other) => promotable(other)))

  const remove = async (role: ShortcutRole, index: number): Promise<void> => {
    const chord = set[role][index] ?? ''
    let press = [...set.press]
    const hold = [...set.hold]
    if (role === 'hold') hold.splice(index, 1)
    else if (index === 0) {
      // The main shortcut must stay one Electron can register, so the first such extra takes its place.
      const promoted = press.findIndex((_, other) => promotable(other))
      press = [press[promoted] ?? '', ...press.filter((_, other) => other !== 0 && other !== promoted)]
    } else press.splice(index, 1)
    setMessage(null)
    await save({ press, hold }, role, chord, chord)
    setFocusKeys([`${role}-${Math.max(0, index - 1)}`, `${role}-add`, `${role}-0`])
  }

  const fnInUse = all.some((chord) => sameChord(chord, 'Fn', platform))

  const menuKeys = (event: KeyboardEvent<HTMLDivElement>, role: ShortcutRole): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMenuRole(null)
      setFocusKeys([`${role}-add`])
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  const recordingBox = (role: ShortcutRole): ReactNode => (
    <span className="dictation-shortcuts__recording">
      {recorder.held.length === 0
        ? <span className="dictation-shortcuts__prompt">Press the new keys…</span>
        : <ShortcutKey accelerator={recorder.held.join('+')} platform={platform} />}
      <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label="Cancel recording" data-recording-cancel autoFocus onClick={recorder.cancel} data-focus-key={`${role}-cancel`}>
        <X size={13} aria-hidden="true" />
      </button>
    </span>
  )

  const addLabel = (role: ShortcutRole): string => role === 'hold' ? 'Add a hold shortcut' : 'Add a start-and-stop shortcut'
  const addControl = (role: ShortcutRole): ReactNode => {
    if (!owl || locked || set[role].length >= MAX_SHORTCUTS_PER_ROLE) return null
    if (target?.role === role && target.index === null) return recordingBox(role)
    if (!darwin) {
      return <button type="button" className="dictation-shortcuts__add tt-focusable" aria-label={addLabel(role)} data-focus-key={`${role}-add`} onClick={() => void record({ role, index: null })}>+ Add</button>
    }
    const open = menuRole === role
    return (
      <span
        className="dictation-shortcuts__menu-anchor"
        onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuRole(null) }}
      >
        <button
          type="button"
          className="dictation-shortcuts__add tt-focusable"
          aria-label={addLabel(role)}
          data-focus-key={`${role}-add`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? `${id}-${role}-menu` : undefined}
          onClick={() => setMenuRole(open ? null : role)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              setMenuRole(null)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (open) document.getElementById(`${id}-${role}-menu`)?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
              else setMenuRole(role)
            }
          }}
        >+ Add</button>
        {open ? (
          <div className="dictation-shortcuts__menu" role="menu" id={`${id}-${role}-menu`} aria-label="Add a shortcut" onKeyDown={(event) => menuKeys(event, role)}>
            <button type="button" role="menuitem" className="tt-focusable" autoFocus onClick={() => void record({ role, index: null })}>Record keys…</button>
            <button type="button" role="menuitem" className="tt-focusable" disabled={fnInUse} onClick={() => void addFn(role)}>
              {fnInUse ? 'Fn is already in use' : 'Fn on its own'}
            </button>
          </div>
        ) : null}
      </span>
    )
  }

  const row = (role: ShortcutRole): ReactNode => {
    const chords = set[role]
    const copy = rowCopy[role]
    const description = chords.length === 0 ? copy.none : chords.length === 1 ? copy.one(inline(chords[0] ?? '')) : copy.several
    const recordingHere = target?.role === role
    const line = recordingHere
      ? { text: recorder.held.length === 0 ? 'Hold the keys you want, then let go. Esc cancels.' : 'Let go to save. Esc cancels.', alert: false }
      : message?.role === role ? message : null
    return (
      <div className="dictation-shortcuts__row" role="group" aria-labelledby={`${id}-${role}-label`} aria-describedby={`${id}-${role}-description`}>
        <div className="dictation-shortcuts__text">
          <span className="tt-field__label" id={`${id}-${role}-label`}>{copy.label}</span>
          <p className="tt-field__description" id={`${id}-${role}-description`}>{description}</p>
        </div>
        <div className="dictation-shortcuts__controls">
          {chords.map((chord, index) => {
            if (target?.role === role && target.index === index) return <React.Fragment key={`${chord}-${index}`}>{recordingBox(role)}</React.Fragment>
            const words = chordWords(chord, platform)
            const dimmed = denied && chordNeedsListener(chord, role)
            return (
              <span key={`${chord}-${index}`} className={`dictation-shortcuts__chord${dimmed ? ' is-dimmed' : ''}`}>
                <button
                  type="button"
                  className="dictation-shortcuts__chip tt-focusable"
                  aria-label={`Change shortcut, ${words}`}
                  data-focus-key={`${role}-${index}`}
                  disabled={!!locked}
                  onClick={() => void record({ role, index })}
                >
                  <ShortcutKey accelerator={chord} platform={platform} />
                </button>
                {removable(role, index)
                  ? <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={`Remove shortcut, ${words}`} onClick={() => void remove(role, index)}><X size={13} aria-hidden="true" /></button>
                  : null}
              </span>
            )
          })}
          {addControl(role)}
        </div>
        {line === null ? null : (
          <p className={`dictation-shortcuts__message${line.alert ? ' is-error' : ''}`} role={line.alert ? 'alert' : 'status'}>{line.text}</p>
        )}
      </div>
    )
  }

  return (
    <div className="dictation-shortcuts" ref={rootRef}>
      {owl ? row('hold') : null}
      {row('press')}
      <div className="dictation-shortcuts__notes">
        {denied ? (
          <div className="dictation-shortcuts__permission">
            <p>Holding a shortcut, and Fn, need Input Monitoring. Sotto watches only modifier keys and your shortcuts’ keys, and keeps nothing it sees.</p>
            <p>After an update, macOS may need you to turn Sotto off and on again in that list.</p>
            <Button variant="secondary" onClick={() => void window.sotto?.requestKeyListenerPermission?.().then(setPermission).catch(() => undefined)}>Open System Settings</Button>
          </div>
        ) : null}
        {darwin && all.some((chord) => chordTokens(chord).includes('Fn'))
          ? <p>If Fn opens emoji or Apple’s dictation, set System Settings › Keyboard › “Press 🌐 key to” to Do Nothing.</p>
          : null}
        {locked ? (
          <div className="dictation-shortcuts__permission" role="status">
            <p>{locked.message}</p>
            {locked.action}
          </div>
        ) : null}
        {linux
          ? <p>These shortcuts are Hyprland bindings, so keys Hyprland already uses can’t be one of them. Press Cancel on the widget to stop without transcribing.</p>
          : <p>Press Esc in any app to cancel a recording. Nothing is transcribed.</p>}
      </div>
    </div>
  )
}
