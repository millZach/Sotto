import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MessageSquareText, RotateCcw, X } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { chordInline, chordWords, sameChord } from '../../../../shared/dictationShortcuts'
import { popupShortcutRefusal, type PopupShortcutRefusal, type PopupShortcutState } from '../../../../shared/popup'
import type { SottoPlatform } from '../../../../shared/platform'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/settings'
import { ShortcutKey } from '../../components/ShortcutKey'
import { useOwlFeature } from '../../state/owlFeature'
import { SettingsGroup } from './SettingsGroup'
import { shownWords, type LaterWords } from './laterWords'
import { useChordRecorder } from './useChordRecorder'
import './dictationShortcuts.css'
import './threadShortcuts.css'

const DEFAULT_CHORD = DEFAULT_SETTINGS.popupShortcut

interface Line { readonly text: LaterWords; readonly alert: boolean }

/**
 * Settings › Keyboard's row for the popup's shortcut (ADR-0181), only while the Owl feature is on: the recorder the other
 * rows use, Remove, and Back to the default. Main registers new keys before they are saved, so keys another app holds
 * are refused and the old ones keep working; the row says when the saved keys could not be taken.
 */
export function PopupShortcutSetting({ settings, platform }: {
  readonly settings: Pick<AppSettings, 'popupShortcut' | 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>
  readonly platform: SottoPlatform
}): ReactNode {
  const on = useOwlFeature('popup')
  const bridge = on ? window.sotto?.popup : undefined
  if (bridge === undefined) return null
  return <PopupShortcutRow settings={settings} platform={platform} bridge={bridge} />
}

function PopupShortcutRow({ settings, platform, bridge }: {
  readonly settings: Pick<AppSettings, 'popupShortcut' | 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>
  readonly platform: SottoPlatform
  readonly bridge: NonNullable<NonNullable<Window['sotto']>['popup']>
}): ReactNode {
  const { t } = useLingui()
  const recorder = useChordRecorder(platform, false)
  const [state, setState] = useState<PopupShortcutState | null>(null)
  const [line, setLine] = useState<Line | null>(null)
  const [recording, setRecording] = useState(false)
  const [focusChip, setFocusChip] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const id = useId()
  const inline = (chord: string): string => chordInline(chord, platform)

  useEffect(() => {
    let live = true
    void bridge.state().then(next => { if (live) setState(next) }, () => undefined)
    const off = bridge.onState(setState)
    return () => { live = false; off() }
  }, [bridge])
  // Focus returns to the shortcut once its row has drawn again without the recording box.
  useEffect(() => { if (focusChip) { chip.current?.focus(); setFocusChip(false) } }, [focusChip])

  const chord = settings.popupShortcut
  const changed = chord === null || DEFAULT_CHORD === null || !sameChord(chord, DEFAULT_CHORD, platform)

  const refusalWords = (refusal: PopupShortcutRefusal, keys: string): LaterWords => {
    switch (refusal) {
      case 'needs-key': return msg`The popup’s shortcut needs a key besides the modifiers, such as Space or a letter.`
      case 'plain-key': return platform === 'darwin'
        ? msg`${keys} on its own would show the popup while you type. Add ⌥ Option, ⌃ Control or ⌘ Command.`
        : msg`${keys} on its own would show the popup while you type. Add Alt or Ctrl.`
      case 'escape': return msg`Esc hides the popup, so it can’t show it. Pick other keys.`
      case 'dictation-press': return msg`Sotto’s start-and-stop dictation shortcut already uses ${keys}. Pick other keys.`
      case 'dictation-hold': return msg`Sotto’s hold-to-talk dictation shortcut already uses ${keys}. Pick other keys.`
    }
  }

  const replace = async (next: string | null): Promise<void> => {
    const kept = chord === null ? null : inline(chord)
    const result = await bridge.replace(next).catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
    if (result.ok) {
      setLine({ text: next === null ? msg`The popup has no shortcut. Show it from the tray.` : next === DEFAULT_CHORD ? msg`Back to the default, ${inline(next)}.` : msg`Shortcut saved.`, alert: false })
      return
    }
    const keys = next === null ? '' : inline(next)
    const still = kept === null ? msg`The popup still has no shortcut.` : msg`${kept} still works.`
    const why = result.reason === 'taken' ? msg`Another app already uses ${keys}. Pick other keys, or free them in that app.`
      : result.reason === 'dictation' ? msg`A dictation shortcut already uses ${keys}. Pick other keys.`
      : msg`The shortcut could not be changed.`
    setLine({ text: `${shownWords(why)} ${shownWords(still)}`, alert: true })
  }

  const record = async (): Promise<void> => {
    setLine(null)
    setRecording(true)
    // Recording stands every shortcut aside, the popup's too, so pressing its keys is recorded rather than shows the popup.
    const recorded = await recorder.record()
    setRecording(false)
    setFocusChip(true)
    if (recorded === null) return
    if (recorded === 'unsupported-key') { setLine({ text: msg`That key can’t be part of a shortcut. Try a letter, a number, an F key, Space or an arrow key.`, alert: true }); return }
    if (recorded === 'taken-press' || recorded === 'taken-hold') {
      setLine({ text: recorded === 'taken-press' ? msg`Sotto’s start-and-stop dictation shortcut already uses those keys. Pick other keys.`
        : msg`Sotto’s hold-to-talk dictation shortcut already uses those keys. Pick other keys.`, alert: true })
      return
    }
    if (chord !== null && sameChord(recorded, chord, platform) && state?.status === 'on') { setLine({ text: msg`Shortcut saved.`, alert: false }); return }
    const refusal = popupShortcutRefusal(recorded, settings, platform)
    if (refusal !== null) { setLine({ text: refusalWords(refusal, inline(recorded)), alert: true }); return }
    await replace(recorded)
  }

  // What the saved keys do now, when it is not what they say: another app or dictation holds them.
  const standing: Line | null = state === null || chord === null || state.chord !== chord ? null
    : state.status === 'taken' ? { text: msg`Another app already uses ${inline(chord)}, so the popup has no shortcut. Pick other keys, or free them in that app.`, alert: true }
    : state.status === 'dictation' ? { text: msg`Dictation uses ${inline(chord)}, so the popup has no shortcut. Pick other keys.`, alert: true }
    : null
  const shownLine = recording
    ? { text: recorder.held.length === 0 ? msg`Hold the keys you want, then let go. Esc cancels.` : msg`Let go to save. Esc cancels.`, alert: false }
    : line ?? standing
  const words = chord === null ? t`No shortcut` : chordWords(chord, platform)
  const label = t`Show the popup`

  return (
    <SettingsGroup title={t`Popup`} icon={MessageSquareText}>
      <div className="dictation-shortcuts">
        <div className="dictation-shortcuts__row" role="group" data-setting="popup-shortcut" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`}>
          <div className="dictation-shortcuts__text">
            <span className="tt-field__label" id={`${id}-label`}>{label}</span>
            <p className="tt-field__description tt-paragraph" id={`${id}-description`}>
              <Trans>Shows the popup over any app, or hides it. It works outside Sotto, like dictation’s keys.</Trans>
              {platform === 'linux' ? <> <Trans>On Linux the desktop decides whether Sotto may take these keys; the tray’s Show popup always opens it.</Trans></> : null}
              {changed && DEFAULT_CHORD !== null ? <> <Trans>Default is</Trans> {inline(DEFAULT_CHORD)}.</> : null}
            </p>
          </div>
          <div className="dictation-shortcuts__controls">
            {recording ? (
              <span className="dictation-shortcuts__recording">
                {recorder.held.length === 0
                  ? <span className="dictation-shortcuts__prompt"><Trans>Press the new keys…</Trans></span>
                  : <ShortcutKey accelerator={recorder.held.join('+')} platform={platform} />}
                <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Cancel recording`} title={t`Cancel recording`} data-recording-cancel autoFocus onClick={recorder.cancel}>
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            ) : (
              <span className="dictation-shortcuts__chord">
                {changed ? <span className="thread-shortcuts__dot" title={t`Changed from the default`} /> : null}
                <button ref={chip} type="button" className={`dictation-shortcuts__chip tt-focusable${chord === null ? ' thread-shortcuts__none' : ''}`} aria-label={t`Change shortcut, ${words}`} onClick={() => void record()}>
                  {chord === null ? <Trans>No shortcut</Trans> : <ShortcutKey accelerator={chord} platform={platform} />}
                </button>
                {changed && DEFAULT_CHORD !== null ? (
                  <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Reset ${label} to its default`} title={t`Reset to ${inline(DEFAULT_CHORD)}`} onClick={() => void replace(DEFAULT_CHORD).then(() => setFocusChip(true))}>
                    <RotateCcw size={13} aria-hidden="true" />
                  </button>
                ) : null}
                {chord !== null ? (
                  <button type="button" className="dictation-shortcuts__icon tt-focusable" aria-label={t`Remove shortcut, ${words}`} title={t`Remove shortcut`} onClick={() => void replace(null).then(() => setFocusChip(true))}>
                    <X size={13} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            )}
          </div>
          {shownLine === null ? null : (
            <p className={`dictation-shortcuts__message tt-paragraph${shownLine.alert ? ' is-error' : ''}`} role={shownLine.alert ? 'alert' : 'status'}>{shownWords(shownLine.text)}</p>
          )}
        </div>
      </div>
    </SettingsGroup>
  )
}
