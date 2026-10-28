import React, { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { AppWindow, Columns2, GitBranch, Info, MessagesSquare, RotateCcw, SquarePen, X } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { chordInline, chordWords } from '../../../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { DEFAULT_THREAD_SHORTCUTS, isPageShortcut, resolveThreadShortcut, type ThreadShortcutChoices, type ThreadShortcutId } from '../../../../shared/threadShortcuts'
import { parseAccelerator, parseChord } from '../../agents/branchToolbar.logic'
import { acceleratorForChord, chordFromAccelerator, menuOwnedChord, sameThreadKeys } from '../../agents/threadShortcuts'
import { changesChord } from '../../tools/changesShortcut'
import { pageChordHolder, pageShortcutShown, usePageShortcutGates } from '../../components/pageShortcuts'
import { ShortcutKey } from '../../components/ShortcutKey'
import { SettingsGroup } from './SettingsGroup'
import { shownWords, type LaterWords } from './laterWords'
import { useChordRecorder } from './useChordRecorder'
import './dictationShortcuts.css'
import './threadShortcuts.css'

export interface ThreadShortcutsSettingsProps {
  readonly settings: Pick<AppSettings, 'threadShortcuts' | 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>
  readonly platform: SottoPlatform
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  /** Dictation's keys keep their own rows; this page's entry for them only points there. */
  readonly onOpenDictation?: (() => void) | undefined
}

/** What the application menu calls each chord it owns (`menuOwnedChords`), for naming it in a refusal. */
const MENU_OWNER_NAMES: Readonly<Record<string, MessageDescriptor>> = {
  'ctrl+r': msg`Reload the window`,
  'ctrl+shift+r': msg`Force reload the window`,
  'ctrl+shift+i': msg`Toggle developer tools`,
  'ctrl+w': msg`Close the window`,
  'mod+w': msg`Close the window`,
  'ctrl+0': msg`Actual size`,
  'mod+0': msg`Actual size`,
}

interface RowCopy { readonly id: ThreadShortcutId; readonly label: MessageDescriptor; readonly description: MessageDescriptor }
interface GroupCopy { readonly title: MessageDescriptor; readonly icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>; readonly rows: readonly RowCopy[] }

const GROUPS: readonly GroupCopy[] = [
  {
    title: msg`Switch pages`, icon: AppWindow, rows: [
      { id: 'page-dictate', label: msg`Dictate`, description: msg`Open the Dictate room.` },
      { id: 'page-watcher', label: msg`Watcher`, description: msg`Open Watcher’s room.` },
      { id: 'page-threads', label: msg`Threads`, description: msg`Open the Threads page.` },
      { id: 'page-usage', label: msg`Usage`, description: msg`Open the Usage page.` },
      { id: 'page-settings', label: msg`Settings`, description: msg`Open Settings.` },
    ],
  },
  {
    title: msg`Threads`, icon: MessagesSquare, rows: [
      { id: 'new-thread', label: msg`New thread`, description: msg`In the focused thread’s project, or the chooser when none is focused.` },
      { id: 'settle', label: msg`Settle thread`, description: msg`Put the focused thread on the Settled shelf. Its delegated threads go with it, and Settle asks about its worktree first, as the button does.` },
      { id: 'restore', label: msg`Restore settled thread`, description: msg`Bring the focused settled thread back to the sidebar.` },
      { id: 'open-beside', label: msg`Open beside`, description: msg`Open the thread whose sidebar row holds the keys in a pane beside the current one. At its default either primary modifier with Enter answers.` },
      { id: 'next-thread', label: msg`Next thread`, description: msg`Move to the next thread in the sidebar’s order.` },
      { id: 'previous-thread', label: msg`Previous thread`, description: msg`Move to the previous thread in the sidebar’s order.` },
      { id: 'next-waiting', label: msg`Next thread waiting on you`, description: msg`Jump to the next question or permission, settled threads included.` },
    ],
  },
  {
    title: msg`Panes`, icon: Columns2, rows: [
      { id: 'zoom-pane', label: msg`Zoom pane`, description: msg`Zoom the focused pane in a split, or show all panes again. This was Ctrl+Shift+M on every platform; record that here to keep the old keys on a Mac.` },
      { id: 'close-pane', label: msg`Close pane`, description: msg`Close the focused pane in a split. The thread keeps running.` },
    ],
  },
  {
    title: msg`In the composer`, icon: SquarePen, rows: [
      { id: 'focus-prompt', label: msg`Focus the prompt`, description: msg`Put the cursor in the focused pane’s composer.` },
      { id: 'stop-turn', label: msg`Stop the running turn`, description: msg`Stop the focused thread’s turn, like its Stop button.` },
      { id: 'add-selection', label: msg`Add selection to prompt`, description: msg`Quote the words selected in a reply into the composer.` },
    ],
  },
  {
    title: msg`Tools & branch bar`, icon: GitBranch, rows: [
      { id: 'changes', label: msg`Changes`, description: msg`Open Tools on Changes, or close it when Changes is showing. At its default, the shifted chord answers while dictation holds the plain one.` },
      { id: 'terminal-drawer', label: msg`Terminal drawer`, description: msg`Show or hide the focused pane’s terminal drawer.` },
      { id: 'branch', label: msg`Branch…`, description: msg`Open the branch bar’s branch chooser, in the focused pane.` },
      { id: 'working-copy', label: msg`Working copy…`, description: msg`Open the branch bar’s working-copy chooser, in the focused pane.` },
      { id: 'previous-working-copy', label: msg`Previous working copy`, description: msg`Switch the focused thread back to its previous working copy.` },
    ],
  },
]

interface RowMessage { readonly id: ThreadShortcutId; readonly text: LaterWords; readonly alert: boolean }

const UNSUPPORTED_KEY = msg`That key can’t be part of a shortcut here. Try a letter, a number, an F key, Space, Enter or an arrow key.`

/**
 * Settings › Keyboard (ADR-0133): every thread shortcut as a recordable row, the fixed keys for reference,
 * and dictation pointed to rather than repeated. Recording, messages and focus follow Dictation's rows; the
 * chords are T3's spelling, read from the window's keys — dictation stays the one global exception.
 */
export function ThreadShortcutsSettings({ settings, platform, onUpdateSettings, onOpenDictation }: ThreadShortcutsSettingsProps): ReactNode {
  const { t, i18n } = useLingui()
  const recorder = useChordRecorder(platform, false)
  const [filter, setFilter] = useState('')
  const [target, setTarget] = useState<ThreadShortcutId | null>(null)
  const [message, setMessage] = useState<RowMessage | null>(null)
  const [notice, setNotice] = useState<LaterWords | null>(null)
  const [focusId, setFocusId] = useState<ThreadShortcutId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)
  const saveRef = useRef(0)
  const id = useId()
  const choices = settings.threadShortcuts
  // A page that is not there (an Owl feature held back, or Dictate with dictation off) shows no row and holds no keys (ADR-0158).
  const gates = usePageShortcutGates()
  const shown = (row: RowCopy): boolean => !isPageShortcut(row.id) || pageShortcutShown(row.id, gates)
  const groupRows = (group: GroupCopy): readonly RowCopy[] => group.rows.filter(shown)
  const resolved = (row: ThreadShortcutId): string | null => resolveThreadShortcut(choices, row)
  const acceleratorOf = (chord: string): string => acceleratorForChord(chord, platform)
  const inline = (chord: string): string => chordInline(acceleratorOf(chord), platform)
  const changed = (row: ThreadShortcutId): boolean => {
    const chord = resolved(row)
    return chord === null || !sameThreadKeys(chord, DEFAULT_THREAD_SHORTCUTS[row], platform)
  }

  // Focus returns to the shortcut once its row has re-rendered without the recording box.
  useEffect(() => {
    if (focusId === null) return
    rootRef.current?.querySelector<HTMLElement>(`[data-focus-key="${focusId}"]`)?.focus()
    setFocusId(null)
  })

  const show = (row: ThreadShortcutId, text: LaterWords, alert: boolean): void => setMessage({ id: row, text, alert })

  const save = async (next: ThreadShortcutChoices, row: ThreadShortcutId, previous: string | null): Promise<boolean> => {
    const mine = ++saveRef.current
    const ok = await Promise.resolve(onUpdateSettings({ threadShortcuts: next })).catch(() => false)
    // A newer save answers for the page; this slower, older answer must not overwrite it.
    if (mine !== saveRef.current) return ok
    if (ok) show(row, msg`Shortcut saved.`, false)
    else if (previous !== null) show(row, msg`The shortcut could not be changed. ${inline(previous)} still works.`, true)
    else show(row, msg`The shortcut could not be changed. It still has no shortcut.`, true)
    return ok
  }

  /** Who already holds these keys, in the words its own row would use; null when they are free. */
  const owner = (chord: string, except: ThreadShortcutId): LaterWords | null => {
    const own = parseChord(chord, platform)
    const heldBy = (accelerator: string): boolean => {
      const taken = parseAccelerator(accelerator, platform)
      return taken !== null && taken.key === own.key && taken.ctrl === own.ctrl && taken.shift === own.shift && taken.alt === own.alt && taken.meta === own.meta
    }
    const keys = inline(chord)
    if (heldBy(settings.hotkey) || settings.pressShortcuts.some(heldBy)) {
      return msg`Sotto’s start-and-stop dictation shortcut already uses ${keys}. Pick other keys.`
    }
    if (settings.holdShortcuts.some(heldBy)) {
      return msg`Sotto’s hold-to-talk dictation shortcut already uses ${keys}. Pick other keys.`
    }
    if (sameThreadKeys(chord, 'mod+k', platform)) {
      return msg`Search transcripts already uses ${keys}. Pick other keys.`
    }
    // The application menu sees its accelerators before the window does, so these keys would never arrive.
    const menuOwned = menuOwnedChord(chord, platform)
    if (menuOwned !== null) {
      const name = i18n._(MENU_OWNER_NAMES[menuOwned] ?? msg`Sotto’s menu`)
      return msg`${name} already uses ${keys}. Pick other keys.`
    }
    for (const group of GROUPS) for (const row of groupRows(group)) {
      if (row.id === except) continue
      // Changes may be answering to its shifted fallback while dictation holds its plain chord, so the keys
      // it holds are the ones it answers to, not only the ones it is set to.
      const other = row.id === 'changes' ? changesChord(resolved(row.id), settings.hotkey, platform)
        // A page shortcut standing down at its default holds nothing; the saved row it stands down for is named instead.
        // One the user saved still holds its keys against a new recording, even while another saved row meets it.
        : isPageShortcut(row.id) && !Object.hasOwn(choices, row.id) && pageChordHolder(settings, row.id, platform, gates) !== null ? null : resolved(row.id)
      if (other !== null && sameThreadKeys(chord, other, platform)) {
        const name = i18n._(row.label)
        return msg`${name} already uses ${keys}. Pick other keys.`
      }
    }
    return null
  }

  const commit = async (row: ThreadShortcutId, chord: string): Promise<boolean> => {
    const previous = resolved(row)
    if (previous !== null && sameThreadKeys(previous, chord, platform)) {
      show(row, msg`Shortcut saved.`, false)
      return true
    }
    const held = owner(chord, row)
    if (held !== null) {
      show(row, held, true)
      return false
    }
    return save({ ...choices, [row]: chord }, row, previous)
  }

  const record = async (row: ThreadShortcutId): Promise<void> => {
    setMessage(null)
    setNotice(null)
    setTarget(row)
    // A newer recording (a click with no pointerdown, as screen readers send) outlives this one's cancel.
    const generation = ++generationRef.current
    const recorded = await recorder.record()
    if (generation !== generationRef.current) return
    setTarget(null)
    setFocusId(row)
    if (recorded === null) return
    if (recorded === 'unsupported-key') { show(row, UNSUPPORTED_KEY, true); return }
    if (recorded === 'taken-press' || recorded === 'taken-hold') {
      show(row, recorded === 'taken-press' ? msg`Sotto’s start-and-stop dictation shortcut already uses those keys. Pick other keys.` : msg`Sotto’s hold-to-talk dictation shortcut already uses those keys. Pick other keys.`, true)
      return
    }
    const chord = chordFromAccelerator(recorded, platform)
    if (chord === null) {
      const parsed = parseAccelerator(recorded, platform)
      show(row, parsed !== null && !parsed.ctrl && !parsed.meta
        ? (platform === 'darwin' ? msg`This shortcut needs ⌘ Command or ⌃ Control, so plain typing can never set it off.` : msg`This shortcut needs Ctrl, so plain typing can never set it off.`)
        : UNSUPPORTED_KEY, true)
      return
    }
    await commit(row, chord)
  }

  const remove = async (row: ThreadShortcutId): Promise<void> => {
    setMessage(null)
    await save({ ...choices, [row]: null }, row, resolved(row))
    setFocusId(row)
  }

  const reset = async (row: ThreadShortcutId): Promise<void> => {
    setMessage(null)
    const next = { ...choices }
    delete next[row]
    const ok = await save(next, row, resolved(row))
    if (ok) show(row, msg`Back to the default, ${inline(DEFAULT_THREAD_SHORTCUTS[row])}.`, false)
    setFocusId(row)
  }

  const restoreAll = async (): Promise<void> => {
    setMessage(null)
    const mine = ++saveRef.current
    const ok = await Promise.resolve(onUpdateSettings({ threadShortcuts: {} })).catch(() => false)
    if (mine !== saveRef.current) return
    setNotice(ok ? msg`All shortcuts are back to their defaults.` : msg`The shortcuts could not be reset. Your keys are unchanged.`)
  }

  const recordingBox = (row: ThreadShortcutId): ReactNode => (
    <span className="dictation-shortcuts__recording">
      {recorder.held.length === 0
        ? <span className="dictation-shortcuts__prompt"><Trans>Press the new keys…</Trans></span>
        : <ShortcutKey accelerator={recorder.held.join('+')} platform={platform} />}
      <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Cancel recording`} title={t`Cancel recording`} data-recording-cancel autoFocus onClick={recorder.cancel} data-focus-key={`${row}-cancel`}>
        <X size={13} aria-hidden="true" />
      </button>
    </span>
  )

  const query = filter.trim().toLowerCase()
  const matches = (row: RowCopy): boolean => {
    if (query === '') return true
    const chord = resolved(row.id)
    const haystack = `${i18n._(row.label)} ${i18n._(row.description)} ${chord === null ? t`No shortcut` : chordWords(acceleratorOf(chord), platform)}`.toLowerCase()
    return query.split(/\s+/u).every(word => haystack.includes(word))
  }

  /** A page shortcut whose keys another saved shortcut holds stands down, and says which (ADR-0158). */
  const heldNote = (row: ThreadShortcutId): { readonly text: LaterWords; readonly alert: boolean } | null => {
    const holder = isPageShortcut(row) ? pageChordHolder(settings, row, platform, gates) : null
    const chord = resolved(row)
    if (holder === null || chord === null) return null
    const name = i18n._(GROUPS.flatMap(group => group.rows).find(other => other.id === holder)!.label)
    return { text: msg`${name} already uses ${inline(chord)}, so these keys do nothing here until one of the two changes.`, alert: false }
  }

  const rowView = (row: RowCopy): ReactNode => {
    const chord = resolved(row.id)
    const label = i18n._(row.label)
    const recordingHere = target === row.id
    const line = recordingHere
      ? { text: recorder.held.length === 0 ? msg`Hold the keys you want, then let go. Esc cancels.` : msg`Let go to save. Esc cancels.`, alert: false }
      : message?.id === row.id ? message : heldNote(row.id)
    const words = chord === null ? t`No shortcut` : chordWords(acceleratorOf(chord), platform)
    return (
      <div key={row.id} className="dictation-shortcuts__row" role="group" data-setting={`shortcut-${row.id}`} aria-labelledby={`${id}-${row.id}-label`} aria-describedby={`${id}-${row.id}-description`}>
        <div className="dictation-shortcuts__text">
          <span className="tt-field__label" id={`${id}-${row.id}-label`}>{label}</span>
          <p className="tt-field__description tt-paragraph" id={`${id}-${row.id}-description`}>{i18n._(row.description)}{changed(row.id) ? <> <Trans>Default is</Trans> {inline(DEFAULT_THREAD_SHORTCUTS[row.id])}.</> : null}</p>
        </div>
        <div className="dictation-shortcuts__controls">
          {recordingHere ? recordingBox(row.id) : (
            <span className="dictation-shortcuts__chord">
              {changed(row.id) ? <span className="thread-shortcuts__dot" title={t`Changed from the default`} /> : null}
              <button type="button" className={`dictation-shortcuts__chip tt-focusable${chord === null ? ' thread-shortcuts__none' : ''}`} aria-label={t`Change shortcut, ${words}`} data-focus-key={row.id} onClick={() => void record(row.id)}>
                {chord === null ? <Trans>No shortcut</Trans> : <ShortcutKey accelerator={acceleratorOf(chord)} platform={platform} />}
              </button>
              {changed(row.id) ? <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Reset ${label} to its default`} title={t`Reset to ${inline(DEFAULT_THREAD_SHORTCUTS[row.id])}`} onClick={() => void reset(row.id)}><RotateCcw size={13} aria-hidden="true" /></button> : null}
              {chord !== null ? <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Remove shortcut, ${words}`} title={t`Remove shortcut`} onClick={() => void remove(row.id)}><X size={13} aria-hidden="true" /></button> : null}
            </span>
          )}
        </div>
        {line === null ? null : (
          <p className={`dictation-shortcuts__message tt-paragraph${line.alert ? ' is-error' : ''}`} role={line.alert ? 'alert' : 'status'}>{shownWords(line.text)}</p>
        )}
      </div>
    )
  }

  const fixedRow = (label: string, description: ReactNode, accelerator: string, key: string): ReactNode => (
    <div key={key} className="dictation-shortcuts__row">
      <div className="dictation-shortcuts__text">
        <span className="tt-field__label">{label}</span>
        <p className="tt-field__description tt-paragraph">{description}</p>
      </div>
      <div className="dictation-shortcuts__controls">
        <span className="dictation-shortcuts__chip thread-shortcuts__locked"><ShortcutKey accelerator={accelerator} platform={platform} /></span>
      </div>
    </div>
  )

  const dictationAccelerator = settings.hotkey
  const fixedRows: ReactNode[] = [
    fixedRow(t`Dictation (press & hold)`, onOpenDictation
      ? <><Trans>Global — the one set that works outside Sotto.</Trans>{' '}<button type="button" className="dictation-shortcuts__add tt-focusable" onClick={onOpenDictation}><Trans>Settings › Dictation</Trans></button></>
      : <Trans>Global — the one set that works outside Sotto. Changed in Settings › Dictation.</Trans>, dictationAccelerator, 'dictation'),
    fixedRow(t`Send the prompt`, <Trans>The composer’s own key. Shift+Enter adds a line.</Trans>, 'Enter', 'send'),
    fixedRow(t`Steer now`, <Trans>In the composer while a turn runs, where the agent can take it. Otherwise it does what Enter does.</Trans>, acceleratorOf('mod+enter'), 'steer'),
    fixedRow(t`Commit, use folder`, <Trans>Inside its dialog only.</Trans>, acceleratorOf('mod+enter'), 'commit'),
    fixedRow(t`Search transcripts`, <Trans>Opens the Dictate room on its search, from any page.</Trans>, acceleratorOf('mod+k'), 'search'),
    fixedRow(t`Terminal search & text size`, <Trans>The terminal’s own keys, while a terminal holds them.</Trans>, acceleratorOf('mod+f'), 'terminal'),
    ...(platform === 'darwin' ? [fixedRow(t`Settings`, <Trans>macOS’s own Settings chord, from the app menu.</Trans>, 'CommandOrControl+,', 'settings')] : []),
  ]
  const fixedMatches = query === '' || 'fixed dictation send steer search terminal settings'.includes(query)
  const changedCount = GROUPS.flatMap(groupRows).filter(row => changed(row.id)).length

  return (
    <div ref={rootRef}>
      <p className="tt-paragraph thread-shortcuts__lead"><Trans>Click a shortcut and press the new keys; let go to save. These keys work while Sotto is in front, and stand down in terminals and dialogs. Dictation’s keys always win a tie.</Trans></p>
      <input className="tt-input thread-shortcuts__filter" type="search" aria-label={t`Filter shortcuts`} placeholder={t`Filter by action or keys`} value={filter} onChange={event => setFilter(event.currentTarget.value)} />
      {notice !== null ? <p className="tt-paragraph thread-shortcuts__notice" role="status">{shownWords(notice)}</p> : null}
      {GROUPS.map(group => {
        const rows = groupRows(group).filter(matches)
        if (rows.length === 0) return null
        return (
          <SettingsGroup key={i18n._(group.title)} title={i18n._(group.title)} icon={group.icon}>
            <div className="dictation-shortcuts">{rows.map(rowView)}</div>
          </SettingsGroup>
        )
      })}
      {fixedMatches ? (
        <SettingsGroup title={t`Fixed & elsewhere`} icon={Info}>
          <div className="dictation-shortcuts">{fixedRows}</div>
        </SettingsGroup>
      ) : null}
      {query !== '' && GROUPS.every(group => groupRows(group).filter(matches).length === 0) && !fixedMatches
        ? <p className="tt-paragraph thread-shortcuts__notice"><Trans>Nothing matches. Clear the filter to see every shortcut.</Trans></p> : null}
      <div className="thread-shortcuts__foot">
        <span>{changedCount === 0 ? <Trans>Every shortcut is at its default.</Trans> : <>{changedCount} <Trans>changed from their defaults.</Trans></>}</span>
        <button type="button" className="dictation-shortcuts__add tt-focusable" data-setting="shortcut-restore-defaults" disabled={changedCount === 0} onClick={() => void restoreAll()}><Trans>Restore defaults</Trans></button>
      </div>
    </div>
  )
}
