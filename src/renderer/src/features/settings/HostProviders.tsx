import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { writeClipboard } from '../../agents/richActions'
import { PROVIDER_LABELS, type AgentProviderStatus, type ClientUpdateRun, type ProviderClientUpdate, type ProviderId } from '../../../../shared/agents'
import type { HostSetupChoice, HostsBridge, HostStatus } from '../../../../shared/hosts'
import { opencodeNotOnHost } from '../../../../shared/opencodeSignIn'
import { HOST_PROVIDER_JOB_WORDS, HOST_PROVIDERS, hostProviderJobCase, PROVIDER_SIGN_IN_COMMANDS, PROVIDER_SIGN_IN_SHAPES, type HostProviderAction, type HostProviderId, type HostProviderJobCase, type HostProviderJobState } from '../../../../shared/hostProviders'
import { useHeldProviders } from '../../state/owlFeature'
import { Button } from '../../components/Button'
import { ProviderMark } from '../../agents/ProviderMark'
import { useOptionalAgents } from '../../agents/AgentContext'
import { useOptionalApp } from '../../state/AppContext'
import { HostProviderSignIn } from './HostProviderSignIn'
import { OpenCodeModelSources } from '../../agents/OpenCodeModelSources'
import { hostOpenCodeBridge } from './hostOpenCode'
import { HostProviderAgent } from './HostProviderAgent'
import { HostClientUpdatesChip, tileUpdateParts, useHostClientUpdates, waitingForOf, type SendClientUpdate } from './HostClientUpdates'
import type { HostClientUpdatesView } from './hostClientUpdateWords'
import { shownWords, type LaterWords } from './laterWords'
import './hostProviders.css'

/** The order the tiles are in: the providers the prototype drew, in its order (ADR-0037), then Muse and OpenCode (#1107). */
export const HOST_PROVIDER_ORDER: readonly HostProviderId[] = HOST_PROVIDERS

/**
 * What one tile says. `kind` decides its dot and its actions: Disconnect when connected, Connect when turned off, Sign in
 * when not signed in, and when the host cannot use it (not installed, too old, or not startable) Have my agent install
 * it (update it, fix it) beside Check again. `working` while an agent's provider job runs on it (ADR-0035).
 */
export type HostProviderTileKind = 'connected' | 'connecting' | 'off' | 'signed-out' | 'not-installed' | 'too-old' | 'cannot-start' | 'working'
export interface HostProviderTile { readonly kind: HostProviderTileKind; readonly state: string; readonly detail: string }

/** A client's own version as the tile shows it: "0.155.1" from "codex-cli 0.155.1" or "1.0.41 / ACP 1". */
export function shownVersion(version: string): string {
  return version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/u)?.[0] ?? version.trim().slice(0, 36)
}

/**
 * The tile for one of a host's providers, from the status the host publishes. `host` is the name this computer saved it under.
 * Read while the tile renders, in the interface language.
 */
export function hostProviderTile(status: AgentProviderStatus | undefined, host: string): HostProviderTile {
  const version = status?.version ? shownVersion(status.version) : ''
  if (status?.connection === 'connected') return { kind: 'connected', state: i18n._(msg({ message: 'Connected', comment: 'A provider on a host: connected and ready.' })), detail: [status.account, version].filter(Boolean).join(' · ') }
  if (status?.connection === 'connecting') return { kind: 'connecting', state: i18n._(msg`Connecting…`), detail: version }
  if (status?.connection !== 'error') return { kind: 'off', state: i18n._(msg({ message: 'Turned off', comment: 'A provider on a host that the user disconnected.' })), detail: version || i18n._(msg`Connect it to use it on ${host}.`) }
  switch (status.problem) {
    case 'signed-out': return { kind: 'signed-out', state: i18n._(msg`Not signed in`), detail: version || i18n._(msg`Installed on ${host}.`) }
    case 'not-installed': return { kind: 'not-installed', state: i18n._(msg`Not installed`), detail: i18n._(msg`Not on ${host} yet.`) }
    case 'too-old': {
      const required = status.requiredVersion ? shownVersion(status.requiredVersion) : ''
      const installed = version ? i18n._(msg`${version} on ${host}.`) : i18n._(msg`The one on ${host} is too old.`)
      const needs = required ? i18n._(msg`Sotto needs ${required} or later.`) : i18n._(msg`Sotto needs a newer version.`)
      return { kind: 'too-old', state: i18n._(msg`Too old to use`), detail: `${installed} ${needs}` }
    }
    default: return { kind: 'cannot-start', state: i18n._(msg`Can't be started`), detail: i18n._(msg`Installed, but ${host}'s host could not find or start it.`) }
  }
}

/** How many of a host's providers are connected, as its row says after "Connected". */
export function connectedProvidersLabel(providers: readonly AgentProviderStatus[]): string {
  const count = providers.filter(provider => provider.connection === 'connected').length
  return plural(count, { one: '# provider', other: '# providers' })
}

type Pending = HostProviderAction['action']
const PENDING_LABEL: Readonly<Record<Pending, MessageDescriptor>> = { connect: msg`Connecting…`, disconnect: msg`Disconnecting…`, refresh: msg`Checking…` }

/** Devin and Muse sign in on the host itself: their tiles show the command, with Copy, instead of Sign in. */
function SignInCommand({ host, provider }: { readonly host: string; readonly provider: ProviderId }): ReactNode {
  const { t } = useLingui()
  const command = PROVIDER_SIGN_IN_COMMANDS[provider] ?? ''
  const name = PROVIDER_LABELS[provider]
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1500); return () => clearTimeout(timer) }, [copied])
  const copy = async (): Promise<void> => { try { await writeClipboard(command); setCopied('copied') } catch { setCopied('failed') } }
  return <div className="host-provider__command">
    <p className="tt-paragraph"><Trans>Sign in on {host} with:</Trans></p>
    <code>{command}</code>
    <Button variant="secondary" aria-label={t`Copy the ${name} sign-in command`} onClick={() => void copy()}>
      {copied === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'copied' ? t`Copied` : t`Copy`}
    </Button>
    {copied === 'failed' ? <p className="tt-paragraph"><Trans>The command could not be copied. Select it and copy it yourself.</Trans></p> : null}
    <span className="tt-visually-hidden" role="status">{copied === 'copied' ? t`Copied the command` : ''}</span>
  </div>
}

const running = (job: HostProviderJobState): boolean => job.phase === 'starting' || job.phase === 'running'

/**
 * What an ended provider job left to say on its tile: how it ended, and the thread that did the work. Found says so only
 * while the tile waits for Sign in; once signed in, the tile says the rest.
 */
function jobNote(job: HostProviderJobState | undefined, kind: HostProviderTileKind): LaterWords {
  if (!job || running(job)) return ''
  const { host, modelName: model, threadTitle: thread } = job
  if (job.phase === 'found') return kind !== 'signed-out' ? '' : msg`${host}'s host found it. ${model} worked in the thread ${thread}.`
  if (kind !== 'not-installed' && kind !== 'too-old' && kind !== 'cannot-start') return ''
  if (job.phase === 'stopped') return msg`Stopped. Anything the agent installed on ${host} stays there, and the thread ${thread} stays in your Threads list.`
  // The job's own sentence from main, when it failed with one.
  if (job.phase === 'failed') return job.error ?? msg`The thread ${thread} did not start working. Nothing was changed on ${host}.`
  return ''
}

/** What a tile needs of its host's client updates (#480). */
interface TileUpdates {
  readonly view: HostClientUpdatesView; readonly run: ClientUpdateRun | undefined; readonly send: SendClientUpdate; readonly busy: boolean
  readonly refusal: { readonly providers: readonly ProviderId[]; readonly text: LaterWords } | undefined
}

function ProviderTile({ host, provider, status, bridge, job, onSignIn, onAgent, updates }: {
  readonly host: HostStatus; readonly provider: HostProviderId; readonly status: AgentProviderStatus | undefined
  readonly bridge: HostsBridge; readonly job: HostProviderJobState | undefined
  readonly onSignIn: (provider: HostProviderId) => void; readonly onAgent: (provider: HostProviderId, jobCase: HostProviderJobCase) => void
  /** The host's client updates, when it offers them: this tile shows its own client's. */
  readonly updates?: TileUpdates | undefined
}): ReactNode {
  const { t } = useLingui()
  const name = PROVIDER_LABELS[provider]
  const hostName = host.name
  const working = job && running(job) ? job : undefined
  const workingThread = working?.threadTitle
  const shown = hostProviderTile(status, host.name)
  const tile: HostProviderTile = working ? { kind: 'working', state: HOST_PROVIDER_JOB_WORDS[working.case].working, detail: '' } : shown
  const agents = useOptionalAgents()
  const app = useOptionalApp()
  const [pending, setPending] = useState<Pending | null>(null)
  const [stopping, setStopping] = useState(false)
  /** What the last press found, for the state it was pressed in: a tile the press changed has already said it. */
  const [note, setNote] = useState<{ readonly text: LaterWords; readonly kind: HostProviderTileKind } | null>(null)
  const titleId = useId()
  const actions = useRef<HTMLDivElement>(null)
  // A connected client that is behind, waiting, updating or did not update says so under its version (#480).
  const update = tile.kind === 'connected' && updates ? updates.view.shown.find(item => item.id === provider) : undefined
  const parts = tileUpdateParts({ update, phase: update ? updates!.view.phases.get(provider)! : 'current', host: host.name,
    waitingFor: updates ? waitingForOf(updates.view, provider, updates.run, HOST_PROVIDER_ORDER) : undefined, busy: updates?.busy ?? false,
    send: updates?.send ?? (async () => undefined) })
  const refused = updates?.refusal?.providers.includes(provider) ? updates.refusal.text : undefined
  // A new settled state from the host says more than the last press's note; passing through Connecting does not.
  useEffect(() => { if (tile.kind !== 'connecting') setNote(current => current && current.kind !== tile.kind ? null : current) }, [tile.kind])
  /** The control in this tile's actions that last held focus, while it holds it or was taken away holding it. */
  const held = useRef<HTMLElement | null>(null)
  // The control pressed goes when the tile changes (Stop, the host finding it): focus moves to the tile's new first action
  // rather than being dropped. Only when this tile's own control was the one taken away: another tile changing, or this one
  // changing while focus is elsewhere, moves nothing. Not while a dialog is open over the page; the agent dialog hands
  // focus on as it closes.
  useEffect(() => {
    const gone = held.current
    if (!gone || gone.isConnected) return
    held.current = null
    const focused = document.activeElement
    if ((focused === null || focused === document.body || !focused.isConnected) && !document.querySelector('[role="dialog"]')) actions.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }, [tile.kind])
  // Update, Try again and Cancel update go as the host takes them. Focus moves to the host's chip, which follows the
  // update, and never to Disconnect, where a second Enter would disconnect the client being updated (#480).
  useEffect(() => {
    const gone = held.current
    if (!gone || gone.isConnected) return
    const focused = document.activeElement
    if (focused !== null && focused !== document.body && focused.isConnected) return
    const chip = document.querySelector<HTMLElement>(`[data-host-providers="${CSS.escape(host.id)}"] .host-client-updates__chip`)
    const target = actions.current?.querySelector<HTMLElement>('[data-update-action]:not(:disabled)') ?? chip
    // Nothing of the update to go to: the control that went is left for the effect above, as before.
    if (!target) return
    held.current = null
    target.focus()
  }, [parts.phase, host.id])
  const focusIn =(event: React.FocusEvent<HTMLDivElement>): void => { if (event.target instanceof HTMLElement) held.current = event.target }
  // Focus leaving for somewhere else lets go. A control removed or disabled while focused (Stop turning into Stopping…)
  // lost focus to the app rather than to the user, so it stays held for the effect above to replace.
  const focusOut = (event: React.FocusEvent<HTMLDivElement>): void => {
    const target = event.target
    queueMicrotask(() => {
      const dropped = !target.isConnected || target instanceof HTMLButtonElement && target.disabled
      if (held.current === target && !dropped && !actions.current?.contains(document.activeElement)) held.current = null
    })
  }
  const act = async (action: Pending): Promise<void> => {
    const before = tile.kind
    setPending(action); setNote(null)
    try {
      const result = await bridge.providerAction({ id: host.id, provider, action })
      // Check again that finds nothing new says so; its refusal is the same sentence the tile already stands for.
      if (action === 'refresh') setNote({ text: msg`Checked again. Nothing changed on ${hostName}.`, kind: before })
      else if (result.error) setNote({ text: result.error, kind: before })
    } catch (failure) {
      setNote({ text: failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : msg`${hostName} did not answer. Nothing was changed. Try again.`, kind: before })
    } finally { setPending(null) }
  }
  /** Show thread: the Threads page, on the job's thread. The job carries on. */
  const showThread = (): void => {
    if (!working?.threadId) return
    void agents?.command({ type: 'select-thread', threadId: working.threadId }).catch(() => undefined)
    app?.actions.navigate('threads')
  }
  const stop = async (): Promise<void> => {
    if (!working || stopping) return
    setStopping(true)
    try { await bridge.command({ type: 'stop-provider-job', id: working.id }) }
    catch (failure) { setNote({ text: failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : msg`The agent could not be stopped. Try again.`, kind: 'working' }) }
    finally { setStopping(false) }
  }
  const shownNote: LaterWords = refused ?? (note && note.kind === tile.kind ? note.text : jobNote(job, tile.kind) || parts.note || '')
  const jobCase = hostProviderJobCase(status)
  const action = (): ReactNode => {
    // Keys keep a pressed control from turning into another one in place: Stop must not become Check again under focus.
    if (working) {
      const thread = working.threadTitle
      return <div className="host-provider__actions">
        <Button key="show" variant="secondary" disabled={!working.threadId} aria-label={t`Show thread ${thread}`} onClick={showThread}>{t`Show thread`}</Button>
        <Button key="stop" variant="ghost" disabled={stopping} aria-label={t`Stop the agent working on ${name} on ${hostName}`} onClick={() => void stop()}>{stopping ? t`Stopping…` : t({ message: 'Stop', comment: 'Stops the agent installing or fixing a provider on a host.' })}</Button>
      </div>
    }
    if (tile.kind === 'connected') {
      const disconnect = <Button key="disconnect" variant="ghost" disabled={pending !== null} aria-label={t`Disconnect ${name} on ${hostName}`} onClick={() => void act('disconnect')}>{pending ? i18n._(PENDING_LABEL[pending]) : t`Disconnect`}</Button>
      // Update beside Disconnect, as the pick drew it: the tile's own update, run on this host.
      return parts.action ? <div className="host-provider__actions">{parts.action}{disconnect}</div> : disconnect
    }
    if (tile.kind === 'off') return <Button variant="secondary" disabled={pending !== null} aria-label={t`Connect ${name} on ${hostName}`} onClick={() => void act('connect')}>{pending ? i18n._(PENDING_LABEL[pending]) : t({ message: 'Connect', comment: 'Connects a provider on a host.' })}</Button>
    if (tile.kind === 'signed-out') {
      // OpenCode connects with no sign-in and signs in to model sources under the tiles instead (#1107).
      if (provider === 'opencode') return null
      if (!PROVIDER_SIGN_IN_SHAPES[provider]) return <SignInCommand host={host.name} provider={provider} />
      return <Button variant="primary" aria-label={t`Sign in to ${name} on ${hostName} from this computer`} onClick={() => onSignIn(provider)}>{t`Sign in`}</Button>
    }
    if (jobCase) {
      // Have my agent install it (update it, fix it), with Check again beside it (ADR-0035).
      return <div className="host-provider__actions">
        <Button key="agent" variant="primary" aria-label={`${HOST_PROVIDER_JOB_WORDS[jobCase].button.replace(/ it$/u, ` ${name}`)} on ${host.name}`} onClick={() => onAgent(provider, jobCase)}>{HOST_PROVIDER_JOB_WORDS[jobCase].button}</Button>
        <Button key="check" variant="ghost" disabled={pending !== null} aria-label={t`Check ${hostName} for ${name} again`} onClick={() => void act('refresh')}>{pending ? i18n._(PENDING_LABEL[pending]) : t`Check again`}</Button>
      </div>
    }
    return null
  }
  return <li className="host-provider" data-kind={tile.kind} data-provider={provider} data-update={parts.phase === 'current' ? undefined : parts.phase} aria-labelledby={titleId}>
    <div className="host-provider__top">
      <span className="host-provider__mark" aria-hidden="true"><ProviderMark provider={provider} name={name} size={16} /></span>
      <h5 id={titleId}>{name}</h5>
    </div>
    <p className="host-provider__state"><span className="host-provider__dot" aria-hidden="true" />{tile.state}</p>
    {working ? <p className="host-provider__detail tt-paragraph"><Trans>In the thread <b>{workingThread}</b> on this computer.</Trans></p>
      : tile.detail ? <p className="host-provider__detail">{tile.detail}</p> : null}
    {parts.line}{parts.below ? <div className="host-client-update__below">{parts.below}</div> : null}
    <div ref={actions} className="host-provider__act" onFocus={focusIn} onBlur={focusOut}>{action()}</div>
    <p className={typeof shownNote === 'string' ? 'host-provider__note' : 'host-provider__note tt-paragraph'} role="status">{shownWords(shownNote)}</p>
  </li>
}

/**
 * A connected host's providers, under its row in Settings > Hosts & phones (ADR-0037, layout B of `prototype/host-providers`):
 * Show providers opens a tile for each provider this build offers, and each tile acts on that host alone. Sign in opens a small dialog
 * that runs the provider's own sign-in on the host and finishes it in this computer's browser. A provider the host cannot
 * use offers an agent to install, update or fix it (ADR-0035), and its tile follows that agent while it works. Under the
 * tiles, a connected OpenCode's Model sources block signs the host's own OpenCode in to model sources (#1107).
 */
export function HostProviders({ host, providers, bridge, job, choice, updates, run }: {
  readonly host: HostStatus; readonly providers: readonly AgentProviderStatus[]; readonly bridge: HostsBridge
  /** The host's client updates and its update line, only from a host that offers them (#480). */
  readonly updates?: readonly ProviderClientUpdate[] | undefined
  readonly run?: ClientUpdateRun | undefined
  /** The provider job running or last ended, whichever host it is for; each tile shows it only when it is its own. */
  readonly job?: HostProviderJobState | undefined
  /** The models an agent can run on, shared with Have my agent set this up. */
  readonly choice?: HostSetupChoice | undefined
}): ReactNode {
  const { t } = useLingui()
  const hostName = host.name
  const heldProviders = useHeldProviders()
  const [open, setOpen] = useState(false)
  const [signingIn, setSigningIn] = useState<HostProviderId | null>(null)
  const [agent, setAgent] = useState<{ readonly provider: HostProviderId; readonly jobCase: HostProviderJobCase } | null>(null)
  const gridId = useId()
  const grid = useRef<HTMLUListElement>(null)
  const own = job?.hostId === host.id ? job : undefined
  const opencodeBridge = useMemo(() => heldProviders.has('opencode') ? undefined : hostOpenCodeBridge(bridge, host.id), [bridge, host.id, heldProviders])
  const opencodeConnected = providers.some(item => item.id === 'opencode' && item.connection === 'connected')
  // A host from before #1107, or one whose OpenCode is held, sends no OpenCode row: it gets no tile to connect (#1143).
  const opencodeOnHost = providers.some(item => item.id === 'opencode')
  const shownProviders = HOST_PROVIDER_ORDER.filter(provider => !heldProviders.has(provider) && (provider !== 'opencode' || opencodeOnHost))
  const view = useHostClientUpdates(host.id, updates, HOST_PROVIDER_ORDER)
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<TileUpdates['refusal']>()
  /** Update, Update all, Try again and Cancel update: each asks the host, which answers at once and runs its line. */
  const send = useCallback<SendClientUpdate>(async (action, ids) => {
    setSending(true); setRefusal(undefined)
    try {
      const result = await bridge.updateClients({ id: host.id, action, providers: [...ids] })
      if (result.error) setRefusal({ providers: ids, text: result.error })
      return result.error
    } catch (failure) {
      const text = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : msg`${hostName} did not answer. Nothing was changed. Try again.`
      setRefusal({ providers: ids, text })
      return text
    } finally { setSending(false) }
  }, [bridge, host.id, hostName])
  const tileUpdates: TileUpdates | undefined = updates ? { view, run, send, busy: sending, refusal } : undefined
  /**
   * The dialog closes onto its tile. Escape gives focus back to the button that opened it; Start removes that button, so
   * focus goes to the working tile's first action instead of being dropped.
   */
  const closeAgent = (): void => {
    const provider = agent?.provider
    setAgent(null)
    setTimeout(() => {
      const focused = document.activeElement
      if (provider && (focused === null || focused === document.body || !focused.isConnected)) grid.current?.querySelector<HTMLElement>(`[data-provider="${provider}"] .host-provider__act button:not(:disabled)`)?.focus()
    }, 0)
  }
  return <div className="host-providers" data-host-providers={host.id}>
    <div className="host-providers__bar">
      <Button variant="ghost" className="host-providers__toggle" aria-expanded={open} aria-controls={open ? gridId : undefined}
        aria-label={open ? t`Hide providers on ${hostName}` : t`Show providers on ${hostName}`} onClick={() => setOpen(value => !value)}>
        {open ? t`Hide providers` : t`Show providers`}
      </Button>
      {updates ? <HostClientUpdatesChip host={host.name} hostId={host.id} view={view} run={run} busy={sending} refusal={refusal?.text} send={send} /> : null}
    </div>
    {open ? <div id={gridId} className="host-providers__panel">
      <ul ref={grid} className="host-providers__grid" aria-label={t`Providers on ${hostName}`}>
        {shownProviders.map(provider => <ProviderTile key={provider} host={host} provider={provider} bridge={bridge}
          status={providers.find(item => item.id === provider)} job={own?.provider === provider ? own : undefined}
          onSignIn={setSigningIn} onAgent={(id, jobCase) => setAgent({ provider: id, jobCase })} updates={tileUpdates} />)}
      </ul>
      {opencodeBridge && opencodeConnected ? <OpenCodeModelSources bridge={opencodeBridge} host={host.name} /> : null}
      {heldProviders.has('opencode') || opencodeOnHost ? null : <p className="host-providers__foot">{opencodeNotOnHost(host.name)}</p>}
      <p className="host-providers__foot tt-paragraph"><Trans>{hostName} connects each provider that is signed in when its host starts. A provider you disconnect stays off.</Trans></p>
    </div> : null}
    {signingIn ? <HostProviderSignIn host={host} provider={signingIn} bridge={bridge} onClose={() => setSigningIn(null)} /> : null}
    {agent ? <HostProviderAgent host={host} provider={agent.provider} jobCase={agent.jobCase} choice={choice} bridge={bridge} onClose={closeAgent} /> : null}
  </div>
}
