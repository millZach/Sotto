import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, CircleArrowUp, RefreshCw } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { defaultThreadModelId, enabledThreadProviders, PROVIDER_LABELS, providerIdSchema, type ProviderClientUpdate, type ProviderId } from '../../../shared/agents'
import { catalogEntry } from '../../../shared/modelCatalog'
import { DEFAULT_ULTRACODE_EFFORT, ULTRACODE_EFFORTS, type UltracodeEffort } from '../../../shared/ultracode'
import { Button } from '../components/Button'
import { Toggle } from '../components/Toggle'
import { useOptionalAgents } from './AgentContext'
import { useHeldProviders } from '../state/owlFeature'
import { ProviderMark } from './ProviderMark'
import { OpenCodeModelSources } from './OpenCodeModelSources'
import { ProviderModelList } from './ProviderModelList'
import { CursorConnection, useCursorSignIn } from './CursorConnection'
import { OwnModelServers, useOwnServersBridge } from './OwnModelServers'
import { useTransientFlag, writeClipboard } from './richActions'
import { localHostId, localProviders } from '../features/onboarding/localAgents'
import { PROVIDER_INSTALL_GUIDES } from '../../../shared/hostProviders'
import { COMPACT_IDLE_SETTING, onProviderAimed, takeAimedProvider } from '../features/settings/settingsTarget'
import { shownWords, type LaterWords } from './interfaceWords'
import { effortLabel } from './EffortPicker'
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
  return i18n._(msg`Asks the npm registry for each client’s latest version when it connects and every five minutes. Only the package name is sent.`)
}
/** What the Providers page says when Cursor's install guide does not open. */
const CURSOR_GUIDE_FAILED = msg`Cursor’s install guide could not be opened. Try again.`

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
  if (update.state === 'failed' && update.failure === 'not-listed') {
    const to = published ?? t`the published version`
    return t`${installed} is installed. mise does not list ${to} yet, even with its cache cleared, so Sotto did not install it. Try again later.`
  }
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

/** The version a client reports, cut to its number where it says more than that. */
function shortVersion(version: string): string {
  return version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] ?? version.slice(0, 36)
}

/**
 * Settings → Providers: one list with a row per provider, each opening in place to its connection, client and models
 * (Zach's pick, variant A of the tag prototype/providers-settings). One row is open at a time; every row starts closed
 * unless a link aimed at one, and pressing an open row's header closes it.
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
  const [open, setOpen] = useState<ProviderId | null>(() => takeAimedProvider() ?? null)
  useEffect(() => onProviderAimed(setOpen), [])
  const [pending, setPending] = useState<Partial<Record<ProviderId, 'connect' | 'disconnect' | 'refresh'>>>({})
  const [errors, setErrors] = useState<Partial<Record<ProviderId, LaterWords | undefined>>>({})
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updatePending, setUpdatePending] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [copyingLogin, setCopyingLogin] = useState(false)
  const [loginCopied, showLoginCopied] = useTransientFlag<'copied'>()
  /** Cursor's sign-in from its row (ADR-0128), kept while its row is closed or another row is open. */
  const cursorSignIn = useCursorSignIn(window.sotto?.cursor)
  const inFlight = useRef(new Set<ProviderId>())
  const checkInFlight = useRef(false)
  const sandboxActions = useRef<HTMLDivElement>(null)
  const rowId = useId()
  const state = agents?.state
  const command = agents?.command
  if (!state || !command) return <p role="status">{t`Loading providers…`}</p>
  // This page is this computer's clients, whichever host is selected for new work: it reads this computer's entry and
  // names this computer on every command, so a Retry never reaches another host's client. Without host connections
  // (no router joining hosts), the state is this computer's alone.
  const hasHostConnections = Boolean(state.connections?.length)
  const localHost = localHostId(state)
  const local = hasHostConnections ? state.host.clientHosts?.find(host => host.hostId === localHost) : undefined
  const here = hasHostConnections && localHost ? { hostId: localHost } : {}
  // With this computer's host off there are no clients here to show, and nothing on this page may reach another host's.
  if (hasHostConnections && !local) return <p role="status" className="provider-models__empty tt-paragraph">{t`This computer’s local host is off, so Sotto can’t run agents here. Turn on Run the local host in Settings › Hosts & phones, then restart Sotto. A host’s own providers are on its tiles there.`}</p>
  const providers = localProviders(state)
  const hostModels = hasHostConnections ? local?.models ?? [] : state.host.models
  const clientUpdates = hasHostConnections ? local?.clientUpdates : state.clientUpdates
  const checkClientUpdates = local?.checkClientUpdates ?? state.configuration.checkClientUpdates
  const museDisableSandbox = local?.museDisableSandbox ?? state.configuration.museDisableSandbox
  const ultracodeEffort = local?.claudeUltracodeEffort ?? state.configuration.claudeUltracodeEffort ?? DEFAULT_ULTRACODE_EFFORT
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
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? msg`Could not check for client updates. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, [provider]: msg`Could not check for client updates. Try again.` })) }
    finally { checkInFlight.current = false; setCheckingUpdates(false) }
  }
  const runUpdate = async (provider: ProviderId): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setUpdatePending(previous => ({ ...previous, [provider]: true }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    const providerName = PROVIDER_LABELS[provider]
    const failed = msg({ message: `Could not update ${providerName}. Try again.`, comment: '{providerName} is a provider\'s name.' })
    try {
      const result = await command({ type: 'update-client', provider, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, [provider]: failed })) }
    finally { inFlight.current.delete(provider); setUpdatePending(previous => ({ ...previous, [provider]: undefined })) }
  }
  // OpenCode 2's own guide; opencode.ai/docs installs OpenCode 1, which Sotto does not drive.
  const openOpenCodeGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, opencode: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.(PROVIDER_INSTALL_GUIDES.opencode)
      if (!result?.ok) setErrors(previous => ({ ...previous, opencode: msg`The OpenCode guide could not be opened. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, opencode: msg`The OpenCode guide could not be opened. Try again.` })) }
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
    try { await writeClipboard('muse login'); showLoginCopied('copied') }
    catch { setErrors(previous => ({ ...previous, muse: msg`The command could not be copied. Select muse login and copy it yourself.` })) }
    finally { setCopyingLogin(false) }
  }
  const openMuseGuide = async (): Promise<void> => {
    setErrors(previous => ({ ...previous, muse: undefined }))
    try {
      const result = await window.sotto?.openExternalLink?.('https://dev.meta.ai/docs/muse-code')
      if (!result?.ok) setErrors(previous => ({ ...previous, muse: msg`The Muse guide could not be opened. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, muse: msg`The Muse guide could not be opened. Try again.` })) }
  }
  const perform = async (provider: ProviderId, type: 'connect' | 'disconnect' | 'refresh'): Promise<void> => {
    if (inFlight.current.has(provider)) return
    inFlight.current.add(provider)
    setPending(previous => ({ ...previous, [provider]: type }))
    setErrors(previous => ({ ...previous, [provider]: undefined }))
    try {
      const result = await command({ type, provider, ...here, ...(type === 'connect' ? { notice: false as const } : {}) })
      if (!result || result.error) setErrors(previous => ({ ...previous, [provider]: result?.error ?? msg`Could not update this provider. Try again.` }))
    } catch { setErrors(previous => ({ ...previous, [provider]: msg`Could not update this provider. Try again.` })) }
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
    const failed = msg`The shell sandbox setting was not saved, so Muse keeps the one it had. Try again.`
    try {
      const result = await command({ type: 'configure', patch: { museDisableSandbox: disable }, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, muse: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, muse: failed })) }
  }
  const saveUltracodeEffort = async (claudeUltracodeEffort: UltracodeEffort): Promise<void> => {
    setErrors(previous => ({ ...previous, claude: undefined }))
    const failed = msg({ message: 'The Ultracode effort was not saved, so Claude threads keep the one they had. Try again.', comment: 'Shown when saving the Ultracode effort setting fails. Ultracode is Claude Code’s own name; keep it as it is.' })
    try {
      const result = await command({ type: 'configure', patch: { claudeUltracodeEffort }, ...here })
      if (!result || result.error) setErrors(previous => ({ ...previous, claude: result?.error ?? failed }))
    } catch { setErrors(previous => ({ ...previous, claude: failed })) }
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

  /** What the one open row shows: its connection, its models in a small field, and its client. */
  const details = (provider: ProviderId): ReactNode => {
    const status = statusFor(provider)
    const label = PROVIDER_LABELS[provider], clientName = CLIENT_NAMES[provider]
    const connected = status.connection === 'connected'
    const working = pending[provider] || status.connection === 'connecting'
    const update = updateFor(provider)
    const providerUpdating = updatingNow(provider)
    const listed = hostModels.filter(model => model.providerId === provider || (!model.providerId && model.provider === PROVIDER_LABELS[provider]))
    // Only the models the user can use now: one the provider lists but cannot run is left out rather than labelled.
    const models = listed.filter(model => model.ready)
    // A long-context variant the catalog does not list (`opus[1m]`) is its base model's entry here.
    const inheritedEntryId = catalogEntry(models, inheritedModelId)?.id
    // OpenCode missing, or refused for its version (OpenCode 1 among them), gets its install guide whether or not update
    // checks are on, as first-run setup offers it. A copy too old to use is most likely in ~/.opencode/bin, where both
    // generations' install scripts put it and Sotto looks first, so only OpenCode 2's script replaces it.
    const problem = 'problem' in status ? status.problem : undefined
    const requiredVersion = 'requiredVersion' in status && status.requiredVersion ? status.requiredVersion : '2.0.31'
    const openCodeInstall = provider !== 'opencode' || connected ? undefined
      : problem === 'not-installed' ? t`OpenCode 2 is not installed on this computer. Install it with its install script or npm’s @opencode/cli, then connect again.`
      : problem === 'too-old' ? t({ message: `Sotto works with OpenCode ${requiredVersion} or newer. Install OpenCode 2 with its install script, which replaces an older copy in ~/.opencode/bin, where Sotto looks first, then connect again. npm’s @opencode/cli installs a second copy and leaves that one.`, comment: '{requiredVersion} is a version number.' })
      : undefined
    const byHand = checkClientUpdates && update && ((update.behind && !update.canInstall) || update.state === 'failed' || update.state === 'unchanged')
    const connectButtons = <>
      <Button variant={connected ? 'secondary' : 'primary'} disabled={Boolean(working) || providerUpdating} aria-label={connected ? t({ message: `Disconnect ${label}`, comment: '{label} is a provider\'s name.' }) : status.connection === 'error' ? t({ message: `Retry ${label}`, comment: '{label} is a provider\'s name; the button connects it again.' }) : t({ message: `Connect ${label}`, comment: '{label} is a provider\'s name.' })}
        onClick={() => void perform(provider, connected ? 'disconnect' : 'connect')}>{working ? pending[provider] === 'disconnect' ? t`Disconnecting…` : pending[provider] === 'refresh' ? t`Refreshing…` : t`Connecting…` : connected ? t`Disconnect` : status.connection === 'error' ? t`Retry connection` : t`Connect`}</Button>
      {connected && <Button variant="ghost" iconOnly aria-label={t({ message: `Refresh ${label}`, comment: '{label} is a provider\'s name.' })} disabled={Boolean(working) || providerUpdating} onClick={() => void perform(provider, 'refresh')}><RefreshCw size={15} /></Button>}
    </>
    return <>
      <div className="provider-row__column">
        {provider === 'cursor' && cursorBridge ? <CursorConnection signIn={cursorRowSignIn} problem={problem} connected={connected}
          busy={Boolean(working) || providerUpdating} connectButton={connectButtons} onGuide={() => void openCursorGuide()} />
        : <div className="provider-connection">
          <div>
            <h4>{t`Local connection`}</h4>
            <p className="tt-paragraph">{provider === 'devin' ? t`Install Devin CLI and run devin auth login before connecting.` : provider === 'muse' ? t`Uses your Muse sign-in on this computer. Run muse login in a terminal before connecting.` : provider === 'opencode' ? t`Sotto runs its own OpenCode, with its own folder and its own sign-ins. The OpenCode you run yourself stays as it is.` : provider === 'deepseek' ? t`Sotto runs DeepSeek Harness with its own folder, on the models of your own model servers below. The DeepSeek Harness you run yourself stays as it is.` : t({ message: `Uses your ${clientName} sign-in on this computer.`, comment: '{clientName} is a provider\'s client, such as Claude Code.' })}</p>
            {provider === 'muse' && <div className="provider-login"><code>muse login</code><Button variant="ghost" disabled={copyingLogin} aria-label={t`Copy Muse login command`} onClick={() => void copyMuseLogin()}>{loginCopied ? t`Copied` : t`Copy`}</Button><Button variant="ghost" onClick={() => void openMuseGuide()}>{t`Sign-in steps`}</Button><span className="tt-visually-hidden" role="status">{loginCopied ? t`Muse login command copied.` : ''}</span></div>}
          </div>
          <div className="provider-client__actions">{connectButtons}</div>
        </div>}
        {provider === 'opencode' && connected && window.sotto?.opencode ? <OpenCodeModelSources bridge={window.sotto.opencode} /> : null}
        {/* A small field rather than the whole list, so one provider's models never fill the page. Cursor's models arrive
            grouped by model maker (ADR-0128) and OpenCode's by model source, and the list keeps those groups. */}
        <div className="provider-client">
          <div>
            <h4><Trans>Models</Trans></h4>
            {/* A provider that is not connected keeps its last models marked not ready, so connection is asked first. */}
            <p className="tt-paragraph">{models.length ? t({ message: `The models ${clientName} offers you now.`, comment: '{clientName} is a provider\'s client, such as Claude Code.' })
              : !connected ? t({ message: `Connect ${label} to load its models.`, comment: '{label} is a provider\'s name.' })
              : listed.length ? t({ message: `${clientName} lists no model you can use now. Check your ${clientName} sign-in and plan, then refresh this provider.`, comment: '{clientName} is a provider\'s client, such as Claude Code.' })
              : t`No models were returned. Refresh this provider to check again.`}</p>
          </div>
          {models.length ? <div className="provider-client__actions"><ProviderModelList label={label} models={models} agentEntryId={inheritedEntryId} /></div> : null}
        </div>
        <div className="provider-client" aria-busy={checkingUpdates || providerUpdating}>
          <div>
            <h4>{t`Installed client`}</h4>
            <p className="tt-paragraph" role="status">{updatePending[provider] && update?.state !== 'updating' && update?.state !== 'queued' ? t`Starting the update…` : clientLine(update, status.verifiedVersion, checkClientUpdates, connected, checkingUpdates)}</p>
          </div>
          <div className="provider-client__actions">
            {checkClientUpdates && update?.canInstall && update.state !== 'updating' && update.state !== 'queued'
              ? <Button variant="primary" aria-label={provider === 'muse' ? update.state === 'failed' ? t`Try updating Muse again` : t`Update Muse` : undefined} disabled={Boolean(working) || updating || checkingUpdates} onClick={() => void runUpdate(provider)}>
                {update.state === 'failed' ? t`Try again` : t({ message: 'Update', comment: 'A button that installs the published version of a provider\'s client.' })}</Button>
              : null}
            <Button variant="secondary" disabled={updating || checkingUpdates || !checkClientUpdates} onClick={() => void check(provider)}>{checkingUpdates ? t`Checking…` : t`Check again`}</Button>
          </div>
        </div>
        {provider === 'muse' && byHand && <details className="provider-client__steps"><summary>{t`Installation steps`}</summary><p className="tt-paragraph">{update.channel === 'unknown' || !update.byHand?.length ? t`Update Muse with the installer or package manager you used. Then check again.` : t`Run these commands in a terminal on this computer, then check again.`}</p>{update.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openMuseGuide()}>{t`Open Muse installation guide`}</Button></details>}
        {provider === 'muse' && <div className="provider-client">
          <div>
            <h4>{t`Shell sandbox`}</h4>
            <p className="tt-paragraph">{museDisableSandbox
              ? t`Muse's shell commands and file tools run as you on this computer, with no sandbox: they can reach files outside the project and the network. Only turn this off where Muse's sandbox cannot be set up. A thread on Ask for approval still asks.`
              : t`Muse's shell commands and file tools run inside its sandbox on this computer.`}</p>
            {museSandboxOwed && <p className="provider-client__owed tt-paragraph" role="status">{museStatus.sandboxDisabled
              ? t`Muse is still running with its sandbox off. Reconnect Muse to apply the change. Reconnecting stops any Muse reply that is under way.`
              : t`Muse is still running with its sandbox on. Reconnect Muse to apply the change. Reconnecting stops any Muse reply that is under way.`}</p>}
          </div>
          <div className="provider-client__actions" ref={sandboxActions}>
            {museSandboxOwed && <Button variant="primary" disabled={Boolean(working) || providerUpdating} aria-label={t`Reconnect Muse to apply the shell sandbox setting`} onClick={() => void reconnectMuse()}>{t`Reconnect`}</Button>}
            <Toggle setting="shell-sandbox" label={t`Shell sandbox`} checked={!museDisableSandbox}
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
        {provider === 'claude' && <div className="provider-client">
          <div>
            <h4 id={`${rowId}-ultracode`}><Trans comment="A setting on Settings > Providers > Claude Code. Ultracode is Claude Code’s own name for its multi-agent workflow mode; keep it as it is.">Ultracode effort</Trans></h4>
            <p id={`${rowId}-ultracode-line`} className="tt-paragraph"><Trans comment="Describes the Ultracode effort setting. Ultracode and Extra high are the names the effort control shows.">The effort each agent runs at while a Claude thread is on Ultracode. Claude Code’s own choice is Extra high. A change takes effect on the thread’s next message.</Trans></p>
          </div>
          <div className="provider-client__actions">
            <select className="tt-select tt-focusable provider-client__select" data-setting="ultracode-effort" aria-labelledby={`${rowId}-ultracode`} aria-describedby={`${rowId}-ultracode-line`}
              value={ultracodeEffort} onChange={event => void saveUltracodeEffort(event.target.value as UltracodeEffort)}>
              {ULTRACODE_EFFORTS.map(level => {
                const name = effortLabel(level)
                return <option key={level} value={level}>{level === DEFAULT_ULTRACODE_EFFORT
                  ? t({ message: `${name} (Claude Code’s choice)`, comment: 'An option in the Ultracode effort setting. {name} is a reasoning effort level, such as Extra high, marked as the one Claude Code picks on its own.' })
                  : name}</option>
              })}
            </select>
          </div>
        </div>}
        {provider === 'opencode' && (openCodeInstall || byHand) && <details className="provider-client__steps"><summary>{t`Installation steps`}</summary><p className="tt-paragraph">{openCodeInstall ?? (!update?.byHand?.length ? t`Update OpenCode 2 with the installer or package manager you used. Then check again.` : t`Run these commands in a terminal on this computer, then check again.`)}</p>{openCodeInstall ? null : update?.byHand?.map((line, index) => <code key={index}>{line}</code>)}<Button variant="ghost" onClick={() => void openOpenCodeGuide()}>{t`Open OpenCode installation guide`}</Button></details>}
        {provider === 'devin' && <p className="provider-models__empty tt-paragraph">{t`Uses your Devin account and credits. Devin keeps its own history and analytics, outside Sotto's control.`}</p>}
        {provider === 'muse' && <details className="provider-support"><summary>{t`Threads with Muse`}</summary><p className="tt-paragraph">{t`Replies, images, steering, approvals, questions and reasoning effort. Change models and permissions in a thread.`}</p><p className="tt-paragraph">{t`On Muse 1.4.7 or newer, Muse threads get Sotto's browser, visual, pull request babysitting and delegation tools, and Watcher runs on Muse. Skills are unavailable. Muse does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.`}</p></details>}
        {provider === 'cursor' && <details className="provider-support"><summary>{t`Threads with Cursor`}</summary><p className="tt-paragraph"><Trans>Replies, images, approvals, Cursor’s questions and plans, and reasoning effort, on every model your Cursor plan lists. Change models and permissions in a thread.</Trans></p><p className="tt-paragraph"><Trans>Cursor threads get Sotto’s browser, visual, pull request babysitting and delegation tools, and skills, and Watcher runs on Cursor. Cursor has no fork of its own and cannot be steered, so a message sent while it works waits for the turn to end; Fork from here starts the new thread from a handover. Cursor reports no token counts, so it is not in Usage. Cursor keeps its own history, and runs Auto’s checks on its servers.</Trans></p></details>}
        {provider === 'opencode' && <details className="provider-support"><summary>{t`Threads with OpenCode`}</summary><p className="tt-paragraph">{t`Replies, images, steering, approvals, questions and reasoning effort, on each model's own source. Change models and permissions in a thread.`}</p><p className="tt-paragraph">{t`Sotto's browser tools, Watcher and skills are unavailable. OpenCode does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.`}</p></details>}
        {provider === 'deepseek' && <details className="provider-support"><summary>{t`Threads with DeepSeek Harness`}</summary><p className="tt-paragraph">{t`Replies, approvals and reasoning effort, on the keyless model servers you saved under Your own model servers. Change models and permissions in a thread. Replies arrive whole rather than word by word, and questions come in the reply itself.`}</p><p className="tt-paragraph">{t`DeepSeek Harness threads get Sotto's browser, visual, pull request babysitting and delegation tools. Images, steering, skills, Watcher and Usage counts are unavailable, and DeepSeek Harness does not write thread titles, branch names, commit messages or pull request drafts; Sotto keeps its default text.`}</p></details>}
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
    const statusLabel = signingIn ? t`Signing in…` : pending[provider] === 'disconnect' ? t`Disconnecting…` : pending[provider] === 'refresh' ? t`Refreshing…` : connecting ? t`Connecting…`
      : status.connection === 'connected' ? t({ message: 'Connected', comment: 'A provider\'s status.' }) : signedOut ? t`Not signed in` : status.connection === 'error' ? t({ message: 'Needs attention', comment: 'A provider\'s status.' })
      : active ? t({ message: 'Not connected', comment: 'A provider\'s status.' }) : t({ message: 'Disabled', comment: 'A provider\'s status: switched off.' })
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
        <Toggle label={t({ message: `Enable ${label}`, comment: '{label} is a provider\'s name.' })} checked={active} disabled={signingIn || Boolean(connecting) || providerUpdating} onCheckedChange={value => void perform(provider, value ? 'connect' : 'disconnect')} />
      </div>
      {error && <p role="alert" className="provider-row__error tt-paragraph">{shownWords(error)}</p>}
      {isOpen && <div id={`${id}-panel`} role="region" aria-label={t`${label} details`} className="provider-row__panel">{details(provider)}</div>}
    </li>
  }

  return <div className="providers-settings">
    {/* Your own model servers sit above the provider list, apart from any one provider (ADR-0124, layout B). */}
    {ownServers ? <OwnModelServers bridge={ownServers} /> : null}
    <ul className="providers-list" aria-label={t`Thread providers`} data-setting="thread-providers" onKeyDown={moveBetweenRows}>{providerIdSchema.options.filter(provider => !held.has(provider)).map(row)}</ul>
    <p className="providers-note tt-paragraph">{t`Choose what new threads start with in Settings > Threads.`}</p>
    <div className="providers-updates">
      <div>
        <h4>{t`Check for client updates`}</h4>
        <p className="tt-paragraph">{updateChecks(held)}</p>
      </div>
      <Toggle setting="client-updates" label={t`Check for client updates`} checked={checkClientUpdates}
        onCheckedChange={value => void command({ type: 'configure', patch: { checkClientUpdates: value }, ...here })} />
    </div>
  </div>
}
