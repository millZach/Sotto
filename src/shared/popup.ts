import { z } from 'zod'

import { sameChord, chordHasKey, chordTokens } from './dictationShortcuts'
import type { AgentCommand, AgentCommandReceipt, AgentState, AgentThread, AgentThreadDetail, AgentThreadDetailUpdate } from './agents'
import type { InterfaceLanguageBridge } from './interfaceLanguageBridge'
import type { SottoPlatform } from './platform'
import type { AppSettings } from './settings'
import type { WatcherRoomResult } from './watcherRoom'

/**
 * The popup (ADR-0181, Owl `popup`): a floating card a shortcut shows over any app, which prompts a thread or Watcher.
 * Its window speaks to main through these channels and, for threads and Watcher, the ones the main window uses.
 */
/** The popup hides itself: Escape with nothing to stop. */
export const POPUP_HIDE = 'sotto:popup:hide'
/** The card's height changed; main keeps the window's bottom edge where it is and grows or shrinks it upward. */
export const POPUP_FIT = 'sotto:popup:fit'
/** `/open` or Command/Ctrl+O: main shows the thread, or Watcher's room, in the main window. */
export const POPUP_OPEN = 'sotto:popup:open'
/** Pushed to the popup each time it is shown, so it reads its target again and takes the focus to its prompt. */
export const POPUP_SHOWN = 'sotto:popup:shown'
/** Pushed to the popup: the record of a thread it observes, each time the record changes. */
export const POPUP_THREAD = 'sotto:popup:thread'
/** Pushed to the main window: what `/open` asks it to show, after main selected the thread. */
export const POPUP_OPENED = 'sotto:popup:opened'
/** The main window's Settings row reads, and hears, whether the shortcut works. */
export const POPUP_SHORTCUT_STATE_GET = 'sotto:popup:shortcut-state'
export const POPUP_SHORTCUT_STATE_CHANGED = 'sotto:popup:shortcut-state-changed'
/** Settings records a new shortcut, clears it (null) or restores the default: main registers it before it is saved. */
export const POPUP_SHORTCUT_REPLACE = 'sotto:popup:shortcut-replace'
/** Passed to the main window's preload only while the popup is on, so Settings offers its row. */
export const POPUP_RENDERER_ARGUMENT = '--sotto-popup-enabled'

/** The popup's card is at least this tall (its prompt row alone) and no taller than this share of the work area. */
export const POPUP_WIDTH = 560
export const POPUP_MIN_HEIGHT = 64
export const POPUP_MAX_SHARE = 0.6

/** The commands the popup's window may send: reading, starting and prompting a thread, stopping it and answering it. */
export const POPUP_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'observe-threads', 'create-thread', 'manual-send', 'queue-followup', 'interrupt', 'answer',
])

export const popupFitSchema = z.number().int().min(0).max(10_000)
export const popupOpenSchema = z.object({ threadId: z.string().min(1).max(6_144), watcher: z.boolean() }).strict()
export type PopupOpen = z.infer<typeof popupOpenSchema>
export const popupOpenedSchema = z.object({ page: z.enum(['threads', 'watcher']), notice: z.string().max(2_000).optional() }).strict()
export type PopupOpened = z.infer<typeof popupOpenedSchema>
export const popupShortcutReplaceSchema = z.string().min(1).max(64).nullable()

/**
 * Whether the shortcut works: `on` while it is registered, `off` with none chosen, `taken` when another app holds it,
 * and `dictation` when a dictation shortcut holds the same keys, so the popup leaves them to dictation.
 */
export const popupShortcutStateSchema = z.object({
  status: z.enum(['on', 'off', 'taken', 'dictation']),
  chord: z.string().min(1).max(64).nullable(),
}).strict()
export type PopupShortcutState = z.infer<typeof popupShortcutStateSchema>

export const popupShortcutResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['taken', 'dictation', 'invalid', 'unavailable']) }).strict(),
])
export type PopupShortcutResult = z.infer<typeof popupShortcutResultSchema>

/** Why a chord cannot be the popup's shortcut, or null when it can. */
export type PopupShortcutRefusal = 'needs-key' | 'plain-key' | 'escape' | 'dictation-press' | 'dictation-hold'

type DictationKeys = Pick<AppSettings, 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>

/** A modifier word on either platform's spelling. */
function modifierWord(token: string): boolean {
  return /^(?:commandorcontrol|cmdorctrl|command|cmd|control|ctrl|alt|option|altgr|shift|super|meta|fn)$/iu.test(token)
}

/**
 * Checks a chord against what it would collide with (ADR-0181): it needs a key and a modifier other than Shift, Escape
 * hides the popup, and a chord a dictation shortcut holds stays dictation's. A hold shortcut of modifiers alone would
 * start dictation each time the popup's keys go down, so it counts as holding every chord it is part of.
 */
export function popupShortcutRefusal(chord: string, dictation: DictationKeys, platform: SottoPlatform): PopupShortcutRefusal | null {
  const tokens = chordTokens(chord)
  if (!chordHasKey(chord)) return 'needs-key'
  if (tokens.some(token => token.toLowerCase() === 'escape' || token.toLowerCase() === 'esc')) return 'escape'
  const modifiers = tokens.filter(modifierWord)
  if (modifiers.length === 0 || modifiers.every(token => token.toLowerCase() === 'shift')) return 'plain-key'
  if ([dictation.hotkey, ...dictation.pressShortcuts].some(other => sameChord(other, chord, platform))) return 'dictation-press'
  const held = dictation.holdShortcuts.some(other => sameChord(other, chord, platform)
    || (!chordHasKey(other) && chordTokens(other).every(token => tokens.some(mine => sameChord(mine, token, platform)))))
  return held ? 'dictation-hold' : null
}

/** What the popup's window can ask of main (`window.sottoPopup`). */
export interface PopupBridge {
  readonly platform: SottoPlatform
  readonly interfaceLanguage?: InterfaceLanguageBridge
  /** Present only while Watcher is on (ADR-0072): the room, read for its current Watcher's thread. */
  readonly watcher?: () => Promise<WatcherRoomResult>
  getSettings(): Promise<AppSettings>
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void
  /** The whole shell, read when the popup is shown and before it starts a thread. */
  shell(): Promise<AgentState>
  threadDetail(threadId: string): Promise<AgentThreadDetail | null>
  onThreadDetail(listener: (update: AgentThreadDetailUpdate) => void): () => void
  onThread(listener: (thread: AgentThread) => void): () => void
  /** One of `POPUP_COMMAND_TYPES`; main refuses any other from this window. */
  command(command: AgentCommand): Promise<AgentCommandReceipt>
  openExternalLink(url: string): Promise<{ readonly ok: boolean }>
  hide(): Promise<void>
  fit(height: number): Promise<void>
  open(request: PopupOpen): Promise<void>
  onShown(listener: () => void): () => void
}

/** What the main window's preload offers Settings while the popup is on. */
export interface PopupShortcutBridge {
  state(): Promise<PopupShortcutState>
  onState(listener: (state: PopupShortcutState) => void): () => void
  replace(chord: string | null): Promise<PopupShortcutResult>
  onOpened(listener: (opened: PopupOpened) => void): () => void
}
