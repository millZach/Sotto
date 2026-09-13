import React, { useEffect, useState, type ReactNode } from 'react'
import { isSubscriptionReasoning, type AgentConfiguration, type AgentCommand } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useOptionalAgents } from './AgentContext'
import { VoiceSettings } from './VoiceSettings'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'

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

export function AgentAccountSettings(): ReactNode {
  const agents = useOptionalAgents()
  const state = agents?.state
  const command = agents?.command
  const [checking, setChecking] = useState(false)
  if (!state || !command) return <p>Agent account settings are loading.</p>
  const configuration = state.configuration
  const account = state.reasoningAccounts.find(account => account.provider === configuration.reasoning)
  const subscription = isSubscriptionReasoning(configuration.reasoning)
  const model = account?.models.find(model => model.id === (configuration.reasoningModel || account.defaultModelId))
  const save = async (patch: Partial<AgentConfiguration>): Promise<boolean> => {
    const result = await command({ type: 'configure', patch })
    return result !== null && result.error === null
  }
  const check = async (): Promise<void> => {
    if (!isSubscriptionReasoning(configuration.reasoning)) return
    setChecking(true)
    try { await command({ type: 'check-reasoning', provider: configuration.reasoning }) } finally { setChecking(false) }
  }
  return <div className="account-settings">
    <p className="settings-state">{configuration.reasoning === 'none' ? 'Choose the coordinator Sotto uses for deep reasoning and managing your threads.' : `${account?.label ?? configuration.reasoning} coordinates Sotto’s reasoning and thread management.`}</p>
    <div className="account-rows">
      <label>Reasoning account<select aria-label="Reasoning account" value={configuration.reasoning} disabled={checking} onChange={event => { void save({ reasoning: event.target.value as AgentConfiguration['reasoning'], reasoningModel: '', reasoningEffort: '' }) }}><option value="none">Not configured</option><optgroup label="Your subscriptions"><option value="codex">ChatGPT · Codex</option><option value="claude">Claude · Claude Code</option><option value="grok">Grok · Grok Build</option></optgroup><optgroup label="API accounts"><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option></optgroup></select></label>
      {subscription ? <><label>Reasoning model<select aria-label="Reasoning model" value={configuration.reasoningModel} disabled={!account?.ready} onChange={event => void save({ reasoningModel: event.target.value, reasoningEffort: '' })}><option value="">Provider default</option>{configuration.reasoningModel && !account?.models.some(model => model.id === configuration.reasoningModel) ? <option value={configuration.reasoningModel}>{configuration.reasoningModel}</option> : null}{account?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>Reasoning effort<select aria-label="Reasoning effort" value={configuration.reasoningEffort} disabled={!account?.ready || !model?.reasoningEfforts?.length} onChange={event => void save({ reasoningEffort: event.target.value })}><option value="">Provider default</option>{configuration.reasoningEffort && !model?.reasoningEfforts?.includes(configuration.reasoningEffort) ? <option value={configuration.reasoningEffort}>{configuration.reasoningEffort} · unavailable</option> : null}{model?.reasoningEfforts?.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label><div className="account-connection"><p role="status">{checking ? 'Checking your provider account…' : account?.detail ?? 'Check the account signed in through your installed provider app.'}</p><Button variant="secondary" disabled={checking || state.busy} onClick={() => void check()}>Check connection</Button></div></> : configuration.reasoning !== 'none' ? <><SavedField label="Reasoning model" value={configuration.reasoningModel} onSave={reasoningModel => save({ reasoningModel })} /><SavedField label="Reasoning API key" value="" secret placeholder={state.credentials.reasoning ? 'Saved securely · enter to replace' : 'Enter your API key'} onSave={async value => { const result = await command({ type: 'credential', slot: 'reasoning', value: value.trim() }); return result !== null && result.error === null }} />{state.credentials.reasoning ? <Button variant="ghost" disabled={state.busy} onClick={() => void command({ type: 'credential', slot: 'reasoning', value: '' })}>Remove reasoning API key</Button> : null}</> : null}
    </div>
    {state.error ? <p className="agent-error" role="alert">{state.error}</p> : null}
  </div>
}

export function AgentSetupFields(): ReactNode {
  const agents = useOptionalAgents()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p>Preparing agent configuration…</p>
  const configuration = state.configuration
  const perform = async (request: AgentCommand): Promise<boolean> => { const result = await command(request); return result !== null && result.error === null }
  const save = (patch: Partial<AgentConfiguration>): Promise<boolean> => perform({ type: 'configure', patch })
  return <div className="account-settings"><h3 className="agent-coordinator-heading">Sotto coordinator</h3><AgentAccountSettings /><div className="account-rows">
    <ProviderUpgradeNotice state={state} command={command} />
    <SavedField label="Default projects directory" value={configuration.projectsDirectory} onSave={projectsDirectory => save({ projectsDirectory })} />
    <SavedField label="Automatic follow-up limit" value={String(configuration.followupLimit)} onSave={value => /^\d+$/.test(value) && Number(value) <= 100 ? save({ followupLimit: Number(value) }) : Promise.resolve(false)} />
    <SavedField label="Wake model directory" value={configuration.wakeModelDirectory} onSave={wakeModelDirectory => save({ wakeModelDirectory })} />
    <SavedField label="Wake runtime directory" value={configuration.wakeRuntimeDirectory} onSave={wakeRuntimeDirectory => save({ wakeRuntimeDirectory })} />
  </div><VoiceSettings configuration={configuration} command={command} change={(key, value) => { void save({ [key]: value }) }} grokKeySaved={state.credentials.grokSpeech} voiceError={state.voice.error} />
  <div className="agent-billing"><p><b>{state.membership.label}</b></p><p>Provider usage is separate from Sotto access. Free dictation remains available without an account.</p>{configuration.membershipEndpoint ? <div className="agent-actions"><Button variant="secondary" onClick={() => void command({ type: 'membership', action: 'signin' })}>Sign in to Sotto</Button><Button variant="secondary" onClick={() => void command({ type: 'membership', action: state.membership.status === 'active' ? 'portal' : 'checkout' })}>{state.membership.status === 'active' ? 'Manage subscription' : 'Get Sotto Pro'}</Button><Button variant="ghost" onClick={() => void command({ type: 'membership', action: 'refresh' })}>Refresh membership</Button></div> : <p>Hosted sign-in and checkout are not available in this private development beta.</p>}</div>
  </div>
}
