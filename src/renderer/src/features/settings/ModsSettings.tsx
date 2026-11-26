import React, { useId, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Ban, FolderOpen, ListChecks, Wand2 } from 'lucide-react'

import { MOD_WORDS_MAX, type ModListed, type ModProblem } from '../../../../shared/mods'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { useOptionalAgents } from '../../agents/AgentContext'
import { PaneMenu } from '../../agents/PaneMenu'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { useOptionalApp } from '../../state/AppContext'
import { modsBridge, nextModsOff, useModsList } from '../../state/mods'
import { SettingsGroup } from './SettingsGroup'
import './mods.css'

type Status = { readonly text: string; readonly error: boolean; readonly threadId?: string }

/**
 * Settings › Mods (ADR-0217, Zach's pick B on November 25, 2026): Make a mod starts a thread in the Mods project with the
 * user's words; Your mods lists every mod with its switch and a More menu (View its code, Change it in a thread, Show in
 * folder, Remove); Turn off every mod and Open mods folder close the list. Shown only while the `mods` Owl feature is on.
 * Settings draws every page and hides all but the open one, so `shown` says whether this one reads the folder.
 */
export function ModsSettings({ settings, onUpdateSettings, shown }: {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly shown: boolean
}): ReactNode {
  const { t } = useLingui()
  const bridge = modsBridge()
  const list = useModsList(shown, bridge)
  const agents = useOptionalAgents()
  const app = useOptionalApp()
  const [words, setWords] = useState('')
  const [making, setMaking] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const wordsField = useRef<HTMLTextAreaElement>(null)
  const wordsId = useId()
  const off = settings.modsOff
  const mods = list?.mods ?? []

  const problemWords = (problem: ModProblem): string => problem === 'manifest'
    ? t`Its mod.json is missing or unreadable, so it paints nothing. It needs a name, such as { "name": "Oak sidebar" }.`
    : problem === 'outside'
      ? t`Its look loads something from outside Sotto (an @import, or a url() that is not a data: address), so none of it is painted.`
      : t`Its look is longer than 64 KB, so none of it is painted.`

  const make = async (): Promise<void> => {
    const text = words.trim()
    if (!bridge || making || !text) return
    setMaking(true); setStatus(null)
    try {
      const result = await bridge.make({ words: text })
      if ('error' in result) setStatus({ text: result.error, error: true })
      else { setWords(''); setStatus({ text: t`A thread is making it in the Mods project. The mod shows here once its files are written.`, error: false, threadId: result.threadId }) }
    } catch {
      setStatus({ text: t`The thread could not start. Nothing was started. Try again.`, error: true })
    } finally { setMaking(false) }
  }

  const openThread = (threadId: string): void => {
    void agents?.command({ type: 'select-thread', threadId }).catch(() => undefined)
    app?.actions.navigate('threads')
  }

  const setOn = (mod: ModListed, on: boolean): void => {
    void onUpdateSettings({ modsOff: nextModsOff(off, mods, { id: mod.id, on }) }).then(saved => setStatus(saved
      ? { text: on ? t`${mod.name} is on.` : t`${mod.name} is off.`, error: false }
      : { text: t`${mod.name} could not be switched. Nothing was changed. Try again.`, error: true }))
  }

  const allOff = (): void => {
    void onUpdateSettings({ modsOff: nextModsOff(off, mods, 'all-off') }).then(saved => setStatus(saved
      ? { text: t`Every mod is off. Their files are kept.`, error: false }
      : { text: t`The mods could not be switched off. Nothing was changed. Try again.`, error: true }))
  }

  const change = (mod: ModListed): void => {
    setWords(t`Change the mod “${mod.name}” (folder ${mod.id}): `)
    requestAnimationFrame(() => { const field = wordsField.current; if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length) } })
  }

  const remove = async (mod: ModListed): Promise<void> => {
    const removed = await bridge?.remove(mod.id).catch(() => false)
    setStatus(removed
      ? { text: t`${mod.name} is in the bin. Restore its folder from there to bring it back.`, error: false }
      : { text: t`${mod.name} could not be moved to the bin. Nothing was removed. Show it in its folder to remove it by hand.`, error: true })
  }

  const openFolder = (): void => {
    void bridge?.openFolder().catch(() => setStatus({ text: t`The mods folder could not be opened. Try again.`, error: true }))
  }

  return <>
    <div className="settings-section__heading">
      <h2>{t({ message: 'Mods', comment: 'A Settings page, named in its rail and its heading: mods that change how Sotto looks. Other messages name it as "Settings > Mods".' })}</h2>
      <p className="tt-paragraph">{t`Change how Sotto looks`}</p>
    </div>

    <SettingsGroup title={t`Make a mod`} icon={Wand2} rows={false} note={t`Say what to change. A thread in the Mods project writes the mod, and Sotto paints it as soon as its files are saved.`}>
      <div className="mods-make">
        <label className="tt-visually-hidden" htmlFor={wordsId}>{t`What the mod should change`}</label>
        <textarea ref={wordsField} id={wordsId} className="mods-make__words tt-input tt-focusable" data-setting="mods-make" rows={3} maxLength={MOD_WORDS_MAX}
          placeholder={t`Give the sidebar a warm wood look`} value={words} onChange={event => setWords(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void make() } }} />
        <div className="mods-make__foot">
          <span className="tt-paragraph">{t`Starts a thread in Sotto’s mods folder`}</span>
          <Button variant="primary" disabled={!bridge || making || !words.trim()} onClick={() => void make()}>{making ? t`Starting…` : t`Start a thread`}</Button>
        </div>
      </div>
      <p className={`mods-status tt-paragraph${status?.error ? ' mods-status--error' : ''}`} role="status">
        {status?.text ?? ''}
        {status?.threadId ? <> <button type="button" className="mods-status__link tt-focusable" onClick={() => openThread(status.threadId!)}>{t`Open thread`}</button></> : null}
      </p>
    </SettingsGroup>

    <SettingsGroup title={t`Your mods`} icon={ListChecks} rows={false}>
      <div className="mods-list">
        {list === undefined ? <p className="mods-empty tt-paragraph">{t`Reading the mods folder…`}</p>
          : mods.length === 0 ? <p className="mods-empty tt-paragraph">{t`No mods yet. Make one above, or put a mod’s folder in the mods folder.`}</p>
            : mods.map(mod => <div key={mod.id} className="mods-row" data-problem={mod.problem}>
              <div className="mods-row__main">
                <Toggle label={mod.name} checked={!off.includes(mod.id)} onCheckedChange={on => setOn(mod, on)}
                  description={mod.problem ? problemWords(mod.problem) : mod.description ?? t`In the ${mod.id} folder`} />
              </div>
              <PaneMenu className="mods-row__more" label={t`More for ${mod.name}`} groups={[[
                { id: 'view', label: viewing === mod.id ? t`Hide its code` : t`View its code`, run: () => setViewing(current => current === mod.id ? null : mod.id) },
                { id: 'change', label: t`Change it in a thread`, run: () => change(mod) },
                { id: 'reveal', label: t`Show in folder`, run: () => { void bridge?.reveal(mod.id) } },
              ], [
                { id: 'remove', label: t`Remove`, tone: 'danger', run: () => void remove(mod) },
              ]]} />
              {viewing === mod.id
                ? <pre className="mods-row__code" aria-label={t`${mod.name}’s look`}>{mod.look.trim() || t`This mod has no look.css yet.`}</pre>
                : null}
            </div>)}
      </div>
      <div className="mods-foot">
        <Button variant="secondary" data-setting="mods-turn-off" disabled={mods.length === 0 || mods.every(mod => off.includes(mod.id))} onClick={allOff}>
          <Ban size={14} aria-hidden="true" />{t`Turn off every mod`}
        </Button>
        <Button variant="ghost" data-setting="mods-folder" disabled={!bridge} onClick={openFolder}><FolderOpen size={14} aria-hidden="true" />{t`Open mods folder`}</Button>
      </div>
      <p className="mods-note tt-paragraph">{app?.platform === 'darwin'
        ? t`Cmd+Option+Shift+M turns every mod off from anywhere in Sotto, even when a mod hides the controls.`
        : t`Ctrl+Alt+Shift+M turns every mod off from anywhere in Sotto, even when a mod hides the controls.`}</p>
    </SettingsGroup>

    <SettingsGroup title={t`What a mod cannot do`} icon={Ban} rows={false}>
      <ul className="mods-limits tt-paragraph">
        <li>{t`Answer a permission or a question for you.`}</li>
        <li>{t`Change what is sent to an agent.`}</li>
        <li>{t`Load anything from the internet, or send anything anywhere.`}</li>
      </ul>
    </SettingsGroup>
  </>
}
