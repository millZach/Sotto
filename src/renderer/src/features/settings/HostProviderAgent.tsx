import React, { useId, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS } from '../../../../shared/agents'
import type { HostSetupChoice, HostsBridge, HostStatus } from '../../../../shared/hosts'
import { HOST_PROVIDER_JOB_WORDS, hostProviderJobTitle, type HostProviderId, type HostProviderJobCase } from '../../../../shared/hostProviders'
import { Button } from '../../components/Button'
import { HostsModal } from './HostsModal'
import { SetupModelSelect } from './HostSetupView'
import { shownWords, type LaterWords } from './laterWords'

const clean = (failure: unknown, fallback: LaterWords): LaterWords =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() || fallback : fallback

/** The project a provider job's thread goes in, by its name: the name the thread list shows, so it stays as it is. */
const HOST_SETUP_PROJECT = 'Host setup'

/**
 * Have my agent install it, update it or fix it (ADR-0035, amended for #461; `prototype/host-providers` round 2): the
 * dialog that starts a provider job. It says what the agent does and where it reaches, offers this computer's models
 * starting on the one used most, and names the thread and the project it goes in. Start closes it onto the working tile.
 */
export function HostProviderAgent({ host, provider, jobCase, choice, bridge, onClose }: {
  readonly host: HostStatus; readonly provider: HostProviderId; readonly jobCase: HostProviderJobCase
  readonly choice: HostSetupChoice | undefined; readonly bridge: HostsBridge; readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const name = PROVIDER_LABELS[provider]
  const hostName = host.name
  const title = hostProviderJobTitle(jobCase, provider, host.name)
  const words = HOST_PROVIDER_JOB_WORDS[jobCase], does = words.does
  const available = choice !== undefined && !choice.unavailable && choice.models.length > 0
  const [modelId, setModelId] = useState('')
  const model = choice?.models.some(item => item.id === modelId) ? modelId : choice?.modelId ?? choice?.models[0]?.id ?? ''
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<LaterWords | null>(null)
  const modelHint = useId()
  const project = HOST_SETUP_PROJECT
  const start = async (): Promise<void> => {
    if (!available || !model || starting) return
    setStarting(true); setError(null)
    try { await bridge.command({ type: 'start-provider-job', id: crypto.randomUUID(), hostId: host.id, provider, modelId: model }); onClose() }
    catch (failure) { setError(clean(failure, msg`The agent could not start. Nothing was started. Try again.`)) }
    finally { setStarting(false) }
  }
  return <HostsModal title={title} onClose={onClose} busy={starting} className="host-agent-dialog"
    footer={<>
      <Button variant="secondary" onClick={onClose}>{t`Cancel`}</Button>
      {/* Not disabled while it starts, so focus stays on it; a second press does nothing. */}
      <Button data-autofocus disabled={!available || !model} aria-disabled={starting || undefined} onClick={() => void start()}>{starting ? t`Starting…` : words.start}</Button>
    </>}>
    <div className="host-agent">
      <p className="tt-paragraph"><Trans comment="{does} is what the agent does to the provider: installs, updates or fixes.">An agent {does} {name} on {hostName} from this computer, in a thread you can watch. It reaches {hostName} through this computer's SSH, and its tool works only on {hostName}. It stops once {hostName}'s host finds {name}; you then sign in.</Trans></p>
      {available ? <div className="host-agent__model">
        <SetupModelSelect choice={choice} value={model} onChange={setModelId} disabled={starting} label={t({ message: 'Model', comment: 'The AI model an agent runs on.' })} describedBy={modelHint} />
        <p id={modelHint} className="host-agent__quiet tt-paragraph"><Trans>The thread runs on this computer. Its provider receives the brief and what the agent's commands print on {hostName}. You answer each command it wants to run.</Trans></p>
      </div> : <div className="hosts-notice" role="status"><p className={choice?.unavailable ? undefined : 'tt-paragraph'}>{choice?.unavailable ?? t`An agent cannot work on a host from this window.`}</p></div>}
      <p className="host-agent__quiet tt-paragraph"><Trans comment="{project} is the name of a project in the thread list.">The thread <b>{title}</b> goes in the <b>{project}</b> project.</Trans></p>
      {starting ? <div className="hosts-notice hosts-notice--work" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p className="tt-paragraph"><Trans>Starting the thread.</Trans></p></div> : null}
      {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p className={typeof error === 'string' ? undefined : 'tt-paragraph'}>{shownWords(error)}</p></div> : null}
    </div>
  </HostsModal>
}
