import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Circle, Info, LoaderCircle, X } from 'lucide-react'
import { bootChangeRestarts, bootUnsupportedSentence, lingerAccount, type HostBootAction, type HostBootState } from '../../../../shared/bootStart'
import type { HostsBridge, HostStatus } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { HostsModal } from './HostsModal'
import { FixCommand } from './HostSetupChecklist'
import './hostBoot.css'

/**
 * Start at boot in Settings > Hosts (ADR-0054, variant C of `docs/prototypes/host-tailnet-prototype.html` with A's
 * controls): the offer on Add host's connected card, and the row's More menu items, each opening a consent modal that
 * says what changes on the host. A change that would restart a host with working threads asks the busy-host question
 * first, the way Update does (ADR-0040). Main runs the change; this window shows where it stands.
 */

/** Whether the host starts at boot now: its unit is this installation's and enabled. */
export const bootStartOn = (host: HostStatus): boolean => host.bootStart?.installed === true && host.bootStart.enabled
/** Whether start at boot can be changed from the row: the host is connected, and its launch said it can start at boot. */
export const canChangeBoot = (host: HostStatus): boolean => host.phase === 'connected' && host.bootStart?.supported === true
/** The More menu's item for start at boot, which opens its modal. */
export const bootMenuLabel = (host: HostStatus): string => bootStartOn(host) ? 'Stop starting at boot…' : 'Start at boot…'
/** Whether the change restarts the host, by the rule main asks the busy-host question by. */
const restartsHost = (host: HostStatus, change: 'install' | 'remove'): boolean => bootChangeRestarts(change, { owned: host.owned === true, bootStart: host.bootStart })

/** The account on the host: the SSH target's user, or the one the linger command names. */
function account(host: HostStatus): string | undefined {
  if (host.target.includes('@')) return host.target.slice(0, host.target.lastIndexOf('@'))
  return lingerAccount(host.bootStart?.fix)
}
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
/** What the change is called in a sentence, a button, and the press that runs it. */
const VERB = { install: 'Start at boot', remove: 'Stop starting at boot' } as const

type Mark = 'ok' | 'act' | 'fail' | 'wait'
const MARK_LABEL: Record<Mark, string> = { ok: 'Done', act: 'Sotto does this', fail: 'Needs you', wait: 'Not yet' }
/** One line of what Sotto found on the host, or of what changes there. */
interface Check { readonly mark: Mark; readonly title: string; readonly text: ReactNode; readonly fix?: { readonly text?: string | undefined; readonly command: string } | undefined }
function Checks({ label, items }: { readonly label: string; readonly items: readonly Check[] }): ReactNode {
  return <ul className="host-boot__checks" aria-label={label}>
    {items.map(item => <li key={item.title} data-mark={item.mark}>
      <span className="host-boot__mark" role="img" aria-label={MARK_LABEL[item.mark]}>
        {item.mark === 'ok' ? <Check size={16} aria-hidden="true" /> : item.mark === 'fail' ? <X size={16} aria-hidden="true" /> : item.mark === 'act' ? <Info size={16} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
      </span>
      <div className="host-boot__check"><p><b>{item.title}</b> · {item.text}</p>{item.fix ? <FixCommand fix={item.fix} /> : null}</div>
    </li>)}
  </ul>
}

/** What Start at boot's modal says before the press: what Sotto found on the host, and what changes there. */
function InstallConsent({ host }: { readonly host: HostStatus }): ReactNode {
  const { name } = host, user = account(host), who = user ?? 'its account', whose = user ? `${user}’s` : 'the account’s'
  const status = host.bootStart
  return <>
    <p className="host-boot__lead">{name}’s host then starts when {name} starts, so its threads come back after a restart without this computer signing in over SSH.</p>
    <Checks label={`What Sotto found on ${name}`} items={[
      { mark: 'ok', title: 'systemd', text: `${name} runs it, so it can start the host for ${who}.` },
      status?.linger
        ? { mark: 'ok', title: 'Linger', text: `On for ${who}, so the host starts before anyone signs in to ${name} and keeps running after they sign out.` }
        : { mark: 'act', title: 'Linger, first', text: `Off. Sotto turns it on for ${who} before anything else, so the host starts before anyone signs in to ${name} and keeps running after they sign out. If ${name} asks for an administrator, nothing on ${name} changes: run this there, then press Start at boot again. Sotto never runs sudo.`,
          ...(status?.fix ? { fix: { command: status.fix } } : {}) },
    ]} />
    <Checks label={`What changes on ${name}`} items={[
      { mark: 'act', title: 'A unit', text: <><span className="host-boot__mono">sotto-host.service</span> in {whose} systemd folder, and a small script beside the host.</> },
      restartsHost(host, 'install')
        ? { mark: 'act', title: 'One restart, now', text: 'The host Sotto started restarts under the unit. Turns running there stop; drafts and history stay. If a thread is working, Sotto asks first.' }
        : { mark: 'act', title: 'No restart', text: `Sotto did not start the host running on ${name}, so it keeps running as it is. The unit takes over the next time ${name} starts.` },
    ]} />
  </>
}

/** What Stop starting at boot's modal says before the press. */
function RemoveConsent({ host }: { readonly host: HostStatus }): ReactNode {
  const { name } = host
  return <p className="host-boot__lead">Sotto removes <span className="host-boot__mono">sotto-host.service</span> and its script from {name}{restartsHost(host, 'remove')
    ? `, and, while ${name} is switched on, restarts the host once outside the unit, so it keeps running. Turns running there stop; drafts and history stay. If a thread is working, Sotto asks first.`
    : `. The host running there is not the unit’s, so it keeps running as it is.`} After {name} restarts, its host starts again only when this computer connects over SSH.</p>
}

/** The busy-host question (ADR-0040): the change restarts a host whose threads are working. */
function BusyQuestion({ view }: { readonly view: HostBootState }): ReactNode {
  const { name, working } = view
  if (view.phase === 'waiting') {
    return <p className="host-boot__lead">{name}’s host {view.change === 'install' ? 'starts at boot' : 'stops starting at boot'} once its threads finish. {working} still working.</p>
  }
  return <>
    <p className="host-boot__lead">{plural(working, 'thread', 'threads')} on {name} {working === 1 ? 'is' : 'are'} working. {view.change === 'install' ? 'Starting at boot' : 'Stopping start at boot'} restarts {name}’s host, which stops {working === 1 ? 'it' : 'them'}.</p>
    <p className="host-boot__quiet">Only the work in progress on {working === 1 ? 'that turn' : 'those turns'} is lost. Drafts and history stay.</p>
  </>
}

/** Tailscale's approval page, for a sign-in this change is waiting on (ADR-0053). */
function ApprovalButton({ host, onOpenApproval }: { readonly host: HostStatus; readonly onOpenApproval: () => void }): ReactNode {
  return host.tailscale?.waiting && host.tailscale.url
    ? <span><Button variant="secondary" aria-label={`Open the Tailscale approval page for ${host.name}`} onClick={onOpenApproval}>Open approval page</Button></span> : null
}

/**
 * While the launch script runs the change, and Tailscale's approval when a sign-in the change needs waits for it: an
 * admin connection's (ADR-0053), or the reconnect after the host restarted.
 */
function Changing({ host, view, onOpenApproval }: { readonly host: HostStatus; readonly view: HostBootState; readonly onOpenApproval: () => void }): ReactNode {
  const { name } = host
  const approval = host.tailscale?.waiting === true
  const words = view.change === 'install'
    ? `${host.bootStart?.linger === false ? 'Turning on linger, then installing' : 'Installing'} the unit on ${name}.${view.restarts ? ' The host restarts once under it, and this computer connects again.' : ''}`
    : `Removing the unit from ${name}.${view.restarts ? ' The host restarts once outside it, and this computer connects again.' : ''}`
  return <div className="hosts-notice host-boot__work" role="status">
    <LoaderCircle size={16} aria-hidden="true" className="hosts-spin" />
    <div className="host-boot__work-copy">
      <p>{approval ? `Waiting for your approval in Tailscale. ${name} uses Tailscale SSH, which asks you to approve this connection in your browser. ${VERB[view.change]} carries on once you approve.` : words}</p>
      {approval ? <ApprovalButton host={host} onOpenApproval={onOpenApproval} /> : null}
    </div>
  </div>
}

/**
 * What came of it: done, or why not, with the command to run on the host where there is one. A host that restarted is
 * said to be connected again only once it is; until then Sotto is connecting to it, through Tailscale's approval if it
 * asks for one.
 */
function Outcome({ host, view, onOpenApproval }: { readonly host: HostStatus; readonly view: HostBootState; readonly onOpenApproval: () => void }): ReactNode {
  const { name } = view
  if (view.phase === 'done') {
    const connected = host.phase === 'connected'
    const again = connected ? 'and is connected again.' : host.tailscale?.waiting ? 'and Sotto connects to it again once you approve it in Tailscale.' : 'and Sotto is connecting to it again.'
    const words = view.change === 'install'
      ? `${name}’s host starts at boot. ${view.restarted ? `It restarted once under its systemd unit ${again}` : `The host running there keeps running, and the unit takes over the next time ${name} starts.`}`
      : `${name}’s host no longer starts at boot. ${view.restarted ? `It restarted once outside the unit ${again} ` : ''}After ${name} restarts, its host starts again only when this computer connects over SSH.`
    return <>
      <p className="host-boot__done" role="status"><Check size={16} aria-hidden="true" />{words}</p>
      {view.restarted && !connected ? <ApprovalButton host={host} onOpenApproval={onOpenApproval} /> : null}
    </>
  }
  const failure = view.failure
  if (!failure) return null
  if (failure.kind === 'linger') {
    return <>
      <p className="host-boot__lead">Nothing changed on {name}. Its host is still running as before, and this computer is still connected.</p>
      <Checks label={`Start at boot on ${name}`} items={[
        { mark: 'fail', title: 'Linger', text: failure.message, fix: failure.fix },
        { mark: 'wait', title: 'Unit', text: 'Not installed.' },
        { mark: 'wait', title: 'Restart', text: 'None.' },
      ]} />
    </>
  }
  return <div className="hosts-notice hosts-notice--error host-boot__failure" role="alert">
    <p>{failure.message}</p>
    {failure.fix ? <FixCommand fix={failure.fix} /> : null}
  </div>
}

/** A failure in one sentence, the way the card and the row say it: linger's says first that nothing changed. */
const failureSentence = (view: HostBootState): string => view.failure?.kind === 'linger'
  ? `Nothing changed on ${view.name}, and its host is still running as before. ${view.failure.message}` : view.failure?.message ?? ''

/** Sends one press for a host's start at boot; a refusal comes back in words. */
function useBootPress(bridge: HostsBridge, id: string, onError: (message: string | null) => void): (action: HostBootAction) => Promise<void> {
  return async action => {
    onError(null)
    try { await bridge.command({ type: 'host-boot', id, action }) }
    catch (error) { onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : 'Start at boot did not change. Nothing was changed. Try again.') }
  }
}
/**
 * Puts the change away when what shows it goes: a question nobody answered is cancelled, and a result is dismissed. A
 * change waiting for its threads, or running, carries on: the row says so, and shows a failure until it is dismissed.
 */
function usePutAwayOnClose(bridge: HostsBridge, id: string, view: HostBootState | undefined, shown: boolean): void {
  const latest = useRef({ view, shown })
  latest.current = { view, shown }
  useEffect(() => () => {
    const { view: last, shown: mine } = latest.current
    if (!last || !mine) return
    const action: HostBootAction | undefined = last.phase === 'confirm' ? 'cancel' : last.phase === 'done' || last.phase === 'failed' ? 'dismiss' : undefined
    if (action) void bridge.command({ type: 'host-boot', id, action }).catch(() => undefined)
  }, [bridge, id])
}

/** The modal's title for the step it is on. */
function dialogTitle(view: HostBootState | undefined, change: 'install' | 'remove', name: string): string {
  if (!view || view.phase === 'confirm') return change === 'install' ? `Start ${name}’s host at boot?` : `Stop starting ${name}’s host at boot?`
  const install = view.change === 'install'
  switch (view.phase) {
    case 'waiting': return `Waiting for ${name}’s threads`
    case 'changing': return install ? `Starting ${name}’s host at boot…` : `Stopping ${name}’s host starting at boot…`
    case 'done': return install ? `${name}’s host starts at boot` : `${name}’s host no longer starts at boot`
    default: return view.failure?.kind === 'linger' ? `${name}’s host does not start at boot yet` : install ? `${name}’s host does not start at boot` : `Stop starting at boot did not finish on ${name}`
  }
}

/**
 * The modal's buttons for the step it is on. The busy-host question's answers name their button's words first, then
 * what they leave out (ADR-0040).
 */
function DialogFooter({ view, change, name, press, onClose }: {
  readonly view: HostBootState | undefined; readonly change: 'install' | 'remove'; readonly name: string
  readonly press: (action: HostBootAction) => Promise<void>; readonly onClose: () => void
}): ReactNode {
  const verb = VERB[view?.change ?? change]
  if (!view) {
    return <>
      <Button variant="secondary" onClick={onClose}>{change === 'install' ? 'Cancel' : 'Keep starting at boot'}</Button>
      <Button onClick={() => void press(change)}>{verb}</Button>
    </>
  }
  if (view.phase === 'confirm' || view.phase === 'waiting') {
    const threads = plural(view.working, 'thread', 'threads')
    return <>
      <Button variant="ghost" aria-label={`Cancel, and leave start at boot on ${name} as it is`} onClick={() => { void press('cancel').then(onClose) }}>Cancel</Button>
      <Button variant="secondary" aria-label={`Stop ${threads} now, then ${verb.toLowerCase()} on ${name}`} onClick={() => void press('stop-threads')}>Stop {threads} now</Button>
      {view.phase === 'confirm'
        ? <Button data-autofocus aria-label={`Wait until they finish, then ${verb.toLowerCase()} on ${name}`} onClick={() => void press('when-idle')}>Wait until they finish</Button>
        : <Button data-autofocus onClick={onClose} aria-label={`Close. Sotto still waits for ${name}’s threads`}>Close</Button>}
    </>
  }
  if (view.phase === 'changing') return <Button data-autofocus variant="secondary" onClick={onClose} aria-label={`Close. ${verb} carries on`}>Close</Button>
  if (view.phase === 'failed' && view.failure?.kind !== 'unsupported') {
    return <>
      <Button variant="secondary" onClick={onClose}>Close</Button>
      <Button data-autofocus onClick={() => void press(view.change)}>{view.failure?.kind === 'linger' ? 'Start at boot' : 'Try again'}</Button>
    </>
  }
  return <Button data-autofocus onClick={onClose}>{view.phase === 'done' ? 'Done' : 'Close'}</Button>
}

/**
 * Start at boot… and Stop starting at boot… from the row's More menu: the consent modal, then the busy-host question if
 * it asks, the change as it runs, and what came of it. Escape and Cancel change nothing before the press; closing it
 * while it waits for threads or runs leaves the change going, and the row says so.
 */
export function HostBootDialog({ host, view: current, change, bridge, onClose }: {
  readonly host: HostStatus
  /** The host's start at boot change in main, if there is one. */
  readonly view: HostBootState | undefined
  readonly change: 'install' | 'remove'
  readonly bridge: HostsBridge
  readonly onClose: () => void
}): ReactNode {
  const [error, setError] = useState<string | null>(null)
  // A change that ended well while nothing showed it is put away as the modal opens: the menu item already says where
  // start at boot stands. A failure is not, since nobody may have read it yet: the modal opens on it. A change under
  // way, or a question it asked, is this modal's too.
  const [stale, setStale] = useState(() => current?.phase === 'done')
  useEffect(() => { if (stale) void bridge.command({ type: 'host-boot', id: host.id, action: 'dismiss' }).catch(() => undefined) }, [])
  const view = stale && current?.phase === 'done' ? undefined : current
  usePutAwayOnClose(bridge, host.id, view, view !== undefined)
  const send = useBootPress(bridge, host.id, setError)
  const press = (action: HostBootAction): Promise<void> => { setStale(false); return send(action) }
  const openApproval = (): void => void bridge.command({ type: 'open-approval', id: host.id }).catch(() => undefined)
  // Each step's own buttons replace the last step's, so focus moves on to the one a press most likely wants next.
  const body = useRef<HTMLDivElement>(null)
  const phase = view?.phase
  useEffect(() => {
    if (phase) body.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [phase])
  return <HostsModal title={dialogTitle(view, change, host.name)} onClose={onClose} busy={view?.phase === 'changing'} className="host-boot-dialog"
    footer={<DialogFooter view={view} change={change} name={host.name} press={press} onClose={onClose} />}>
    <div ref={body} className="host-boot">
      {!view ? (change === 'install' ? <InstallConsent host={host} /> : <RemoveConsent host={host} />)
        : view.phase === 'confirm' || view.phase === 'waiting' ? <BusyQuestion view={view} />
          : view.phase === 'changing' ? <Changing host={host} view={view} onOpenApproval={openApproval} />
            : <Outcome host={host} view={view} onOpenApproval={openApproval} />}
      {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div> : null}
    </div>
  </HostsModal>
}

/**
 * Add host's connected card (ADR-0054, "What the owner sees"): one consented press that starts the new host at boot, the
 * card's own words being the consent, then what came of it. The change is drawn first, whatever the host's row knows,
 * since a restart takes the host's start at boot status away until it connects again. Without a change, a host that
 * cannot start at boot gets the one sentence saying why, and a host whose launch did not say gets nothing.
 */
export function HostBootOffer({ host, view, bridge }: { readonly host: HostStatus; readonly view: HostBootState | undefined; readonly bridge: HostsBridge }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  usePutAwayOnClose(bridge, host.id, view, true)
  const press = useBootPress(bridge, host.id, setError)
  const openApproval = (): void => void bridge.command({ type: 'open-approval', id: host.id }).catch(() => undefined)
  const status = host.bootStart
  const { name } = host
  const start = <Button variant="secondary" onClick={() => void press('install')}>Start {name}’s host at boot</Button>
  let body: ReactNode
  if (view?.phase === 'confirm' || view?.phase === 'waiting') {
    const threads = plural(view.working, 'thread', 'threads')
    body = <><BusyQuestion view={view} />
      <div className="host-boot__actions">
        {view.phase === 'confirm' ? <Button variant="secondary" aria-label={`Wait until they finish, then start ${name}’s host at boot`} onClick={() => void press('when-idle')}>Wait until they finish</Button> : null}
        <Button variant="secondary" aria-label={`Stop ${threads} now, then start ${name}’s host at boot`} onClick={() => void press('stop-threads')}>Stop {threads} now</Button>
        <Button variant="ghost" aria-label={`Cancel, and leave ${name}’s host as it is`} onClick={() => void press('cancel')}>Cancel</Button>
      </div></>
  } else if (view?.phase === 'changing') body = <Changing host={host} view={view} onOpenApproval={openApproval} />
  else if (view?.phase === 'done' && view.change === 'install') body = <Outcome host={host} view={view} onOpenApproval={openApproval} />
  else if (view?.phase === 'failed' && view.failure) {
    body = <>
      <p className="host-boot__failed" role="alert"><AlertTriangle size={16} aria-hidden="true" />{failureSentence(view)}</p>
      {view.failure.fix ? <FixCommand fix={view.failure.fix} /> : null}
      {view.failure.kind === 'unsupported' ? null : <div className="host-boot__actions">{start}</div>}
    </>
  } else if (!status) return null
  else if (!status.supported) body = <p className="host-boot__quiet">{bootUnsupportedSentence(status.reason)}</p>
  else if (bootStartOn(host)) body = <p className="host-boot__done"><Check size={16} aria-hidden="true" />{name}’s host starts at boot.</p>
  else {
    const user = account(host)
    body = <>
      <p><b>Start {name}’s host at boot</b></p>
      <p className="host-boot__quiet">Then {name}’s threads come back after {name} restarts, without this computer signing in over SSH. Sotto adds a systemd user unit for {user ?? 'your account'} on {name}{status.linger ? '' : ' and turns on linger for that account'}; {restartsHost(host, 'install')
        ? 'the host restarts once now, which stops turns running there.' : `the host running there keeps running, and the unit takes over the next time ${name} starts.`}{status.linger ? '' : ` If ${name} asks for an administrator, nothing changes there, and Sotto shows the command to run.`}</p>
      <div className="host-boot__actions">{start}</div>
    </>
  }
  return <div className="host-boot-offer">
    {body}
    {error ? <p className="host-boot__failed" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</p> : null}
  </div>
}

/**
 * A start at boot change that failed while no modal or card showed it, because it was closed while the change waited
 * for its threads or ran (ADR-0054). It stays on the host's row, saying what happened, whether anything was lost and
 * what to do, with the command to run where there is one, until Dismiss puts it away.
 */
export function HostBootResult({ view, onDismiss }: { readonly view: HostBootState; readonly onDismiss: () => void }): ReactNode {
  if (view.phase !== 'failed' || !view.failure) return null
  const { name, failure } = view
  return <section className="hosts-notice hosts-notice--error host-boot-result" role="status" aria-label={`What Sotto said about start at boot on ${name}`}>
    <AlertTriangle size={16} aria-hidden="true" />
    <div className="host-boot__work-copy">
      <p>{failureSentence(view)}</p>
      {failure.fix ? <FixCommand fix={failure.fix} /> : null}
      <span className="host-boot__actions"><Button variant="ghost" aria-label={`Dismiss what Sotto said about start at boot on ${name}`} onClick={onDismiss}>Dismiss</Button></span>
    </div>
  </section>
}
