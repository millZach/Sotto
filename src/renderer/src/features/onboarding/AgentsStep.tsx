import { AlertCircle, Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { AgentProviderStatus, ProviderId } from '../../../../shared/agents'
import { PROVIDER_INSTALL_GUIDES } from '../../../../shared/hostProviders'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ProviderMark } from '../../agents/ProviderMark'
import { Button } from '../../components/Button'
import { shownVersion } from '../settings/HostProviders'
import { liveAgentState, localHostId, localProviders, providerLabel, SETUP_PROVIDERS } from './localAgents'

export interface AgentsStepProps {
  readonly heading: ReactNode
  readonly onOpenLink: (url: string) => Promise<boolean>
}

type RowKind = 'ready' | 'checking' | 'not-installed' | 'needs-you' | 'off' | 'unchecked'
interface Row { readonly kind: RowKind; readonly state: string; readonly detail: string; readonly guide: boolean }

const CHECK_FAILED = 'Sotto could not check your coding agents. Nothing was changed. Press Check again.'

/**
 * One provider's row. Only main's own answer says a client is missing: Connect providers tries the default client it
 * finds installed, not every one, so a client it has not tried is Not connected, with Connect.
 */
function rowFor(status: AgentProviderStatus | undefined, working: boolean): Row {
  const version = status?.version ? shownVersion(status.version) : ''
  if (status?.connection === 'connected') return { kind: 'ready', state: 'Ready', detail: [status.account, version].filter(Boolean).join(' · ') || 'Signed in', guide: false }
  if (status?.connection === 'connecting' || working) return { kind: 'checking', state: 'Checking…', detail: version, guide: false }
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
  if (status) return { kind: 'off', state: 'Not connected', detail: 'Connect it to use it on this computer.', guide: false }
  return { kind: 'unchecked', state: 'Not checked yet', detail: '', guide: false }
}

/**
 * Setup's coding agents: which of Codex, Claude Code, Grok Build and Devin this computer can run, and what each one
 * needs. Arriving runs Connect providers, which connects the default client found installed; each other client has
 * Connect, as Settings › Providers does, and says Not installed only once main has found it missing. Check again
 * retries the clients that reported a problem after the user installs or signs in to one. Sotto signs in to nothing.
 */
export function AgentsStep({ heading, onOpenLink }: AgentsStepProps): ReactNode {
  const agents = useOptionalAgents()
  const state = liveAgentState(agents?.state)
  const providers = state ? localProviders(state) : []
  const [checking, setChecking] = useState(false)
  const [connecting, setConnecting] = useState<ReadonlySet<ProviderId>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const [linkFailed, setLinkFailed] = useState<ProviderId | null>(null)
  const command = agents?.command
  const started = useRef(false)
  const providersRef = useRef(providers)
  providersRef.current = providers
  const stateRef = useRef(state)
  stateRef.current = state

  // Provider commands go to the host selected for new work; setup checks this computer, so it selects this one first,
  // as Add project selects the host it adds to. Reset settings can reopen setup with another host selected.
  const selectThisComputer = useCallback(async (): Promise<void> => {
    const current = stateRef.current
    const local = current ? localHostId(current) : undefined
    if (!current?.connections?.length || !local || current.hostId === local) return
    await window.sotto?.hosts?.command({ type: 'select', hostId: local }).catch(() => undefined)
  }, [])

  const run = useCallback(async (send: () => Promise<unknown>): Promise<void> => {
    setFailure(null)
    try {
      if (await send() === null) setFailure(CHECK_FAILED)
    } catch {
      setFailure(CHECK_FAILED)
    }
  }, [])

  const check = useCallback(async (): Promise<void> => {
    if (!command) return
    setChecking(true)
    await selectThisComputer()
    const current = providersRef.current
    const troubled = current.filter(provider => provider.connection === 'error').map(provider => provider.id)
    await Promise.all(troubled.map(provider => run(() => command({ type: 'refresh', provider }))))
    if (!current.some(provider => provider.connection === 'connected')) await run(() => command({ type: 'connect' }))
    setChecking(false)
  }, [command, run, selectThisComputer])

  const connect = async (provider: ProviderId): Promise<void> => {
    if (!command) return
    setConnecting(current => new Set(current).add(provider))
    await selectThisComputer()
    await run(() => command({ type: 'connect', provider }))
    setConnecting(current => { const next = new Set(current); next.delete(provider); return next })
  }

  const anyConnected = providers.some(provider => provider.connection === 'connected')
  useEffect(() => {
    if (started.current || !state || anyConnected) return
    started.current = true
    void check()
  }, [state, anyConnected, check])

  const rows = SETUP_PROVIDERS.map(id => {
    const status = providers.find(provider => provider.id === id)
    const working = connecting.has(id) || (checking && status?.connection !== 'connected' && status?.connection !== 'error')
    return { id, row: rowFor(status, working) }
  })
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
              {row.kind === 'needs-you' ? <AlertCircle aria-hidden="true" size={14} /> : null}
              {row.state}
            </span>
            {row.guide ? <Button variant="ghost" aria-label={`Open the ${providerLabel(id)} install guide`} onClick={() => void openGuide(id)}><ExternalLink aria-hidden="true" size={15} />Install guide</Button> : null}
            {row.kind === 'off' ? <Button variant="secondary" aria-label={`Connect ${providerLabel(id)}`} disabled={!command} onClick={() => void connect(id)}>Connect</Button> : null}
            {!row.guide && row.kind !== 'off' ? <span /> : null}
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
      {state && !checking && providers.length === 0
        ? <p className="onboarding-recovery" role="status">Sotto has no word yet on this computer's agents. Press Check again, or connect them later in Settings › Providers.</p>
        : null}
      <p className="onboarding-aside">Threads need at least one agent. You can connect more later in Settings › Providers.</p>
    </section>
  )
}
