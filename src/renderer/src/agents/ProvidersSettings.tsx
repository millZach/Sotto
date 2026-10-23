import React, { useId, useRef, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { defaultThreadModelId, enabledThreadProviders, PROVIDER_LABELS, providerIdSchema, type ProviderClientUpdate, type ProviderId } from '../../../shared/agents'
import { catalogEntry } from '../../../shared/modelCatalog'
import { Button } from '../components/Button'
import { Toggle } from '../components/Toggle'
import { useOptionalAgents } from './AgentContext'
import { useHeldProviders } from '../state/owlFeature'
import { newestModelsFirst } from './ModelPicker'
import { ProviderMark } from './ProviderMark'
import { OpenCodeModelSources } from './OpenCodeModelSources'
import { useTransientFlag, writeClipboard } from './richActions'
import { localHostId, localProviders } from '../features/onboarding/localAgents'
import { PROVIDER_INSTALL_GUIDES } from '../../../shared/hostProviders'
import './providers.css'

const CLIENT_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin CLI', muse: 'Muse', opencode: 'OpenCode' }

/** What Sotto knows about the installed client, in one sentence, whichever way the check went. */
function clientLine(update: ProviderClientUpdate | undefined, verified: string | undefined, checking: boolean, connected = false, checkingNow = false): string {
  if (checking && !checkingNow && update?.state === 'updating') {
    const published = update.published
    return published ? t({ message: `Updating to ${published}…`, comment: '{published} is a version number.' }) : t`Updating to the published version…`
  }
  const line = clientState(update, checking, connected, checkingNow)
  return verified ? t({ message: `${line} It is newer than the ${verified} Sotto has checked.`, comment: '{line} is a sentence about the installed client; {verified} is a version number.' }) : line
}

/** The sentence `clientLine` starts with, before what Sotto has checked. */
function clientState(update: ProviderClientUpdate | undefined, checking: boolean, connected: boolean, checkingNow: boolean): string {
  if (!checking) return t`Client update checks are off, so Sotto does not know what is published.`
  if (checkingNow) return t`Checking the published version…`
  if (!update) return connected ? t`Sotto has not read this client's version yet. Check again to read it.`
    : t`Connect this provider to read its installed version.`
  const { installed, published, error, command } = update
  if (update.state === 'queued') return published ? t({ message: `Waiting to update to ${published}. Your threads keep working.`, comment: '{published} is a version number.' }) : t`Waiting to update to the published version. Your threads keep working.`
  if (update.state === 'failed') return error
    ? t({ message: `${installed} is installed. The last update did not finish: ${error}`, comment: '{installed} is a version number; {error} is the reason the update gave.' })
    : t({ message: `${installed} is installed. The last update did not finish.`, comment: '{installed} is a version number.' })
  if (update.state === 'unchanged') {
    if (error) return error
    return command
      ? t({ message: `The update ran, but this client still reports ${installed}. Try again, or run ${command} yourself to see what it says.`, comment: '{installed} is a version number; {command} is a terminal command.' })
      : t({ message: `The update ran, but this client still reports ${installed}. Try again.`, comment: '{installed} is a version number.' })
  }
  if (update.channel === 'devin-app') return t({ message: `${installed} is installed. Devin updates with the Devin app.`, comment: '{installed} is a version number.' })
  if (!published) return t({ message: `${installed} is installed. Sotto could not read the published version. Check again to try.`, comment: '{installed} is a version number.' })
  if (update.id === 'muse' && !update.behind && installed !== published) return t({ message: `${installed} is installed; ${published} is published.`, comment: '{installed} and {published} are version numbers.' })
  if (!update.behind) return t({ message: `${installed} is installed, and that is what is published.`, comment: '{installed} is a version number.' })
  if (!update.canInstall) return command
    ? t({ message: `${installed} is installed; ${published} is published. Sotto cannot update this copy. Update it with ${command}.`, comment: '{installed} and {published} are version numbers; {command} is a terminal command.' })
    : t({ message: `${installed} is installed; ${published} is published. Sotto cannot update this copy. Update it with the installer you used.`, comment: '{installed} and {published} are version numbers.' })
  // Updating never stops a working thread, so there is nothing to warn about here (ADR-0042).
  return t({ message: `${installed} is installed; ${published} is published. Your threads keep working while it installs.`, comment: '{installed} and {published} are version numbers.' })
}

export function ProvidersSettings(): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const held = useHeldProviders()
  const [selected, setSelected] = useState<ProviderId>('codex')
  const [tab, setTab] = useState<'configuration' | 'models'>('configuration')
  const [pending, setPending] = useState<Partial<Record<ProviderId, 'connect' | 'disconnect' | 'refresh'>>>({})
  const [errors, setErrors] = useState<Partial<Record<ProviderId, string | undefined>>>({})
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updatePending, setUpdatePending] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [copyingLogin, setCopyingLogin] = useState(false)
  const [loginFeedback, showLoginFeedback] = useTransientFlag()
  const inFlight = useRef(new Set<ProviderId>())
  const checkInFlight = useRef(false)
  const sandboxActions = useRef<HTMLDivElement>(null)
  const tabId = useId()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p className="tt-paragraph" role="status">{t`Loading providers…`}</p>
  // This page is this computer's clients, whichever host is selected for new work: it reads this computer's entry and
  // names this computer on every command, so a Retry never reaches another host's client. Without host connections
  // (no router joining hosts), the state is this computer's alone.
  const hasHostConnections = Boolean(state.connections?.length)
  const localHost = localHostId(state)
  const local = hasHostConnections ? state.host.clientHosts?.find(host => host.hostId === localHost) : undefined
  const here = hasHostConnections && localHost ? { hostId: localHost } : {}
  // With this computer's host off there are no clients here to show, and nothing on this page may reach another host's.
  if (hasHostConnections && !local) return <p role="status" className="provider-models__empty">{t`This computer’s local host is off, so Sotto can’t run agents here. Turn on Run the local host in Settings › Hosts & phones, then restart Sotto. A host’s own providers are on its tiles there.`}</p>
  const providers = localProviders(state)
  const hostModels = hasHostConnections ? local?.models ?? [] : state.host.models
  const clientUpdates = hasHostConnections ? local?.clientUpdates : state.clientUpdates
  const checkClientUpdates = local?.checkClientUpdates ?? state.configuration.checkClientUpdates
  const museDisableSandbox = local?.museDisableSandbox ?? state.configuration.museDisableSandbox
  const enabled = local?.enabledProviders ?? enabledThreadProviders(state.configuration)
  const statusFor = (id: ProviderId) => providers.find(provider => provider.id === id)
    ?? { connection: !hasHostConnections && id === state.configuration.provider ? state.connection : 'disconnected', version: '', error: undefined, verifiedVersion: undefined, sandboxDisabled: undefined }
  const status = statusFor(selected)
  const connected = status.connection === 'connected'
  const working = pending[selected] || status.connection === 'connecting'
  const models = newestModelsFirst(hostModels.filter(model => model.providerId === selected
    || (!model.providerId && model.provider === PROVIDER_LABELS[selected])))
  const label = PROVIDER_LABELS[selected]
  const clientName = CLIENT_NAMES[selected]
  const detailError = errors[selected] ?? status.error
  const update = clientUpdates?.find(item => item.id === selected)
  const updating = (clientUpdates ?? []).some(item => item.state === 'updating' || item.state === 'queued') || Object.values(updatePending).some(Boolean)
  const selectedUpdating = Boolean(updatePending[selected]) || update?.state === 'updating' || update?.state === 'queued'
  const check = async (): Promise<void> => {
    if (checkInFlight.current) return
    const provider = selected
    checkInFlight.current = true
    setCheckingUpdates(true)
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      // A provider that needs attention is asked again too: after signing in, Check again is the press that should see it.
      if (statusFor(provider).connection === 'error' && !inFlight.current.has(provider)) await perform(provider, 'refresh')
      const result = await command({ type: 'check-client-updates', ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? t`Could not check for client updates. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, [provider]: t`Could not check for client updates. Try again.` })) }
    finally { checkInFlight.current = false; setCheckingUpdates(false) }
  }
  const runUpdate = async (provider: ProviderId): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setUpdatePending(previous => ({ ...previous, [provider]: true }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    const providerName = PROVIDER_LABELS[provider]
    const failed = t({ message: `Could not update ${providerName}. Try again.`, comment: '{providerName} is a provider\'s name.' })
    try {
      const result = await command({ type: 'update-client', provider, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, [provider]: failed })) }
    finally { inFlight.current.delete(provider); setUpdatePending(previous => ({ ...previous, [provider]: undefined })) }
  }
  // OpenCode missing, or refused for its version (OpenCode 1 among them), gets its install guide whether or not update
  // checks are on, as first-run setup offers it. A copy too old to use is most likely in ~/.opencode/bin, where both
  // generations' install scripts put it and Sotto looks first, so only OpenCode 2's script replaces it.
  const problem = 'problem' in status ? status.problem : undefined
  const requiredVersion = 'requiredVersion' in status && status.requiredVersion ? status.requiredVersion : '2.0.31'
  const openCodeInstall = selected !== 'opencode' || connected ? undefined
    : problem === 'not-installed' ? t`OpenCode 2 is not installed on this computer. Install it with its install script or npm’s @opencode/cli, then connect again.`
    : problem === 'too-old' ? t({ message: `Sotto works with OpenCode ${requiredVersion} or newer. Install OpenCode 2 with its install script, which replaces an older copy in ~/.opencode/bin, where Sotto looks first, then connect again. npm’s @opencode/cli installs a second copy and leaves that one.`, comment: '{requiredVersion} is a version number.' })
    : undefined
  // OpenCode 2's own guide; opencode.ai/docs installs OpenCode 1, which Sotto does not drive.
  const openOpenCodeGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, opencode: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.(PROVIDER_INSTALL_GUIDES.opencode)
      if (!result?.ok) setErrors(previous => ({ ...previous, opencode: t`The OpenCode guide could not be opened. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, opencode: t`The OpenCode guide could not be opened. Try again.` })) }
  }
  const copyMuseLogin = async (): Promise<void> => {
    setCopyingLogin(true)
    setErrors(previous => ({ ...previous, muse: undefined }))
    try { await writeClipboard('muse login'); showLoginFeedback(t`Copied`) }
    catch { setErrors(previous => ({ ...previous, muse: t`The command could not be copied. Select muse login and copy it yourself.` })) }
    finally { setCopyingLogin(false) }
  }
  const openMuseGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, muse: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.('https://dev.meta.ai/docs/muse-code')
      if (!result?.ok) setErrors(previous => ({ ...previous, muse: t`The Muse guide could not be opened. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, muse: t`The Muse guide could not be opened. Try again.` })) }
  }
  const perform = async (provider: ProviderId, type: 'connect' | 'disconnect' | 'refresh'): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setPending(previous => ({ ...previous, [provider]: type }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      const result = await command({ type, provider, ...here, ...(type === 'connect' ? { notice: false as const } : {}) })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? t`Could not update this provider. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, [provider]: t`Could not update this provider. Try again.` })) }
    finally { inFlight.current.delete(provider); setPending(previous => ({ ...previous, [provider]: undefined })) }
  }
  // Muse's shell sandbox is set when each of its hosts starts, so this computer's saved switch and its running hosts
  // can disagree until Muse reconnects; the page says so instead of implying the change is live.
  const museSandboxOwed = selected === 'muse' && connected && status.sandboxDisabled !== undefined && status.sandboxDisabled !== museDisableSandbox
  // Reconnect leaves the row once Muse disconnects, so focus that went with it lands on the switch beside it.
  const reconnectMuse = async (): Promise<void> => {
    await perform('muse', 'disconnect'); await perform('muse', 'connect')
    if (!document.activeElement || document.activeElement === document.body) sandboxActions.current?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }
  const saveMuseSandbox = async (disable: boolean): Promise<void> => {
    setErrors(previous => ({ ...previous, muse: undefined }))
    const failed = t`The shell sandbox setting was not saved, so Muse keeps the one it had. Try again.`
    try {
      const result = await command({ type: 'configure', patch: { museDisableSandbox: disable }, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, muse: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, muse: failed })) }
  }
  // The selected host's agent setting is not this computer's, so a joined window reads this computer's from its entry.
  const inheritedModelId = local ? local.agentModelId ?? '' : defaultThreadModelId(state.configuration, hostModels, state.reasoningAccounts)
  // A long-context variant the catalog does not list (`opus[1m]`) is its base model's entry here.
  const inheritedEntryId = catalogEntry(models, inheritedModelId)?.id
  return <div className="providers-settings">
    <div className="providers-workspace">
      <nav className="providers-list" aria-label={t`Thread providers`}>{providerIdSchema.options.filter(provider => !held.has(provider)).map(provider => {
        const current = statusFor(provider)
        const active = enabled.includes(provider)
        const connecting = current.connection === 'connecting' || pending[provider]
        const providerName = PROVIDER_LABELS[provider]
        const statusLabel = pending[provider] === 'disconnect' ? t`Disconnecting…` : pending[provider] === 'refresh' ? t`Refreshing…` : connecting ? t`Connecting…`
          : current.connection === 'connected' ? t({ message: 'Connected', comment: 'A provider\'s status.' }) : current.connection === 'error' ? t({ message: 'Needs attention', comment: 'A provider\'s status.' })
            : active ? t({ message: 'Not connected', comment: 'A provider\'s status.' }) : t({ message: 'Disabled', comment: 'A provider\'s status: the user turned it off.' })
        return <div key={provider} className="providers-list__row" data-selected={provider === selected}>
          <button type="button" className="providers-list__select" aria-label={PROVIDER_LABELS[provider]} aria-pressed={provider === selected}
            onClick={() => setSelected(provider)}><ProviderMark provider={provider} name={PROVIDER_LABELS[provider]} size={21} /><span><strong>{PROVIDER_LABELS[provider]}</strong>
              <small data-status={current.connection}><i aria-hidden="true" />{statusLabel}</small></span></button>
          <Toggle label={t({ message: `Enable ${providerName}`, comment: '{providerName} is a provider\'s name.' })} checked={active} disabled={Boolean(connecting) || Boolean(updatePending[provider]) || Boolean(clientUpdates?.some(item => item.id === provider && (item.state === 'updating' || item.state === 'queued')))} onCheckedChange={value => void perform(provider, value ? 'connect' : 'disconnect')} />
        </div>
      })}</nav>
      <section className="provider-detail" aria-label={t`Provider configuration`}>
        <header className="provider-detail__header"><ProviderMark provider={selected} name={label} size={21} /><h3>{label}</h3>{status.version && <span className="provider-detail__version">{status.version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? status.version.slice(0, 36)}</span>}
          {connected && <Button variant="ghost" iconOnly aria-label={t({ message: `Refresh ${label}`, comment: '{label} is a provider\'s name.' })} disabled={Boolean(working) || selectedUpdating} onClick={() => void perform(selected, 'refresh')}><RefreshCw size={15} /></Button>}
        </header>
        <div className="provider-tabs" role="tablist" aria-label={t`Provider details`}>{(['configuration', 'models'] as const).map(value => <button type="button" key={value} id={`${tabId}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${tabId}-panel`}
          tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = value === 'configuration' ? 'models' : 'configuration'; setTab(next); document.getElementById(`${tabId}-${next}`)?.focus() } }}>{value === 'configuration' ? t({ message: 'Configuration', comment: 'A tab on a provider\'s page.' }) : t({ message: 'Models', comment: 'A tab on a provider\'s page.' })}</button>)}</div>
        <div key={`${selected}-${tab}`} id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} className="provider-detail__body">
          {tab === 'configuration' ? <>
            <div className="provider-connection"><div><h4>{t`Local connection`}</h4><p className="tt-paragraph">{selected === 'devin' ? t`Install Devin CLI and run devin auth login before connecting.` : selected === 'muse' ? t`Uses your Muse sign-in on this computer. Run muse login in a terminal before connecting.` : selected === 'opencode' ? t`Sotto runs its own OpenCode, with its own folder and its own sign-ins. The OpenCode you run yourself stays as it is.` : t({ message: `Uses your ${clientName} sign-in on this computer.`, comment: '{clientName} is a provider\'s client, such as Claude Code.' })}</p>
              {selected === 'muse' && <div className="provider-login"><code>muse login</code><Button variant="ghost" disabled={copyingLogin} aria-label={t`Copy Muse login command`} onClick={() => void copyMuseLogin()}>{loginFeedback ?? t`Copy`}</Button><Button variant="ghost" onClick={() => void openMuseGuide()}>{t`Sign-in steps`}</Button><span className="tt-visually-hidden" role="status">{loginFeedback ? t`Muse login command copied.` : ''}</span></div>}
            </div>
              <Button variant={connected ? 'secondary' : 'primary'} disabled={Boolean(working) || selectedUpdating} aria-label={connected ? t({ message: `Disconnect ${label}`, comment: '{label} is a provider\'s name.' }) : status.connection === 'error' ? t({ message: `Retry ${label}`, comment: '{label} is a provider\'s name; the button connects it again.' }) : t({ message: `Connect ${label}`, comment: '{label} is a provider\'s name.' })}
                onClick={() => void perform(selected, connected ? 'disconnect' : 'connect')}>{working ? pending[selected] === 'disconnect' ? t`Disconnecting…` : pending[selected] === 'refresh' ? t`Refreshing…` : t`Connecting…` : connected ? t`Disconnect` : status.connection === 'error' ? t`Retry connection` : t`Connect`}</Button>
            </div>
            {selected === 'opencode' && connected && window.sotto?.opencode ? <OpenCodeModelSources bridge={window.sotto.opencode} /> : null}
            <div className="provider-client" aria-busy={checkingUpdates || selectedUpdating}>
              <div>
                <h4>{t`Installed client`}</h4>
                <p className="tt-paragraph" role="status">{updatePending[selected] && update?.state !== 'updating' && update?.state !== 'queued' ? t`Starting the update…` : clientLine(update, status.verifiedVersion, checkClientUpdates, connected, checkingUpdates)}</p>
              </div>
              <div className="provider-client__actions">
                {checkClientUpdates && update?.canInstall && update.state !== 'updating' && update.state !== 'queued'
                  ? <Button variant="primary" aria-label={selected === 'muse' ? update.state === 'failed' ? t`Try updating Muse again` : t`Update Muse` : undefined} disabled={Boolean(working) || updating || checkingUpdates} onClick={() => void runUpdate(selected)}>
                    {update.state === 'failed' ? t`Try again` : t({ message: 'Update', comment: 'A button that installs the published version of a provider\'s client.' })}</Button>
                  : null}
                <Button variant="secondary" disabled={updating || checkingUpdates || !checkClientUpdates} onClick={() => void check()}>{checkingUpdates ? t`Checking…` : t`Check again`}</Button>
              </div>
            </div>
            {selected === 'muse' && checkClientUpdates && update && ((update.behind && !update.canInstall) || update.state === 'failed' || update.state === 'unchanged') && <details className="provider-client__steps"><summary>{t`Installation steps`}</summary><p className="tt-paragraph">{update.channel === 'unknown' || !update.byHand?.length ? t`Update Muse with the installer or package manager you used. Then check again.` : t`Run these commands in a terminal on this computer, then check again.`}</p>{update.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openMuseGuide()}>{t`Open Muse installation guide`}</Button></details>}
            {selected === 'muse' && <div className="provider-client">
              <div>
                <h4>{t`Shell sandbox`}</h4>
                <p>{museDisableSandbox
                  ? t`Muse's shell commands and file tools run as you on this computer, with no sandbox: they can reach files outside the project and the network. Only turn this off where Muse's sandbox cannot be set up. A thread on Ask for approval still asks.`
                  : t`Muse's shell commands and file tools run inside its sandbox on this computer.`}</p>
                {museSandboxOwed && <p className="provider-client__owed" role="status">{status.sandboxDisabled
                  ? t`Muse is still running with its sandbox off. Reconnect Muse to apply the change. Reconnecting stops any Muse reply that is under way.`
                  : t`Muse is still running with its sandbox on. Reconnect Muse to apply the change. Reconnecting stops any Muse reply that is under way.`}</p>}
              </div>
              <div className="provider-client__actions" ref={sandboxActions}>
                {museSandboxOwed && <Button variant="primary" disabled={Boolean(working) || selectedUpdating} aria-label={t`Reconnect Muse to apply the shell sandbox setting`} onClick={() => void reconnectMuse()}>{t`Reconnect`}</Button>}
                <Toggle label={t`Shell sandbox`} checked={!museDisableSandbox}
                  onCheckedChange={value => void saveMuseSandbox(!value)} />
              </div>
            </div>}
            {selected === 'opencode' && (openCodeInstall || checkClientUpdates && update && ((update.behind && !update.canInstall) || update.state === 'failed' || update.state === 'unchanged')) && <details className="provider-client__steps"><summary>{t`Installation steps`}</summary><p className="tt-paragraph">{openCodeInstall ?? (!update?.byHand?.length ? t`Update OpenCode 2 with the installer or package manager you used. Then check again.` : t`Run these commands in a terminal on this computer, then check again.`)}</p>{openCodeInstall ? null : update?.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openOpenCodeGuide()}>{t`Open OpenCode installation guide`}</Button></details>}
            {selected === 'devin' && <p className="provider-models__empty tt-paragraph">{t`Uses your Devin account and credits. Devin keeps its own history and analytics, outside Sotto's control.`}</p>}
            <p className="provider-models__empty tt-paragraph">{t`Choose what new threads start with under Agents.`}</p>
            {selected === 'muse' && <details className="provider-support"><summary>{t`Threads with Muse`}</summary><p className="tt-paragraph">{t`Replies, images, steering, approvals, questions and reasoning effort. Change models and permissions in a thread.`}</p><p className="tt-paragraph">{t`On Muse 1.4.7 or newer, Muse threads get Sotto's browser, visual, pull request babysitting and delegation tools, and Watcher runs on Muse. Skills are unavailable. Muse does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.`}</p></details>}
            {selected === 'opencode' && <details className="provider-support"><summary>{t`Threads with OpenCode`}</summary><p className="tt-paragraph">{t`Replies, images, steering, approvals, questions and reasoning effort, on each model's own source. Change models and permissions in a thread.`}</p><p className="tt-paragraph">{t`Sotto's browser tools, Watcher and skills are unavailable. OpenCode does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.`}</p></details>}
          </> : models.length ? <ul className="provider-models" aria-label={t({ message: `${label} available models`, comment: '{label} is a provider\'s name.' })}>{models.map(model => <li key={model.id}><span><strong>{model.name}</strong>{model.reasoningEfforts?.length ? <small>{model.reasoningEfforts.join(' · ')}</small> : null}</span><small>{model.ready ? model.id === inheritedEntryId ? t`Agent setting` : t({ message: 'Available', comment: 'Beside a model that can be chosen.' }) : t({ message: 'Unavailable', comment: 'Beside a model that cannot be chosen now.' })}</small></li>)}</ul> : <p className="provider-models__empty tt-paragraph">{connected ? t`No models were returned. Refresh this provider to check again.` : t({ message: `Connect ${label} to load its models.`, comment: '{label} is a provider\'s name.' })}</p>}
          {detailError && <p role="alert" className="provider-detail__error">{detailError}</p>}
        </div>
      </section>
    </div>
    <div className="providers-updates">
      <div>
        <h4>{t`Check for client updates`}</h4>
        <p className="tt-paragraph">{!held.has('muse') ? t`Checks each client's published version when it connects and every five minutes. Muse uses its own release feed; the other clients use the npm registry. No thread text is sent. Off, Sotto does not check versions or offer updates.` : t`Asks the npm registry for each client’s latest version when it connects and every five minutes. Only the package name is sent.`}</p>
      </div>
      <Toggle label={t`Check for client updates`} checked={checkClientUpdates}
        onCheckedChange={value => void command({ type: 'configure', patch: { checkClientUpdates: value }, ...here })} />
    </div>
  </div>
}
