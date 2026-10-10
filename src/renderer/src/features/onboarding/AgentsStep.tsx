import { AlertCircle, Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { AgentProviderStatus, ProviderId } from '../../../../shared/agents'
import { PROVIDER_INSTALL_GUIDES } from '../../../../shared/hostProviders'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ProviderMark } from '../../agents/ProviderMark'
import { Button } from '../../components/Button'
import { shownVersion } from '../settings/HostProviders'
import { liveAgentState, localHostId, localProviderChoices, localProviders, providerLabel, SETUP_PROVIDERS } from './localAgents'

export interface AgentsStepProps {
  readonly heading: ReactNode
  readonly onOpenLink: (url: string) => Promise<boolean>
}

type RowKind = 'ready' | 'checking' | 'not-installed' | 'needs-you' | 'off' | 'unchecked'
interface Row { readonly kind: RowKind; readonly state: string; readonly detail: string; readonly guide: boolean }

const CHECK_FAILED = 'Sotto could not check your coding agents. Nothing was changed. Press Check again.'
const LOCAL_HOST_OFF = 'This computer’s local host is off, so Sotto can’t run agents here and checked nothing. Turn on Run the local host in Settings › Hosts, then restart Sotto.'
const SWITCH_FAILED = 'Sotto could not switch to this computer, so it checked nothing. Press Check again.'

/**
 * One provider's row. Only main's own answer says a client is missing: a connect that failed for want of it, or a
 * Connect providers that looked for it (`installed`) and did not find it. A client the user turned off says so, with
 * Connect; one Sotto has not looked for yet is Not connected, with Connect.
 */
function rowFor(status: AgentProviderStatus | undefined, working: boolean, installed: boolean | undefined, off: boolean): Row {
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
  if (status && installed === false) return { kind: 'not-installed', state: 'Not installed', detail: 'Not found on this computer.', guide: true }
  if (status && off) return { kind: 'off', state: 'Turned off', detail: 'You turned it off on this computer. Connect it to use it here.', guide: false }
  if (status) return { kind: 'off', state: 'Not connected', detail: 'Connect it to use it on this computer.', guide: false }
  return { kind: 'unchecked', state: 'Not checked yet', detail: '', guide: false }
}

/**
 * Setup's coding agents: which of Codex, Claude Code, Grok Build and Devin this computer can run, and what each one
 * needs. Arriving runs Connect providers, which turns on and connects every client installed here that the user has not
 * turned off. A client it did not find says Not installed, with its install guide; one turned off has Connect, as
 * Settings › Providers does. Check again retries the clients that reported a problem and runs Connect providers again,
 * which picks up a client installed since. Sotto signs in to nothing.
 */
export function AgentsStep({ heading, onOpenLink }: AgentsStepProps): ReactNode {
  const agents = useOptionalAgents()
  const state = liveAgentState(agents?.state)
  const providers = state ? localProviders(state) : []
  const [checking, setChecking] = useState(false)
  const [connecting, setConnecting] = useState<ReadonlySet<ProviderId>>(() => new Set())
  const [failure, setFailure] = useState<string | null>(null)
  const [hostProblem, setHostProblem] = useState<string | null>(null)
  // The host selected for new work before this step switched to this computer, given back when the step closes.
  const switchedFrom = useRef<string | null>(null)
  const [linkFailed, setLinkFailed] = useState<ProviderId | null>(null)
  const command = agents?.command
  const started = useRef(false)
  const providersRef = useRef(providers)
  providersRef.current = providers
  const stateRef = useRef(state)
  stateRef.current = state

  // Provider commands go to the host selected for new work; setup checks this computer, so it selects this one first,
  // as Add project selects the host it adds to. Reset settings can reopen setup with another host selected. Nothing is
  // sent unless this computer is then the one selected.
  const selectThisComputer = useCallback(async (): Promise<boolean> => {
    setHostProblem(null)
    const current = stateRef.current
    if (!current) return false
    if (!current.connections?.length) return true
    const local = localHostId(current)
    if (!local) { setHostProblem(LOCAL_HOST_OFF); return false }
    if (current.hostId === local) return true
    const previous = current.hostId ?? null
    await window.sotto?.hosts?.command({ type: 'select', hostId: local }).catch(() => undefined)
    const now = await window.sotto?.agents?.get?.().catch(() => null)
    if (now?.hostId !== local) { setHostProblem(SWITCH_FAILED); return false }
    if (switchedFrom.current === null && previous !== null) switchedFrom.current = previous
    return true
  }, [])

  useEffect(() => () => {
    const previous = switchedFrom.current
    if (previous !== null) void window.sotto?.hosts?.command({ type: 'select', hostId: previous }).catch(() => undefined)
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
    if (!await selectThisComputer()) { setChecking(false); return }
    const troubled = providersRef.current.filter(provider => provider.connection === 'error').map(provider => provider.id)
    await Promise.all(troubled.map(provider => run(() => command({ type: 'refresh', provider }))))
    await run(() => command({ type: 'connect', notice: false }))
    setChecking(false)
  }, [command, run, selectThisComputer])

  const connect = async (provider: ProviderId): Promise<void> => {
    if (!command) return
    setConnecting(current => new Set(current).add(provider))
    if (await selectThisComputer()) await run(() => command({ type: 'connect', provider, notice: false }))
    setConnecting(current => { const next = new Set(current); next.delete(provider); return next })
  }

  // Arriving connects whatever is installed, even when the default client is already connected.
  useEffect(() => {
    if (started.current || !state) return
    started.current = true
    void check()
  }, [state, check])

  const choices = state ? localProviderChoices(state) : null
  const rows = SETUP_PROVIDERS.map(id => {
    const status = providers.find(provider => provider.id === id)
    const working = connecting.has(id) || (checking && status?.connection !== 'connected' && status?.connection !== 'error')
    return { id, row: rowFor(status, working, choices?.installed?.includes(id), choices?.off.includes(id) === true) }
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
        <span role="status">{checking ? 'Connecting the agents on this computer…'
          : state && !hostProblem && providers.length === 0 ? 'Sotto has no word yet on this computer’s agents. Press Check again.'
          : ready === 0 ? 'None ready yet. Threads need at least one; Settings › Providers has them later too.'
          : `${ready} of ${rows.length} ready. Settings › Providers manages them later.`}</span>
        <Button variant="secondary" disabled={checking || !command} onClick={() => void check()}>
          <RefreshCw aria-hidden="true" size={15} />
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {failure ? <p className="onboarding-recovery" role="alert">{failure}</p> : null}
      {hostProblem ? <p className="onboarding-recovery" role="alert">{hostProblem}</p> : null}
    </section>
  )
}
