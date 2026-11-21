import React, { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { i18n as interfaceI18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { hostForThread, type AgentCommand, type AgentModel, type AgentRuntimeMode, type AgentState } from '../../../../shared/agents'
import { hostEntityKey } from '../../../../shared/clientIdentity'
import { OWLET_NAME_MAX, OWLET_ROLE_MAX, owletFolderLabel, owletNameProblem, owletProviderAllowed, sameOwletName } from '../../../../shared/owlets'
import { agentRuntimeModeSchema } from '../../../../shared/agents'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Select } from '../../components/Select'
import { useDialogFocus } from '../../components/useDialogFocus'
import { useOptionalApp } from '../../state/AppContext'
import { newThreadOptionsOn } from '../../agents/newThread'
import { RUNTIME_LABELS } from '../../agents/permissionPresentation'
import type { ThreadRow } from '../../agents/threadFacts'

/** A computer an owlet can live on: this computer or a connected paired host that makes owlets (`owlets`, ADR-0210). */
export interface OwletHome { readonly hostId: string; readonly name: string }

/**
 * The name a window gives an owlet's home computer: This computer for its own, and a paired host's own name. `inSentence`
 * is how a sentence says it, as in "Its folder is on this computer".
 */
export function owletHomeName(state: AgentState, hostId: string | undefined, inSentence = false): string {
  const connection = state.connections?.find(item => item.hostId === hostId)
  if (connection !== undefined && connection.kind !== 'local') return connection.name
  return inSentence ? interfaceI18n._(msg({ message: 'this computer', comment: 'An owlet\'s home computer inside a sentence, when it is the one the window runs on, as in "Its folder is on this computer".' }))
    : interfaceI18n._(msg({ message: 'This computer', comment: 'An owlet\'s home computer when it is the one the window runs on.' }))
}

/** The computers a new owlet can be made on, this computer first. */
export function owletHomes(state: AgentState): OwletHome[] {
  return (state.connections ?? []).filter(item => item.owlets === true && item.connected)
    .sort((a, b) => Number(b.kind === 'local') - Number(a.kind === 'local'))
    .map(item => ({ hostId: item.hostId, name: owletHomeName(state, item.hostId) }))
}

/** The ready models an owlet can run on, on one computer: Claude Code's and Codex's, whose own memory Sotto turns off. */
export function owletModels(state: AgentState, hostId: string): AgentModel[] {
  return hostForThread(state.host, { hostId }).models.filter(model => model.ready && model.hiddenFromMenu !== true && owletProviderAllowed(model.providerId))
}

/**
 * New owlet and Edit owlet (ADR-0210). A new owlet takes a name, a role, its home computer, a model and a permission mode;
 * Sotto makes its folder and its thread. An owlet's name and role change here; its model and permission mode change in its
 * thread, as any thread's do, and its home computer is the one it was made on.
 */
export function OwletSetup({ state, command, owlet, onClose, onMade }: {
  readonly state: AgentState
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  /** The owlet being edited; absent for a new one. */
  readonly owlet?: ThreadRow | undefined
  readonly onClose: () => void
  readonly onMade: (threadId: string) => void
}): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const titleId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const dialog = useDialogFocus({ onEscape: () => { if (!busy) onClose() }, initialFocus: nameRef })
  const homes = useMemo(() => owletHomes(state), [state])
  const editing = owlet?.thread.owlet
  const [name, setName] = useState(editing?.name ?? '')
  const [role, setRole] = useState(editing?.role ?? '')
  const [hostId, setHostId] = useState(owlet?.thread.hostId ?? homes[0]?.hostId ?? '')
  const models = useMemo(() => hostId ? owletModels(state, hostId) : [], [state, hostId])
  const defaults = useMemo(() => hostId ? newThreadOptionsOn(state, hostId) : undefined, [state, hostId])
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const modelId = chosenModel !== null && models.some(model => model.id === chosenModel) ? chosenModel
    : models.find(model => model.id === defaults?.modelId)?.id ?? models.find(model => model.recommended)?.id ?? models[0]?.id ?? ''
  const model = models.find(item => item.id === modelId)
  const modes = model?.runtimeModes?.length ? model.runtimeModes : agentRuntimeModeSchema.options
  const [chosenMode, setChosenMode] = useState<AgentRuntimeMode | null>(null)
  const runtimeMode = chosenMode !== null && modes.includes(chosenMode) ? chosenMode
    : defaults?.permission.runtimeMode && modes.includes(defaults.permission.runtimeMode) ? defaults.permission.runtimeMode : modes[0]!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameProblem = name.trim() === '' ? undefined : owletNameProblem(name)
  const taken = name.trim() !== '' && state.host.threads.some(thread => thread.id !== owlet?.thread.id && thread.owlet !== undefined && thread.hostId === (hostId || undefined)
    && sameOwletName(thread.owlet.name, name))
  const nameError = nameProblem ?? (taken ? t`An owlet on this computer already has that name.` : undefined)
  const ready = name.trim() !== '' && nameError === undefined && role.length <= OWLET_ROLE_MAX && (editing !== undefined || (hostId !== '' && modelId !== ''))
  const home = owletHomeName(state, hostId || undefined, true)
  const folder = owletFolderLabel(editing ? owlet?.project?.title ?? editing.name : name.trim() || '…')

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true); setError(null)
    const threadId = editing ? owlet!.thread.id : hostEntityKey(hostId, crypto.randomUUID())
    const result = await command(editing
      ? { type: 'set-owlet', threadId, name, role }
      : { type: 'create-owlet', threadId, name, role, modelId, runtimeMode, ...(defaults?.sentEffort !== undefined && model?.reasoningEfforts?.includes(defaults.sentEffort) ? { reasoningEffort: defaults.sentEffort } : {}) })
      .catch(() => null)
    setBusy(false)
    if (result === null) { setError(t`Sotto did not hear back, so the owlet may or may not have been made. Check the list before trying again.`); return }
    if (result.error) { setError(result.error); return }
    if (editing) onClose(); else onMade(threadId)
  }

  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className="tt-dialog owlet-setup" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined}
      onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }}>
      <h2 id={titleId}>{editing ? t`Edit ${editing.name}` : t`New owlet`}</h2>
      <Field label={t`Name`} {...nameError ? { error: nameError } : {}}>
        <input ref={nameRef} className="tt-input" value={name} maxLength={OWLET_NAME_MAX} autoComplete="off" spellCheck={false} onChange={event => setName(event.currentTarget.value)} />
      </Field>
      <Field label={t`Role`} description={t`What it does for you, in a few words, such as "Keeps my inbox".`}>
        <input className="tt-input" value={role} maxLength={OWLET_ROLE_MAX} autoComplete="off" onChange={event => setRole(event.currentTarget.value)} />
      </Field>
      {editing ? <p className="tt-paragraph owlet-setup__line">
        {t({ message: `On ${home}. Change its model and permission mode in its thread, as any thread's.`, comment: '{home} is the owlet\'s home computer, such as "This computer" or "forge".' })}
      </p> : <>
        {homes.length === 0 ? <p className="tt-paragraph owlet-setup__line" role="alert"><Trans>No computer here can make owlets. Owlets need Sotto Owl on the computer they live on.</Trans></p>
          : <Field label={t`Home computer`} description={t`An owlet lives on one computer. If that computer is asleep, it can't run.`}>
            <Select value={hostId} onChange={event => { setHostId(event.currentTarget.value); setChosenModel(null); setChosenMode(null) }}>
              {homes.map(item => <option key={item.hostId} value={item.hostId}>{item.name}</option>)}
            </Select>
          </Field>}
        {hostId ? models.length === 0 ? <p className="tt-paragraph owlet-setup__line" role="alert">{t({ message: `Connect Claude Code or Codex on ${home} to make an owlet there. Owlets run only on those two, whose own memory Sotto turns off.`, comment: '{home} is a computer, such as "This computer" or "forge".' })}</p>
          : <>
            <Field label={t`Model`} description={t`Claude Code or Codex. Sotto turns off their own memory in the owlet's folder.`}>
              <Select value={modelId} onChange={event => setChosenModel(event.currentTarget.value)}>
                {models.map(item => <option key={item.id} value={item.id}>{item.provider} · {item.name}</option>)}
              </Select>
            </Field>
            <Field label={t`Permission mode`} description={t`What it may do without asking, as for any thread. It asks you about everything else, and never answers its own cards.`}>
              <Select value={runtimeMode} onChange={event => setChosenMode(event.currentTarget.value as AgentRuntimeMode)}>
                {modes.map(mode => <option key={mode} value={mode}>{RUNTIME_LABELS[mode]}</option>)}
              </Select>
            </Field>
          </> : null}
      </>}
      <p className="tt-paragraph owlet-setup__line">
        {t({ message: `Its folder: ${folder} on ${home}. Sotto makes it, and its thread and its files live there.`, comment: '{folder} is like "Owlets/Tawny"; {home} is a computer, such as "This computer".' })}
      </p>
      <p className="tt-paragraph owlet-setup__line">
        <Trans>It can use the plugin accounts kept for every project. To give it an account kept to chosen projects, choose its folder for that account in Settings, under Plugins.</Trans>
        {app ? <> <button type="button" className="owlet-setup__link tt-focusable" onClick={() => { onClose(); app.actions.navigate('settings', 'settings-plugins') }}><Trans>Open Plugins</Trans></button></> : null}
      </p>
      {busy ? <p className="tt-dialog__status tt-paragraph" role="status">{editing ? t`Saving…` : t`Making the owlet…`}</p> : null}
      {error ? <p className="tt-dialog__status tt-dialog__status--error tt-paragraph" role="alert">{error}</p> : null}
      <div className="tt-dialog__actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>{editing ? t`Save` : t`Make owlet`}</Button>
      </div>
    </section>
  </div>
}
