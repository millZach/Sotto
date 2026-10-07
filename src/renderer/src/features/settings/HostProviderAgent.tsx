import React, { useId, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { PROVIDER_LABELS, type ProviderId } from '../../../../shared/agents'
import type { HostSetupChoice, HostsBridge, HostStatus } from '../../../../shared/hosts'
import { HOST_PROVIDER_JOB_WORDS, hostProviderJobTitle, type HostProviderJobCase } from '../../../../shared/hostProviders'
import { Button } from '../../components/Button'
import { HostsModal } from './HostsModal'
import { SetupModelSelect } from './HostSetupView'

const clean = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() || fallback : fallback

/**
 * Have my agent install it, update it or fix it (ADR-0035, amended for #461; `prototype/host-providers` round 2): the
 * dialog that starts a provider job. It says what the agent does and where it reaches, offers this computer's models
 * starting on the one used most, and names the thread and the project it goes in. Start closes it onto the working tile.
 */
export function HostProviderAgent({ host, provider, jobCase, choice, bridge, onClose }: {
  readonly host: HostStatus; readonly provider: ProviderId; readonly jobCase: HostProviderJobCase
  readonly choice: HostSetupChoice | undefined; readonly bridge: HostsBridge; readonly onClose: () => void
}): ReactNode {
  const name = PROVIDER_LABELS[provider]
  const title = hostProviderJobTitle(jobCase, provider, host.name)
  const words = HOST_PROVIDER_JOB_WORDS[jobCase]
  const available = choice !== undefined && !choice.unavailable && choice.models.length > 0
  const [modelId, setModelId] = useState('')
  const model = choice?.models.some(item => item.id === modelId) ? modelId : choice?.modelId ?? choice?.models[0]?.id ?? ''
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelHint = useId()
  const start = async (): Promise<void> => {
    if (!available || !model || starting) return
    setStarting(true); setError(null)
    try { await bridge.command({ type: 'start-provider-job', id: crypto.randomUUID(), hostId: host.id, provider, modelId: model }); onClose() }
    catch (failure) { setError(clean(failure, `The agent could not start. Nothing was started. Try again.`)) }
    finally { setStarting(false) }
  }
  return <HostsModal title={title} onClose={onClose} busy={starting} className="host-agent-dialog"
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      {/* Not disabled while it starts, so focus stays on it; a second press does nothing. */}
      <Button data-autofocus disabled={!available || !model} aria-disabled={starting || undefined} onClick={() => void start()}>{starting ? 'Starting…' : words.start}</Button>
    </>}>
    <div className="host-agent">
      <p>An agent {words.does} {name} on {host.name} from this computer, in a thread you can watch. It reaches {host.name} through this computer's SSH, and its tool works only on {host.name}. It stops once {host.name}'s host finds {name}; you then sign in.</p>
      {available ? <div className="host-agent__model">
        <SetupModelSelect choice={choice} value={model} onChange={setModelId} disabled={starting} label="Model" describedBy={modelHint} />
        <p id={modelHint} className="host-agent__quiet">The thread runs on this computer. Its provider receives the brief and what the agent's commands print on {host.name}. You answer each command it wants to run.</p>
      </div> : <div className="hosts-notice" role="status"><p>{choice?.unavailable ?? 'An agent cannot work on a host from this window.'}</p></div>}
      <p className="host-agent__quiet">The thread <b>{title}</b> goes in the <b>Host setup</b> project.</p>
      {starting ? <div className="hosts-notice hosts-notice--work" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p>Starting the thread.</p></div> : null}
      {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div> : null}
    </div>
  </HostsModal>
}
