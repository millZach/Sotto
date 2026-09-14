import React, { useId, useRef, useState, type ReactNode } from 'react'
import { CircleDot, RefreshCw, Sun, TerminalSquare } from 'lucide-react'
import { enabledThreadProviders, PROVIDER_LABELS, providerIdSchema, type ProviderId } from '../../../shared/agents'
import { Button } from '../components/Button'
import { Toggle } from '../components/Toggle'
import { useOptionalAgents } from './AgentContext'
import { newestModelsFirst } from './ModelPicker'
import './providers.css'

const CLIENT_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build' }
function ProviderIcon({ provider }: { readonly provider: ProviderId }): ReactNode {
  const Icon = provider === 'codex' ? TerminalSquare : provider === 'claude' ? Sun : CircleDot
  return <Icon size={21} strokeWidth={1.6} aria-hidden="true" />
}

export function ProvidersSettings(): ReactNode {
  const agents = useOptionalAgents()
  const [selected, setSelected] = useState<ProviderId>('codex')
  const [tab, setTab] = useState<'configuration' | 'models'>('configuration')
  const [pending, setPending] = useState<Partial<Record<ProviderId, 'connect' | 'disconnect' | 'refresh'>>>({})
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const inFlight = useRef(new Set<ProviderId>())
  const tabId = useId()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p role="status">Loading providers…</p>
  const enabled = enabledThreadProviders(state.configuration)
  const statusFor = (id: ProviderId) => state.host.providers?.find(provider => provider.id === id)
    ?? { connection: id === state.configuration.provider ? state.connection : 'disconnected', version: '', error: undefined }
  const status = statusFor(selected)
  const connected = status.connection === 'connected'
  const working = pending[selected] || status.connection === 'connecting'
  const models = newestModelsFirst(state.host.models.filter(model => model.providerId === selected
    || (!model.providerId && model.provider === PROVIDER_LABELS[selected])))
  const label = PROVIDER_LABELS[selected]
  const detailError = errors[selected] ?? status.error
  const perform = async (provider: ProviderId, type: 'connect' | 'disconnect' | 'refresh'): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setPending(previous => ({ ...previous, [provider]: type }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      const result = await command({ type, provider })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? 'Could not update this provider. Try again.' }))
    } catch { setErrors(previous => ({ ...previous, [provider]: 'Could not update this provider. Try again.' })) }
    finally { inFlight.current.delete(provider); setPending(previous => ({ ...previous, [provider]: undefined })) }
  }
  const setDefault = async (modelId: string): Promise<void> => {
    const result = await command({ type: 'configure', patch: { defaultModelId: modelId } })
    if (!result || result.error) setErrors(previous => ({ ...previous, [selected]: result?.error ?? 'Could not save the default model.' }))
  }
  return <div className="providers-settings">
    <div className="providers-workspace">
      <nav className="providers-list" aria-label="Thread providers">{providerIdSchema.options.map(provider => {
        const current = statusFor(provider)
        const active = enabled.includes(provider)
        const connecting = current.connection === 'connecting' || pending[provider]
        const statusLabel = pending[provider] === 'disconnect' ? 'Disconnecting…' : pending[provider] === 'refresh' ? 'Refreshing…' : connecting ? 'Connecting…' : current.connection === 'connected' ? 'Connected' : current.connection === 'error' ? 'Needs attention' : active ? 'Not connected' : 'Disabled'
        return <div key={provider} className="providers-list__row" data-selected={provider === selected}>
          <button type="button" className="providers-list__select" aria-label={PROVIDER_LABELS[provider]} aria-pressed={provider === selected}
            onClick={() => setSelected(provider)}><ProviderIcon provider={provider} /><span><strong>{PROVIDER_LABELS[provider]}</strong>
              <small data-status={current.connection}><i aria-hidden="true" />{statusLabel}</small></span></button>
          <Toggle label={`Enable ${PROVIDER_LABELS[provider]}`} checked={active} disabled={Boolean(connecting)} onCheckedChange={value => void perform(provider, value ? 'connect' : 'disconnect')} />
        </div>
      })}</nav>
      <section className="provider-detail" aria-label="Provider configuration">
        <header className="provider-detail__header"><ProviderIcon provider={selected} /><h3>{label}</h3>{status.version && <span className="provider-detail__version">{status.version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? status.version.slice(0, 36)}</span>}
          {connected && <Button variant="ghost" iconOnly aria-label={`Refresh ${label}`} disabled={Boolean(working)} onClick={() => void perform(selected, 'refresh')}><RefreshCw size={15} /></Button>}
        </header>
        <div className="provider-tabs" role="tablist" aria-label="Provider details">{(['configuration', 'models'] as const).map(value => <button type="button" key={value} id={`${tabId}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${tabId}-panel`}
          tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'configuration' ? 'models' : 'configuration'; setTab(next); document.getElementById(`${tabId}-${next}`)?.focus() } }}>{value === 'configuration' ? 'Configuration' : 'Models'}</button>)}</div>
        <div key={`${selected}-${tab}`} id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} className="provider-detail__body">
          {tab === 'configuration' ? <>
            <div className="provider-connection"><div><h4>Local connection</h4><p>Uses your sign-in in {CLIENT_NAMES[selected]} on this computer.</p></div>
              <Button variant={connected ? 'secondary' : 'primary'} disabled={Boolean(working)} aria-label={`${connected ? 'Disconnect' : status.connection === 'error' ? 'Retry' : 'Connect'} ${label}`}
                onClick={() => void perform(selected, connected ? 'disconnect' : 'connect')}>{working ? pending[selected] === 'disconnect' ? 'Disconnecting…' : pending[selected] === 'refresh' ? 'Refreshing…' : 'Connecting…' : connected ? 'Disconnect' : status.connection === 'error' ? 'Retry connection' : 'Connect'}</Button>
            </div>
            <label className="provider-default">Default for new threads<select aria-label={`${label} default thread model`} value={models.some(model => model.id === state.configuration.defaultModelId) ? state.configuration.defaultModelId : ''}
              disabled={!connected || Boolean(working)} onChange={event => void setDefault(event.target.value)}><option value="">Choose a model</option>{models.map(model => <option key={model.id} value={model.id} disabled={!model.ready}>{model.name}</option>)}</select></label>
          </> : models.length ? <ul className="provider-models" aria-label={`${label} available models`}>{models.map(model => <li key={model.id}><span><strong>{model.name}</strong>{model.reasoningEfforts?.length ? <small>{model.reasoningEfforts.join(' · ')}</small> : null}</span><small>{model.ready ? model.id === state.configuration.defaultModelId ? 'Default' : 'Available' : 'Unavailable'}</small></li>)}</ul> : <p className="provider-models__empty">{connected ? 'No models were returned. Refresh this provider to check again.' : `Connect ${label} to load its models.`}</p>}
          {detailError && <p role="alert" className="provider-detail__error">{detailError}</p>}
        </div>
      </section>
    </div>
  </div>
}
