import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, CircleArrowUp, RefreshCw } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { defaultThreadModelId, enabledThreadProviders, PROVIDER_LABELS, providerIdSchema, type ProviderClientUpdate, type ProviderId } from '../../../shared/agents'
import { catalogEntry } from '../../../shared/modelCatalog'
import { Button } from '../components/Button'
import { Toggle } from '../components/Toggle'
import { useOptionalAgents } from './AgentContext'
import { useHeldProviders } from '../state/owlFeature'
import { modelSources, newestModelsFirst } from './ModelPicker'
import { ProviderMark } from './ProviderMark'
import { OpenCodeModelSources } from './OpenCodeModelSources'
import { CursorConnection, useCursorSignIn } from './CursorConnection'
import { OwnModelServers, useOwnServersBridge } from './OwnModelServers'
import { useTransientFlag, writeClipboard } from './richActions'
import { localHostId, localProviders } from '../features/onboarding/localAgents'
import { PROVIDER_INSTALL_GUIDES } from '../../../shared/hostProviders'
import { COMPACT_IDLE_SETTING, onProviderAimed, takeAimedProvider } from '../features/settings/settingsTarget'
import { shownWords, type LaterWords } from '../features/settings/laterWords'
import './providers.css'

const CLIENT_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin CLI', muse: 'Muse', opencode: 'OpenCode', cursor: 'Cursor', deepseek: 'DeepSeek Harness' }

/**
 * What the update switch says it checks, by where each client's published version is read: Muse's own release feed and
 * Cursor's install script, where each is not held, and the npm registry for the rest. Each case is one whole message.
 */
function updateChecks(held: ReadonlySet<ProviderId>): string {
  const muse = !held.has('muse'), cursor = !held.has('cursor')
  if (muse && cursor) return i18n._(msg`Checks each client's published version when it connects and every five minutes. Muse uses its own release feed and Cursor its install script; the other clients use the npm registry. No thread text is sent. Off, Sotto does not check versions or offer updates.`)
  if (muse) return i18n._(msg`Checks each client's published version when it connects and every five minutes. Muse uses its own release feed; the other clients use the npm registry. No thread text is sent. Off, Sotto does not check versions or offer updates.`)
  if (cursor) return i18n._(msg`Checks each client's published version when it connects and every five minutes. Cursor uses its install script; the other clients use the npm registry. No thread text is sent. Off, Sotto does not check versions or offer updates.`)
  return 'Asks the npm registry for each client’s latest version when it connects and every five minutes. Only the package name is sent.'
}
/** What the Providers page says when Cursor's install guide does not open. */
const CURSOR_GUIDE_FAILED = msg`Cursor’s install guide could not be opened. Try again.`

/** What Sotto knows about the installed client, in one sentence, whichever way the check went. */
function clientLine(update: ProviderClientUpdate | undefined, verified: string | undefined, checking: boolean, connected = false, checkingNow = false): string {
  const past = verified ? ` It is newer than the ${verified} Sotto has checked.` : ''
  if (!checking) return `Client update checks are off, so Sotto does not know what is published.${past}`
  if (checkingNow) return `Checking the published version…${past}`
  if (!update) return connected ? `Sotto has not read this client's version yet. Check again to read it.${past}`
    : `Connect this provider to read its installed version.${past}`
  if (update.state === 'updating') return `Updating to ${update.published ?? 'the published version'}…`
  if (update.state === 'queued') return `Waiting to update to ${update.published ?? 'the published version'}. Your threads keep working.${past}`
  if (update.state === 'failed' && update.failure === 'not-listed') {
    const to = update.published ?? i18n._(msg`the published version`), installed = update.installed
    return `${i18n._(msg`${installed} is installed. mise does not list ${to} yet, even with its cache cleared, so Sotto did not install it. Try again later.`)}${past}`
  }
  if (update.state === 'failed') return `${update.installed} is installed. The last update did not finish${update.error ? `: ${update.error}` : '.'}${past}`
  if (update.state === 'unchanged') return update.error ? `${update.error}${past}` : `The update ran, but this client still reports ${update.installed}. Try again${update.command ? `, or run ${update.command} yourself to see what it says` : ''}.${past}`
  if (update.channel === 'devin-app') return `${update.installed} is installed. Devin updates with the Devin app.${past}`
  if (!update.published) return `${update.installed} is installed. Sotto could not read the published version. Check again to try.${past}`
  if (update.id === 'muse' && !update.behind && update.installed !== update.published) return `${update.installed} is installed; ${update.published} is published.${past}`
  if (!update.behind) return `${update.installed} is installed, and that is what is published.${past}`
  if (!update.canInstall) return `${update.installed} is installed; ${update.published} is published. Sotto cannot update this copy. Update it with ${update.command ?? 'the installer you used'}.${past}`
  // Updating never stops a working thread, so there is nothing to warn about here (ADR-0042).
  return `${update.installed} is installed; ${update.published} is published. Your threads keep working while it installs.${past}`
}

/** The version a client reports, cut to its number where it says more than that. */
function shortVersion(version: string): string {
  return version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? version.slice(0, 36)
}

/**
 * Settings → Providers: one list with a row per provider, each opening in place to its connection, client and models
 * (Zach's pick, variant A of the tag prototype/providers-settings). One row is open at a time; Codex's is open to begin
 * with, as Codex was the provider shown first before, and pressing an open row's header closes it.
 */
/** Idle compaction's switch (ADR-0127): a setting of this computer's rather than the provider's, shown in Claude Code's row. */
export interface CompactIdleSetting {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}

export function ProvidersSettings({ compactIdle }: { readonly compactIdle?: CompactIdleSetting } = {}): ReactNode {
  const agents = useOptionalAgents()
  const held = useHeldProviders()
  const ownServers = useOwnServersBridge()
  const { t } = useLingui()
  // A link elsewhere, such as a thread's Turn off, or Find a setting, can open the row that holds one provider's setting.
  const [open, setOpen] = useState<ProviderId | null>(() => takeAimedProvider() ?? 'codex')
  useEffect(() => onProviderAimed(setOpen), [])
  const [pending, setPending] = useState<Partial<Record<ProviderId, 'connect' | 'disconnect' | 'refresh'>>>({})
  const [errors, setErrors] = useState<Partial<Record<ProviderId, LaterWords | undefined>>>({})
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updatePending, setUpdatePending] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [copyingLogin, setCopyingLogin] = useState(false)
  const [loginFeedback, showLoginFeedback] = useTransientFlag()
  /** Cursor's sign-in from its row (ADR-0128), kept while its row is closed or another row is open. */
  const cursorSignIn = useCursorSignIn(window.sotto?.cursor)
  const inFlight = useRef(new Set<ProviderId>())
  const checkInFlight = useRef(false)
  const sandboxActions = useRef<HTMLDivElement>(null)
  const rowId = useId()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p role="status">Loading providers…</p>
  // This page is this computer's clients, whichever host is selected for new work: it reads this computer's entry and
  // names this computer on every command, so a Retry never reaches another host's client. Without host connections
  // (no router joining hosts), the state is this computer's alone.
  const hasHostConnections = Boolean(state.connections?.length)
  const localHost = localHostId(state)
  const local = hasHostConnections ? state.host.clientHosts?.find(host => host.hostId === localHost) : undefined
  const here = hasHostConnections && localHost ? { hostId: localHost } : {}
  // With this computer's host off there are no clients here to show, and nothing on this page may reach another host's.
  if (hasHostConnections && !local) return <p role="status" className="provider-models__empty">This computer’s local host is off, so Sotto can’t run agents here. Turn on Run the local host in Settings › Hosts & phones, then restart Sotto. A host’s own providers are on its tiles there.</p>
  const providers = localProviders(state)
  const hostModels = hasHostConnections ? local?.models ?? [] : state.host.models
  const clientUpdates = hasHostConnections ? local?.clientUpdates : state.clientUpdates
  const checkClientUpdates = local?.checkClientUpdates ?? state.configuration.checkClientUpdates
  const museDisableSandbox = local?.museDisableSandbox ?? state.configuration.museDisableSandbox
  const enabled = local?.enabledProviders ?? enabledThreadProviders(state.configuration)
  const statusFor = (id: ProviderId) => providers.find(provider => provider.id === id)
    ?? { connection: !hasHostConnections && id === state.configuration.provider ? state.connection : 'disconnected', version: '', error: undefined, verifiedVersion: undefined, sandboxDisabled: undefined }
  const updateFor = (id: ProviderId) => clientUpdates?.find(item => item.id === id)
  const updating = (clientUpdates ?? []).some(item => item.state === 'updating' || item.state === 'queued') || Object.values(updatePending).some(Boolean)
  const updatingNow = (id: ProviderId): boolean => {
    const update = updateFor(id)
    return Boolean(updatePending[id]) || update?.state === 'updating' || update?.state === 'queued'
  }
  const check = async (provider: ProviderId): Promise<void> => {
    if (checkInFlight.current) return
    checkInFlight.current = true
    setCheckingUpdates(true)
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      // A provider that needs attention is asked again too: after signing in, Check again is the press that should see it.
      if (statusFor(provider).connection === 'error' && !inFlight.current.has(provider)) await perform(provider, 'refresh')
      const result = await command({ type: 'check-client-updates', ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? 'Could not check for client updates. Try again.' }))
    } catch { setErrors(previous => ({ ...previous, [provider]: 'Could not check for client updates. Try again.' })) }
    finally { checkInFlight.current = false; setCheckingUpdates(false) }
  }
  const runUpdate = async (provider: ProviderId): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setUpdatePending(previous => ({ ...previous, [provider]: true }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      const result = await command({ type: 'update-client', provider, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? `Could not update ${PROVIDER_LABELS[provider]}. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, [provider]: `Could not update ${PROVIDER_LABELS[provider]}. Try again.` })) }
    finally { inFlight.current.delete(provider); setUpdatePending(previous => ({ ...previous, [provider]: undefined })) }
  }
  // OpenCode 2's own guide; opencode.ai/docs installs OpenCode 1, which Sotto does not drive.
  const openOpenCodeGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, opencode: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.(PROVIDER_INSTALL_GUIDES.opencode)
      if (!result?.ok) setErrors(previous => ({ ...previous, opencode: 'The OpenCode guide could not be opened. Try again.' }))
    } catch { setErrors(previous => ({ ...previous, opencode: 'The OpenCode guide could not be opened. Try again.' })) }
  }
  const openCursorGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, cursor: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.(PROVIDER_INSTALL_GUIDES.cursor)
      if (!result?.ok) setErrors(previous => ({ ...previous, cursor: CURSOR_GUIDE_FAILED }))
    } catch { setErrors(previous => ({ ...previous, cursor: CURSOR_GUIDE_FAILED })) }
  }
  const copyMuseLogin = async (): Promise<void> => {
    setCopyingLogin(true)
    setErrors(previous => ({ ...previous, muse: undefined }))
    try { await writeClipboard('muse login'); showLoginFeedback('Copied') }
    catch { setErrors(previous => ({ ...previous, muse: 'The command could not be copied. Select muse login and copy it yourself.' })) }
    finally { setCopyingLogin(false) }
  }
  const openMuseGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, muse: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.('https://dev.meta.ai/docs/muse-code')
      if (!result?.ok) setErrors(previous => ({ ...previous, muse: 'The Muse guide could not be opened. Try again.' }))
    } catch { setErrors(previous => ({ ...previous, muse: 'The Muse guide could not be opened. Try again.' })) }
  }
  const perform = async (provider: ProviderId, type: 'connect' | 'disconnect' | 'refresh'): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setPending(previous => ({ ...previous, [provider]: type }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      const result = await command({ type, provider, ...here, ...(type === 'connect' ? { notice: false as const } : {}) })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? 'Could not update this provider. Try again.' }))
    } catch { setErrors(previous => ({ ...previous, [provider]: 'Could not update this provider. Try again.' })) }
    finally { inFlight.current.delete(provider); setPending(previous => ({ ...previous, [provider]: undefined })) }
  }
  // Muse's shell sandbox is set when each of its hosts starts, so this computer's saved switch and its running hosts
  // can disagree until Muse reconnects; the page says so instead of implying the change is live.
  const museStatus = statusFor('muse')
  const museSandboxOwed = museStatus.connection === 'connected' && museStatus.sandboxDisabled !== undefined && museStatus.sandboxDisabled !== museDisableSandbox
  // Reconnect leaves the row once Muse disconnects, so focus that went with it lands on the switch beside it.
  const reconnectMuse = async (): Promise<void> => {
    await perform('muse', 'disconnect'); await perform('muse', 'connect')
    if (!document.activeElement || document.activeElement === document.body) sandboxActions.current?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }
  const saveMuseSandbox = async (disable: boolean): Promise<void> => {
    setErrors(previous => ({ ...previous, muse: undefined }))
    const failed = 'The shell sandbox setting was not saved, so Muse keeps the one it had. Try again.'
    try {
      const result = await command({ type: 'configure', patch: { museDisableSandbox: disable }, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, muse: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, muse: failed })) }
  }
  // The selected host's agent setting is not this computer's, so a joined window reads this computer's from its entry.
  const inheritedModelId = local ? local.agentModelId ?? '' : defaultThreadModelId(state.configuration, hostModels, state.reasoningAccounts)
  const triggerOf = (provider: ProviderId) => document.getElementById(`${rowId}-${provider}-trigger`)
  // Cursor's row signs in from its connection column, which says what to do while Cursor is not signed in and where a
  // sign-in stands while one waits; neither main's sentence about it nor a Connect press's own error is repeated there.
  const cursorBridge = window.sotto?.cursor
  const cursorExplains = (provider: ProviderId, status: ReturnType<typeof statusFor>): boolean => provider === 'cursor' && cursorBridge !== undefined
    && (('problem' in status && status.problem === 'signed-out') || cursorSignIn.signing)
  // Each sign-in press answers the row's last error, as every other press on this page does, so a Connect press's
  // "sign in" does not come back once the sign-in has connected Cursor.
  const cursorPress = <T,>(press: () => Promise<T>) => (): Promise<T> => { setErrors(previous => ({ ...previous, cursor: undefined })); return press() }
  const cursorRowSignIn = { ...cursorSignIn, start: cursorPress(cursorSignIn.start), reopen: cursorPress(cursorSignIn.reopen), signOut: cursorPress(cursorSignIn.signOut) }
  // Up and Down move between the rows' headers, Home and End to the first and last, and round from one end to the other.
  const moveBetweenRows = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const triggers = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-provider-trigger]')]
    const at = triggers.indexOf(event.target as HTMLElement)
    if (at < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? triggers.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + triggers.length) % triggers.length
    triggers[next]?.focus()
  }

  /** What today's provider detail showed, for the one open row: its connection and client on the left, its models on the right. */
  const details = (provider: ProviderId): ReactNode => {
    const status = statusFor(provider)
    const label = PROVIDER_LABELS[provider]
    const connected = status.connection === 'connected'
    const working = pending[provider] || status.connection === 'connecting'
    const update = updateFor(provider)
    const providerUpdating = updatingNow(provider)
    const models = newestModelsFirst(hostModels.filter(model => model.providerId === provider
      || (!model.providerId && model.provider === PROVIDER_LABELS[provider])))
    // A long-context variant the catalog does not list (`opus[1m]`) is its base model's entry here.
    const inheritedEntryId = catalogEntry(models, inheritedModelId)?.id
    // OpenCode missing, or refused for its version (OpenCode 1 among them), gets its install guide whether or not update
    // checks are on, as first-run setup offers it. A copy too old to use is most likely in ~/.opencode/bin, where both
    // generations' install scripts put it and Sotto looks first, so only OpenCode 2's script replaces it.
    const problem = 'problem' in status ? status.problem : undefined
    const openCodeInstall = provider !== 'opencode' || connected ? undefined
      : problem === 'not-installed' ? 'OpenCode 2 is not installed on this computer. Install it with its install script or npm’s @opencode/cli, then connect again.'
      : problem === 'too-old' ? `Sotto works with OpenCode ${'requiredVersion' in status && status.requiredVersion ? status.requiredVersion : '2.0.31'} or newer. Install OpenCode 2 with its install script, which replaces an older copy in ~/.opencode/bin, where Sotto looks first, then connect again. npm’s @opencode/cli installs a second copy and leaves that one.`
      : undefined
    const byHand = checkClientUpdates && update && ((update.behind && !update.canInstall) || update.state === 'failed' || update.state === 'unchanged')
    const connectButtons = <>
      <Button variant={connected ? 'secondary' : 'primary'} disabled={Boolean(working) || providerUpdating} aria-label={`${connected ? 'Disconnect' : status.connection === 'error' ? 'Retry' : 'Connect'} ${label}`}
        onClick={() => void perform(provider, connected ? 'disconnect' : 'connect')}>{working ? pending[provider] === 'disconnect' ? 'Disconnecting…' : pending[provider] === 'refresh' ? 'Refreshing…' : 'Connecting…' : connected ? 'Disconnect' : status.connection === 'error' ? 'Retry connection' : 'Connect'}</Button>
      {connected && <Button variant="ghost" iconOnly aria-label={`Refresh ${label}`} disabled={Boolean(working) || providerUpdating} onClick={() => void perform(provider, 'refresh')}><RefreshCw size={15} /></Button>}
    </>
    // Cursor's models arrive grouped by model maker in Cursor's order (ADR-0128), and its row keeps them so, grouped the
    // way the model menu groups them.
    const makers = provider === 'cursor' ? modelSources(hostModels.filter(model => model.providerId === 'cursor'), label) : undefined
    const modelItem = (model: (typeof models)[number]): ReactNode => <li key={model.id}><span><strong>{model.name}</strong>{model.reasoningEfforts?.length ? <small>{model.reasoningEfforts.join(' · ')}</small> : null}</span><small data-agent-setting={model.ready && model.id === inheritedEntryId ? true : undefined}>{model.ready ? model.id === inheritedEntryId ? 'Agent setting' : 'Available' : 'Unavailable'}</small></li>
    return <>
      <div className="provider-row__column">
        {provider === 'cursor' && cursorBridge ? <CursorConnection signIn={cursorRowSignIn} problem={problem} connected={connected}
          busy={Boolean(working) || providerUpdating} connectButton={connectButtons} onGuide={() => void openCursorGuide()} />
        : <div className="provider-connection">
          <div>
            <h4>Local connection</h4>
            <p>{provider === 'devin' ? 'Install Devin CLI and run devin auth login before connecting.' : provider === 'muse' ? 'Uses your Muse sign-in on this computer. Run muse login in a terminal before connecting.' : provider === 'opencode' ? 'Sotto runs its own OpenCode, with its own folder and its own sign-ins. The OpenCode you run yourself stays as it is.' : provider === 'deepseek' ? 'Sotto runs DeepSeek Harness with its own folder, on the models of your own model servers below. The DeepSeek Harness you run yourself stays as it is.' : `Uses your ${CLIENT_NAMES[provider]} sign-in on this computer.`}</p>
            {provider === 'muse' && <div className="provider-login"><code>muse login</code><Button variant="ghost" disabled={copyingLogin} aria-label="Copy Muse login command" onClick={() => void copyMuseLogin()}>{loginFeedback ?? 'Copy'}</Button><Button variant="ghost" onClick={() => void openMuseGuide()}>Sign-in steps</Button><span className="tt-visually-hidden" role="status">{loginFeedback ? 'Muse login command copied.' : ''}</span></div>}
          </div>
          <div className="provider-client__actions">{connectButtons}</div>
        </div>}
        {provider === 'opencode' && connected && window.sotto?.opencode ? <OpenCodeModelSources bridge={window.sotto.opencode} /> : null}
        <div className="provider-client" aria-busy={checkingUpdates || providerUpdating}>
          <div>
            <h4>Installed client</h4>
            <p className="tt-paragraph" role="status">{updatePending[provider] && update?.state !== 'updating' && update?.state !== 'queued' ? 'Starting the update…' : clientLine(update, status.verifiedVersion, checkClientUpdates, connected, checkingUpdates)}</p>
          </div>
          <div className="provider-client__actions">
            {checkClientUpdates && update?.canInstall && update.state !== 'updating' && update.state !== 'queued'
              ? <Button variant="primary" aria-label={provider === 'muse' ? update.state === 'failed' ? 'Try updating Muse again' : 'Update Muse' : undefined} disabled={Boolean(working) || updating || checkingUpdates} onClick={() => void runUpdate(provider)}>
                {update.state === 'failed' ? 'Try again' : 'Update'}</Button>
              : null}
            <Button variant="secondary" disabled={updating || checkingUpdates || !checkClientUpdates} onClick={() => void check(provider)}>{checkingUpdates ? 'Checking…' : 'Check again'}</Button>
          </div>
        </div>
        {provider === 'muse' && byHand && <details className="provider-client__steps"><summary>Installation steps</summary><p>{update.channel === 'unknown' || !update.byHand?.length ? 'Update Muse with the installer or package manager you used. Then check again.' : 'Run these commands in a terminal on this computer, then check again.'}</p>{update.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openMuseGuide()}>Open Muse installation guide</Button></details>}
        {provider === 'muse' && <div className="provider-client">
          <div>
            <h4>Shell sandbox</h4>
            <p>{museDisableSandbox
              ? "Muse's shell commands and file tools run as you on this computer, with no sandbox: they can reach files outside the project and the network. Only turn this off where Muse's sandbox cannot be set up. A thread on Ask for approval still asks."
              : "Muse's shell commands and file tools run inside its sandbox on this computer."}</p>
            {museSandboxOwed && <p className="provider-client__owed" role="status">{`Muse is still running with its sandbox ${museStatus.sandboxDisabled ? 'off' : 'on'}. Reconnect Muse to apply the change. Reconnecting stops any Muse reply that is under way.`}</p>}
          </div>
          <div className="provider-client__actions" ref={sandboxActions}>
            {museSandboxOwed && <Button variant="primary" disabled={Boolean(working) || providerUpdating} aria-label="Reconnect Muse to apply the shell sandbox setting" onClick={() => void reconnectMuse()}>Reconnect</Button>}
            <Toggle setting="shell-sandbox" label="Shell sandbox" checked={!museDisableSandbox}
              onCheckedChange={value => void saveMuseSandbox(!value)} />
          </div>
        </div>}
        {provider === 'claude' && compactIdle && <div className="provider-client">
          <div>
            <h4><Trans>Compact idle threads</Trans></h4>
            <p className="tt-paragraph"><Trans>After 54 minutes idle, Sotto compacts a large Claude thread before its cache expires, so your next message costs less. The thread keeps a summary instead of its full history.</Trans></p>
          </div>
          <div className="provider-client__actions"><Toggle setting={COMPACT_IDLE_SETTING} label={t`Compact idle threads`} checked={compactIdle.checked} onCheckedChange={compactIdle.onChange} /></div>
        </div>}
        {provider === 'opencode' && (openCodeInstall || byHand) && <details className="provider-client__steps"><summary>Installation steps</summary><p>{openCodeInstall ?? (!update?.byHand?.length ? 'Update OpenCode 2 with the installer or package manager you used. Then check again.' : 'Run these commands in a terminal on this computer, then check again.')}</p>{openCodeInstall ? null : update?.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openOpenCodeGuide()}>Open OpenCode installation guide</Button></details>}
        {provider === 'devin' && <p className="provider-models__empty">Uses your Devin account and credits. Devin keeps its own history and analytics, outside Sotto's control.</p>}
        {provider === 'muse' && <details className="provider-support"><summary>Threads with Muse</summary><p>Replies, images, steering, approvals, questions and reasoning effort. Change models and permissions in a thread.</p><p>On Muse 1.4.7 or newer, Muse threads get Sotto's browser, visual, pull request babysitting and delegation tools, and Watcher runs on Muse. Skills are unavailable. Muse does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.</p></details>}
        {provider === 'cursor' && <details className="provider-support"><summary>{t`Threads with Cursor`}</summary><p className="tt-paragraph"><Trans>Replies, images, approvals, Cursor’s questions and plans, and reasoning effort, on every model your Cursor plan lists. Change models and permissions in a thread.</Trans></p><p className="tt-paragraph"><Trans>Cursor threads get Sotto’s browser, visual, pull request babysitting and delegation tools, and skills, and Watcher runs on Cursor. Cursor has no fork of its own and cannot be steered, so a message sent while it works waits for the turn to end; Fork from here starts the new thread from a handover. Cursor reports no token counts, so it is not in Usage. Cursor keeps its own history, and runs Auto’s checks on its servers.</Trans></p></details>}
        {provider === 'opencode' && <details className="provider-support"><summary>Threads with OpenCode</summary><p>Replies, images, steering, approvals, questions and reasoning effort, on each model's own source. Change models and permissions in a thread.</p><p>Sotto's browser tools, Watcher and skills are unavailable. OpenCode does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.</p></details>}
        {provider === 'deepseek' && <details className="provider-support"><summary>Threads with DeepSeek Harness</summary><p>Replies, approvals and reasoning effort, on the keyless model servers you saved under Your own model servers. Change models and permissions in a thread. Replies arrive whole rather than word by word, and questions come in the reply itself.</p><p>DeepSeek Harness threads get Sotto's browser, visual, pull request babysitting and delegation tools. Images, steering, skills, Watcher and Usage counts are unavailable, and DeepSeek Harness does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.</p></details>}
      </div>
      <div className="provider-row__column provider-row__models" role="group" aria-labelledby={`${rowId}-${provider}-models`}>
        <h4 id={`${rowId}-${provider}-models`}><Trans>Models</Trans></h4>
        {makers?.length ? <div className="provider-models__makers" role="group" aria-label={`${label} available models`}>{makers.map(({ name, models: items }, index) => <React.Fragment key={name}>
          <h5 id={`${rowId}-${provider}-maker-${index}`} className="provider-models__maker">{name}</h5>
          <ul className="provider-models" aria-labelledby={`${rowId}-${provider}-maker-${index}`}>{items.map(modelItem)}</ul>
        </React.Fragment>)}</div>
          : models.length ? <ul className="provider-models" aria-label={`${label} available models`}>{models.map(modelItem)}</ul>
          : <p className="provider-models__empty">{connected ? 'No models were returned. Refresh this provider to check again.' : `Connect ${label} to load its models.`}</p>}
      </div>
    </>
  }

  const row = (provider: ProviderId): ReactNode => {
    const status = statusFor(provider)
    const label = PROVIDER_LABELS[provider]
    const isOpen = open === provider
    const active = enabled.includes(provider)
    const connecting = status.connection === 'connecting' || pending[provider]
    // While a sign-in waits on cursor.com, Cursor's row says so, live as a connect is, and holds its switch.
    const signingIn = provider === 'cursor' && cursorBridge !== undefined && cursorSignIn.signing && status.connection !== 'connected'
    const signedOut = provider === 'cursor' && status.connection === 'error' && 'problem' in status && status.problem === 'signed-out'
    const statusLabel = signingIn ? t`Signing in…` : pending[provider] === 'disconnect' ? 'Disconnecting…' : pending[provider] === 'refresh' ? 'Refreshing…' : connecting ? 'Connecting…' : status.connection === 'connected' ? 'Connected' : signedOut ? t`Not signed in` : status.connection === 'error' ? 'Needs attention' : active ? 'Not connected' : 'Disabled'
    const update = updateFor(provider)
    const providerUpdating = updatingNow(provider)
    const version = update?.published ?? ''
    const error = cursorExplains(provider, status) ? undefined : errors[provider] ?? status.error
    const id = `${rowId}-${provider}`
    // Closes the open row from anywhere in it and gives focus back to its header; a dialog's own Escape is its own.
    const closeOnEscape = (event: KeyboardEvent<HTMLLIElement>): void => {
      if (event.key !== 'Escape' || !isOpen || event.defaultPrevented) return
      if ((event.target as Element).closest('dialog, [role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
      triggerOf(provider)?.focus()
    }
    return <li key={provider} className="provider-row" data-open={isOpen} onKeyDown={closeOnEscape}>
      <div className="provider-row__head">
        <button type="button" id={`${id}-trigger`} className="provider-row__trigger" data-provider-trigger aria-label={label} aria-expanded={isOpen} aria-controls={isOpen ? `${id}-panel` : undefined} aria-describedby={`${id}-meta`}
          onClick={() => setOpen(isOpen ? null : provider)}>
          <ChevronRight className="provider-row__chevron" size={16} aria-hidden="true" />
          <span className="provider-badge" data-provider={provider}><ProviderMark provider={provider} name={label} size={17} /></span>
          <span className="provider-row__name"><strong>{label}</strong>
            <span className="provider-row__meta" id={`${id}-meta`}>
              <small className="provider-row__status" data-status={signingIn || connecting ? 'busy' : status.connection}><i aria-hidden="true" />{statusLabel}</small>
              <span className="provider-row__version">{status.version ? shortVersion(status.version) : ''}</span>
            </span>
          </span>
        </button>
        {checkClientUpdates && update?.published && (update.canInstall || providerUpdating)
          ? <button type="button" className="provider-row__update tt-focusable" aria-label={providerUpdating ? t`Updating ${label} to ${version}` : t`Update ${label} to ${version}`}
            disabled={providerUpdating || Boolean(connecting) || updating || checkingUpdates} onClick={() => void runUpdate(provider)}>
            <CircleArrowUp size={13} aria-hidden="true" />{providerUpdating ? update.state === 'queued' ? t`Waiting to update` : t`Updating…` : t`Update to ${version}`}</button>
          : <span className="provider-row__update-slot" />}
        <Toggle label={`Enable ${label}`} checked={active} disabled={signingIn || Boolean(connecting) || providerUpdating} onCheckedChange={value => void perform(provider, value ? 'connect' : 'disconnect')} />
      </div>
      {error && <p role="alert" className={typeof error === 'string' ? 'provider-row__error' : 'provider-row__error tt-paragraph'}>{shownWords(error)}</p>}
      {isOpen && <div id={`${id}-panel`} role="region" aria-label={t`${label} details`} className="provider-row__panel">{details(provider)}</div>}
    </li>
  }

  return <div className="providers-settings">
    {/* Your own model servers sit above the provider list, apart from any one provider (ADR-0124, layout B). */}
    {ownServers ? <OwnModelServers bridge={ownServers} /> : null}
    <ul className="providers-list" aria-label="Thread providers" data-setting="thread-providers" onKeyDown={moveBetweenRows}>{providerIdSchema.options.filter(provider => !held.has(provider)).map(row)}</ul>
    <p className="providers-note">Choose what new threads start with under Agents.</p>
    <div className="providers-updates">
      <div>
        <h4>Check for client updates</h4>
        <p className={held.has('muse') && held.has('cursor') ? undefined : 'tt-paragraph'}>{updateChecks(held)}</p>
      </div>
      <Toggle setting="client-updates" label="Check for client updates" checked={checkClientUpdates}
        onCheckedChange={value => void command({ type: 'configure', patch: { checkClientUpdates: value }, ...here })} />
    </div>
  </div>
}
