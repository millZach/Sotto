import React, { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, SlidersHorizontal } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentCommand, type AgentConfiguration, type AgentRuntimeMode, type AgentState } from '../../../shared/agents'
import { resolveNewThreadPermission, RUNTIME_MODE_ORDER } from '../../../shared/newThreadDefaults'
import { chosenModelId, resolveModel } from '../../../shared/modelCatalog'
import { useOptionalAgents, type AgentConnection } from './AgentContext'
import { newThreadDefaultModelId, newThreadDefaultsCatalog, newThreadOptionsOn } from './newThread'
import { ChoiceChip, effortChoices, RUNTIME_LABELS } from './ThreadOptions'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'
import { SettingsGroup } from '../features/settings/SettingsGroup'
import './agents.css'

/**
 * Settings → Threads' "New threads start with" row: the composer's own model, reasoning and permission chips,
 * saving on change (issue #347). The permissions chip always lists Sotto's four modes, whatever the chosen
 * model offers, because the default is a Sotto-wide preference; the note under the row says when the chosen
 * model's provider starts a thread on a different mode instead (the nearest safer one it offers, or, for a
 * provider with its own permission profiles such as Devin, its first). The defaults are this computer's and apply on
 * every host (ADR-0074), so the models are this computer's, and a second note names any host that holds back a
 * permission that lets a thread act without asking, because that host does not let this computer answer.
 */
function NewThreadDefaultsRow({ state, command }: { readonly state: AgentState; readonly command: AgentConnection['command'] }): ReactNode {
  const { t } = useLingui()
  const configuration = state.configuration
  const models = newThreadDefaultsCatalog(state)
  const modelId = newThreadDefaultModelId(state)
  // A long-context variant the catalog does not list (`opus[1m]`) answers from its base model's entry.
  const model = resolveModel(models, modelId)
  const reasoning = configuration.newThreadReasoningEffort || model?.defaultReasoningEffort || ''
  const efforts = effortChoices(model, reasoning)
  const chosenMode = configuration.newThreadRuntimeMode
  const provider = (model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider) ?? t({ message: 'This provider', comment: 'Stands for a provider whose name is not known, at the start of a sentence.' })
  // An unset option at the top, so a chosen default can go back to the provider's own once it is set.
  const permissionOptions = [{ id: '', label: t`Provider default` }, ...RUNTIME_MODE_ORDER.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode] }))]
  let fitNote: string | null = null
  if (model?.providerModes?.length) fitNote = t({ message: `${provider} uses its own permission profiles; a new thread starts on its first.`, comment: '{provider} is a provider\'s name.' })
  else if (chosenMode) {
    const resolved = resolveNewThreadPermission(model, chosenMode)
    if (resolved.nearestFit && resolved.runtimeMode) {
      const chosen = RUNTIME_LABELS[chosenMode], fit = RUNTIME_LABELS[resolved.runtimeMode]
      fitNote = t({ message: `${provider} has no "${chosen}", so its threads start on "${fit}".`, comment: '{provider} is a provider\'s name; {chosen} and {fit} are permission modes.' })
    }
  }
  const holding = (state.connections ?? []).filter(connection => connection.kind === 'remote' && connection.connected
    && newThreadOptionsOn(state, connection.hostId).permission.heldBack).map(connection => connection.name)
  const count = holding.length
  const hosts = new Intl.ListFormat('en', { type: 'conjunction' }).format(holding)
  const asking = RUNTIME_LABELS['approval-required']
  const heldNote = count === 0 ? null : plural(count, {
    one: `${hosts} doesn’t let this computer answer permission requests yet, so its new threads start on "${asking}".`,
    other: `${hosts} don’t let this computer answer permission requests yet, so their new threads start on "${asking}".`,
  })
  const save = (patch: Extract<AgentCommand, { type: 'configure' }>['patch']): void => { void command({ type: 'configure', patch }) }
  return <div className="account-row account-row--chips">
    <span className="account-row__heading"><strong>{t`New threads start with`}</strong><span>{t`Model, reasoning effort and permissions.`}</span></span>
    <fieldset className="account-row__control">
      <legend className="tt-visually-hidden">{t`New threads start with`}</legend>
      <ModelPicker models={models} modelId={modelId} disabled={false} onChange={pressed => save({ newThreadModelId: chosenModelId(models, pressed, modelId) })} />
      {efforts.length > 0 && <EffortPicker value={reasoning} options={efforts} disabled={false}
        onChange={effort => save({ newThreadReasoningEffort: effort })} defaultValue={model?.defaultReasoningEffort} modelName={model?.name} />}
      <ChoiceChip label={t`Default permissions for new threads`} placeholder={t`Provider default`} value={chosenMode ?? ''} options={permissionOptions} disabled={false} pending={false}
        onChange={mode => save({ newThreadRuntimeMode: (mode || null) as AgentRuntimeMode | null })} />
    </fieldset>
    {fitNote ? <p className="account-row__note">{fitNote}</p> : null}
    {heldNote ? <p className="account-row__note">{heldNote}</p> : null}
  </div>
}

/** A text setting saved when it loses focus. `heading` and `description` show in place of the label, which stays its name. */
function SavedField({ label, value, onSave, secret = false, placeholder, heading, description, disabled = false }: {
  readonly label: string; readonly value: string; readonly onSave: (value: string) => Promise<boolean>
  readonly secret?: boolean; readonly placeholder?: string; readonly heading?: string; readonly description?: string; readonly disabled?: boolean
}): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState(false)
  useEffect(() => { setDraft(value) }, [value])
  const shown = heading === undefined ? label : <span className="account-row__heading"><strong>{heading}</strong>{description ? <span>{description}</span> : null}</span>
  return <label className="agent-saved-field">{shown}<input aria-label={label} value={draft} disabled={disabled} type={secret ? 'password' : 'text'} autoComplete="off" placeholder={placeholder ?? ''} onChange={event => { setDraft(event.target.value); setError(false) }} onBlur={() => {
    if (draft === value) return
    void onSave(draft).then(ok => { setError(!ok); if (ok && secret) setDraft('') }).catch(() => setError(true))
  }} aria-invalid={error} />{error ? <span role="alert">{t`Could not save. Check the value and try again.`}</span> : null}</label>
}

export function AgentSetupFields(): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p className="tt-paragraph">{t`Preparing agent configuration…`}</p>
  const configuration = state.configuration
  const save = async (patch: Partial<AgentConfiguration>, hostId?: string): Promise<boolean> => {
    const result = await command({ type: 'configure', patch, ...(hostId ? { hostId } : {}) }); return result !== null && result.error === null
  }
  // Each computer keeps its own projects folder, so with a host connected there is a row for each (ADR-0074).
  const computers = (state.connections?.length ?? 0) > 1 ? state.connections ?? [] : null
  // Two of Settings → Threads' cards: what new threads start with, and where new projects go.
  return <div className="account-settings">
    <SettingsGroup title={t`New threads`} icon={SlidersHorizontal} rows={false} note={computers
      ? t`New threads start with these on every connected computer. Change them for one thread in its composer.`
      : t`New threads start with these. Change them for one thread in its composer.`}>
      <div className="settings-rows account-rows">
        <NewThreadDefaultsRow state={state} command={command} />
        <ProviderUpgradeNotice state={state} command={command} />
      </div>
    </SettingsGroup>
    <SettingsGroup title={t({ message: 'Projects', comment: 'A Settings card about where new projects go.' })} icon={FolderOpen} rows={false} {...(computers ? { note: t`Where a new project goes. Each computer has its own folder.` } : {})}>
      <div className="settings-rows account-rows">
        {computers ? computers.map(computer => {
          const computerName = computer.name
          return <SavedField key={computer.hostId} heading={computer.name}
            label={computer.kind === 'local' ? t`Default projects directory on this computer` : t({ message: `Default projects directory on ${computerName}`, comment: '{computerName} is the name of a saved host.' })}
            description={computer.connected ? t`Default projects directory` : t({ message: `Connect ${computerName} to change its projects directory.`, comment: '{computerName} is the name of a saved host.' })} disabled={!computer.connected}
            value={state.host.clientHosts?.find(host => host.hostId === computer.hostId)?.projectsDirectory ?? ''} onSave={projectsDirectory => save({ projectsDirectory }, computer.hostId)} />
        })
          : <SavedField label={t`Default projects directory`} value={configuration.projectsDirectory} onSave={projectsDirectory => save({ projectsDirectory })} />}
      </div>
    </SettingsGroup>
    {state.error ? <p className="agent-error" role="alert">{state.error}</p> : null}
  </div>
}
