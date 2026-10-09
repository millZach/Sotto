import { Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { AgentProviderStatus, ProviderId } from '../../../../shared/agents'
import { PROVIDER_INSTALL_GUIDES } from '../../../../shared/hostProviders'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ProviderMark } from '../../agents/ProviderMark'
import { Button } from '../../components/Button'
import { shownVersion } from '../settings/HostProviders'
import { liveAgentState, localProviders, providerLabel, SETUP_PROVIDERS } from './localAgents'

export interface AgentsStepProps {
  readonly heading: ReactNode
  readonly onOpenLink: (url: string) => Promise<boolean>
}

type RowKind = 'ready' | 'checking' | 'not-installed' | 'needs-you' | 'unchecked'
interface Row { readonly kind: RowKind; readonly state: string; readonly detail: string; readonly guide: boolean }

/**
 * One provider's row. A provider main never tried after the check is one this computer does not have: connecting
 * without naming a provider tries only the clients it finds installed.
 */
function rowFor(status: AgentProviderStatus | undefined, checking: boolean, checked: boolean): Row {
  const version = status?.version ? shownVersion(status.version) : ''
  if (status?.connection === 'connected') return { kind: 'ready', state: 'Ready', detail: [status.account, version].filter(Boolean).join(' · ') || 'Signed in', guide: false }
  if (status?.connection === 'connecting' || (checking && status?.connection !== 'error')) return { kind: 'checking', state: 'Checking…', detail: version, guide: false }
  if (status?.connection === 'error') {
    const said = status.error ?? ''
    switch (status.problem) {
      case 'not-installed': return { kind: 'not-installed', state: 'Not installed', detail: said || 'Not found on this computer.', guide: true }
      case 'signed-out': return { kind: 'needs-you', state: 'Not signed in', detail: said || 'Installed. Sign in to it, then check again.', guide: false }
      case 'too-old': return { kind: 'needs-you', state: 'Too old to use', detail: said || 'Update it, then check again.', guide: true }
      case 'cannot-start': return { kind: 'needs-you', state: "Can't be started", detail: said || 'Installed, but Sotto could not start it.', guide: false }
      default: return { kind: 'needs-you', state: 'Needs attention', detail: said || 'Sotto could not connect it.', guide: false }
    }
  }
  if (checked) return { kind: 'not-installed', state: 'Not installed', detail: 'Not found on this computer.', guide: true }
  return { kind: 'unchecked', state: 'Not checked yet', detail: '', guide: false }
}

/**
 * Setup's coding agents: which of Codex, Claude Code, Grok Build and Devin this computer can run, and what each one
 * needs. Arriving connects every client found installed, as Connect providers does; Check again looks again after the
 * user installs or signs in to one. Sotto signs in to nothing itself.
 */
export function AgentsStep({ heading, onOpenLink }: AgentsStepProps): ReactNode {
  const agents = useOptionalAgents()
  const state = liveAgentState(agents?.state)
  const providers = state ? localProviders(state) : []
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [linkFailed, setLinkFailed] = useState<ProviderId | null>(null)
  const command = agents?.command
  const started = useRef(false)

  const check = useCallback(async (): Promise<void> => {
    if (!command) return
    setChecking(true)
    setFailure(null)
    try {
      const result = await command({ type: 'connect' })
      if (result === null) setFailure('Sotto could not check your coding agents. Nothing was changed. Press Check again.')
    } catch {
      setFailure('Sotto could not check your coding agents. Nothing was changed. Press Check again.')
    } finally {
      setChecking(false)
      setChecked(true)
    }
  }, [command])

  const anyConnected = providers.some(provider => provider.connection === 'connected')
  useEffect(() => {
    if (started.current || !state || anyConnected) return
    started.current = true
    void check()
  }, [state, anyConnected, check])

  const rows = SETUP_PROVIDERS.map(id => ({ id, row: rowFor(providers.find(provider => provider.id === id), checking, checked || anyConnected) }))
  const ready = rows.filter(({ row }) => row.kind === 'ready').length

  const openGuide = async (provider: ProviderId): Promise<void> => {
    setLinkFailed(null)
    if (!await onOpenLink(PROVIDER_INSTALL_GUIDES[provider])) setLinkFailed(provider)
  }

  return (
    <section aria-labelledby="onboarding-heading">
      {heading}
      {state === null && agents?.error ? <p className="onboarding-recovery" role="alert">{agents.error}</p> : null}
      <ul className="onboarding-agents" aria-label="Coding agents">
        {rows.map(({ id, row }) => (
          <li key={id} className="onboarding-agent" data-kind={row.kind}>
            <span className="onboarding-agent__mark" aria-hidden="true"><ProviderMark provider={id} name={providerLabel(id)} size={18} /></span>
            <span className="onboarding-agent__name">
              <strong>{providerLabel(id)}</strong>
              {row.detail ? <span>{row.detail}</span> : null}
              {linkFailed === id ? <span className="onboarding-agent__failure" role="alert">Your browser did not open. Go to {PROVIDER_INSTALL_GUIDES[id].replace(/^https:\/\//u, '')} to install it.</span> : null}
            </span>
            <span className="onboarding-agent__state">
              {row.kind === 'ready' ? <Check aria-hidden="true" size={14} /> : null}
              {row.kind === 'checking' ? <LoaderCircle aria-hidden="true" size={14} className="onboarding-spin" /> : null}
              {row.state}
            </span>
            {row.guide
              ? <Button variant="ghost" aria-label={`Open the ${providerLabel(id)} install guide`} onClick={() => void openGuide(id)}><ExternalLink aria-hidden="true" size={15} />Install guide</Button>
              : <span />}
          </li>
        ))}
      </ul>
      <div className="onboarding-agents__foot">
        <span role="status">{checking ? 'Checking this computer…' : `${ready} of ${rows.length} ready`}</span>
        <Button variant="secondary" disabled={checking || !command} onClick={() => void check()}>
          <RefreshCw aria-hidden="true" size={15} />
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {failure ? <p className="onboarding-recovery" role="alert">{failure}</p> : null}
      <p className="onboarding-aside">Threads need at least one agent. You can connect more later in Settings › Providers.</p>
    </section>
  )
}
