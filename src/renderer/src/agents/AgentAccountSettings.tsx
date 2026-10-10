import React, { useEffect, useState, type ReactNode } from 'react'
import { defaultNewThreadModelId, PROVIDER_LABELS, type AgentConfiguration, type AgentRuntimeMode, type AgentState } from '../../../shared/agents'
import { resolveNewThreadPermission, RUNTIME_MODE_ORDER } from '../../../shared/newThreadDefaults'
import { chosenModelId, resolveModel } from '../../../shared/modelCatalog'
import { useOptionalAgents, type AgentConnection } from './AgentContext'
import { ChoiceChip, effortChoices, RUNTIME_LABELS } from './ThreadOptions'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './ModelPicker'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'
import './agents.css'

/**
 * Settings → Agents' "New threads start with" row: the composer's own model, reasoning and permission chips,
 * saving on change (issue #347). The permissions chip always lists Sotto's four modes, whatever the chosen
 * model offers, because the default is a Sotto-wide preference; the note under the row says when the chosen
 * model's provider starts a thread on a different mode instead (the nearest safer one it offers, or, for a
 * provider with its own permission profiles such as Devin, its first).
 */
function NewThreadDefaultsRow({ state, command }: { readonly state: AgentState; readonly command: AgentConnection['command'] }): ReactNode {
  const configuration = state.configuration
  const models = state.host.models
  const modelId = defaultNewThreadModelId(configuration, models, state.reasoningAccounts)
  // A long-context variant the catalog does not list (`opus[1m]`) answers from its base model's entry.
  const model = resolveModel(models, modelId)
  const reasoning = configuration.newThreadReasoningEffort || model?.defaultReasoningEffort || ''
  const efforts = effortChoices(model, reasoning)
  const chosenMode = configuration.newThreadRuntimeMode
  const providerLabel = model?.providerId ? PROVIDER_LABELS[model.providerId] : model?.provider
  // An unset option at the top, so a chosen default can go back to the provider's own once it is set.
  const permissionOptions = [{ id: '', label: 'Provider default' }, ...RUNTIME_MODE_ORDER.map(mode => ({ id: mode, label: RUNTIME_LABELS[mode] }))]
  let fitNote: string | null = null
  if (model?.providerModes?.length) fitNote = `${providerLabel ?? 'This provider'} uses its own permission profiles; a new thread starts on its first.`
  else if (chosenMode) {
    const resolved = resolveNewThreadPermission(model, chosenMode)
    if (resolved.nearestFit && resolved.runtimeMode) fitNote = `${providerLabel ?? 'This provider'} has no "${RUNTIME_LABELS[chosenMode]}", so its threads start on "${RUNTIME_LABELS[resolved.runtimeMode]}".`
  }
  const save = (patch: Partial<AgentConfiguration>): void => { void command({ type: 'configure', patch }) }
  return <div className="account-row account-row--chips">
    <span className="account-row__heading"><strong>New threads start with</strong><span>Model, reasoning effort and permissions, as the composer shows them.</span></span>
    <fieldset className="account-row__control">
      <legend className="tt-visually-hidden">New threads start with</legend>
      <ModelPicker models={models} modelId={modelId} disabled={false} onChange={pressed => save({ newThreadModelId: chosenModelId(models, pressed, modelId) })} />
      {efforts.length > 0 && <EffortPicker value={reasoning} options={efforts} disabled={false}
        onChange={effort => save({ newThreadReasoningEffort: effort })} defaultValue={model?.defaultReasoningEffort} modelName={model?.name} />}
      <ChoiceChip label="Default permissions for new threads" placeholder="Provider default" value={chosenMode ?? ''} options={permissionOptions} disabled={false} pending={false}
        onChange={mode => save({ newThreadRuntimeMode: (mode || undefined) as AgentRuntimeMode | undefined })} />
    </fieldset>
    {fitNote ? <p className="account-row__note">{fitNote}</p> : null}
  </div>
}

function SavedField({ label, value, onSave, secret = false, placeholder }: {
  readonly label: string; readonly value: string; readonly onSave: (value: string) => Promise<boolean>
  readonly secret?: boolean; readonly placeholder?: string
}): ReactNode {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState(false)
  useEffect(() => { setDraft(value) }, [value])
  return <label className="agent-saved-field">{label}<input aria-label={label} value={draft} type={secret ? 'password' : 'text'} autoComplete="off" placeholder={placeholder ?? ''} onChange={event => { setDraft(event.target.value); setError(false) }} onBlur={() => {
    if (draft === value) return
    void onSave(draft).then(ok => { setError(!ok); if (ok && secret) setDraft('') }).catch(() => setError(true))
  }} aria-invalid={error} />{error ? <span role="alert">Could not save. Check the value and try again.</span> : null}</label>
}

export function AgentSetupFields(): ReactNode {
  const agents = useOptionalAgents()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p>Preparing agent configuration…</p>
  const configuration = state.configuration
  const save = async (patch: Partial<AgentConfiguration>): Promise<boolean> => { const result = await command({ type: 'configure', patch }); return result !== null && result.error === null }
  return <div className="account-settings"><div className="account-rows">
    <h3 className="account-rows__heading account-rows__heading--first">New threads</h3>
    <p className="account-rows__subheading">A new thread in a project opens straight away with these. Change them for one thread under its composer.</p>
    <NewThreadDefaultsRow state={state} command={command} />
    <ProviderUpgradeNotice state={state} command={command} />
    <h3 className="account-rows__heading">Projects</h3>
    <SavedField label="Default projects directory" value={configuration.projectsDirectory} onSave={projectsDirectory => save({ projectsDirectory })} />
  </div>{state.error ? <p className="agent-error" role="alert">{state.error}</p> : null}</div>
}
