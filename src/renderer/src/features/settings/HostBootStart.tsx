import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Circle, Info, LoaderCircle, X } from 'lucide-react'
import { bootUnsupportedSentence, type HostBootAction, type HostBootState } from '../../../../shared/bootStart'
import type { HostsBridge, HostStatus } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { HostsModal } from './HostDialog'
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

/** The account on the host: the SSH target's user, or the one the linger command names. */
function account(host: HostStatus): string | undefined {
  if (host.target.includes('@')) return host.target.slice(0, host.target.lastIndexOf('@'))
  return host.bootStart?.fix?.replace(/^sudo loginctl enable-linger /u, '').replace(/^'(.*)'$/u, '$1') || undefined
}
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
/** What the change is called in a sentence, a button, and the press that runs it. */
const VERB = { install: 'Start at boot', remove: 'Stop starting at boot' } as const

type Mark = 'ok' | 'act' | 'fail' | 'wait'
const MARK_LABEL: Record<Mark, string> = { ok: 'Done', act: 'Sotto does this', fail: 'Needs you', wait: 'Not yet' }
/** One line of what Sotto found on the host, or of what changes there. */
interface Check { readonly mark: Mark; readonly title: string; readonly text: ReactNode; readonly fix?: { readonly text: string; readonly command: string } | undefined }
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
  const restarts = host.owned === true && status?.active !== true
  return <>
    <p className="host-boot__lead">{name}’s host then starts when {name} starts, so its threads come back after a restart without this computer signing in over SSH.</p>
    <Checks label={`What Sotto found on ${name}`} items={[
      { mark: 'ok', title: 'systemd', text: `${name} runs it, so it can start the host for ${who}.` },
      status?.linger
        ? { mark: 'ok', title: 'Linger', text: `On for ${who}, so the host starts before anyone signs in to ${name} and keeps running after they sign out.` }
        : { mark: 'act', title: 'Linger, first', text: `Off. Sotto turns it on for ${who} before anything else, so the host starts before anyone signs in to ${name} and keeps running after they sign out. If ${name} asks for an administrator, nothing on ${name} changes: run this there, then press Start at boot again. Sotto never runs sudo.`,
          ...(status?.fix ? { fix: { text: '', command: status.fix } } : {}) },
    ]} />
    <Checks label={`What changes on ${name}`} items={[
      { mark: 'act', title: 'A unit', text: <><span className="host-boot__mono">sotto-host.service</span> in {whose} systemd folder, and a small script beside the host.</> },
      restarts
        ? { mark: 'act', title: 'One restart, now', text: 'The host Sotto started restarts under the unit. Turns running there stop; drafts and history stay. If a thread is working, Sotto asks first.' }
        : { mark: 'act', title: 'No restart', text: `Sotto did not start the host running on ${name}, so it keeps running as it is. The unit takes over the next time ${name} starts.` },
    ]} />
  </>
}

/** What Stop starting at boot's modal says before the press. */
function RemoveConsent({ host }: { readonly host: HostStatus }): ReactNode {
  const { name } = host
  return <p className="host-boot__lead">Sotto removes <span className="host-boot__mono">sotto-host.service</span> and its script from {name}{host.bootStart?.active
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

/** While the launch script runs the change, and Tailscale's approval when an admin connection waits for it (ADR-0053). */
function Changing({ host, view, onOpenApproval }: { readonly host: HostStatus; readonly view: HostBootState; readonly onOpenApproval: () => void }): ReactNode {
  const { name } = host
  const approval = host.adminSignIn === true && host.tailscale?.waiting === true
  const words = view.change === 'install'
    ? `${host.bootStart?.linger === false ? 'Turning on linger, then installing' : 'Installing'} the unit on ${name}.${view.restarts ? ' The host restarts once under it, and this computer connects again.' : ''}`
    : `Removing the unit from ${name}.${view.restarts ? ' The host restarts once outside it, and this computer connects again.' : ''}`
  return <div className="hosts-notice host-boot__work" role="status">
    <LoaderCircle size={16} aria-hidden="true" className="hosts-spin" />
    <div className="host-boot__work-copy">
      <p>{approval ? `Waiting for your approval in Tailscale. ${name} uses Tailscale SSH, which asks you to approve this connection in your browser. ${VERB[view.change]} carries on once you approve.` : words}</p>
      {approval && host.tailscale?.url ? <span><Button variant="secondary" aria-label={`Open the Tailscale approval page for ${name}`} onClick={onOpenApproval}>Open approval page</Button></span> : null}
    </div>
  </div>
}

/** What came of it: done, or why not, with the command to run on the host where there is one. */
function Outcome({ view }: { readonly view: HostBootState }): ReactNode {
  const { name } = view
  if (view.phase === 'done') {
    const words = view.change === 'install'
      ? `${name}’s host starts at boot. ${view.restarted ? 'It restarted once under its systemd unit and is connected again.' : `The host running there keeps running, and the unit takes over the next time ${name} starts.`}`
      : `${name}’s host no longer starts at boot. ${view.restarted ? 'It restarted once outside the unit and is connected again. ' : ''}After ${name} restarts, its host starts again only when this computer connects over SSH.`
    return <p className="host-boot__done" role="status"><Check size={16} aria-hidden="true" />{words}</p>
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
 * change waiting for its threads, or running, carries on, and the row says so.
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
  // A result left from an earlier press is put away as the modal opens: it is not this modal's. A change under way, or a
  // question it asked, is.
  const ended = (phase: HostBootState['phase'] | undefined): boolean => phase === 'done' || phase === 'failed'
  const [stale, setStale] = useState(() => ended(current?.phase))
  useEffect(() => { if (stale) void bridge.command({ type: 'host-boot', id: host.id, action: 'dismiss' }).catch(() => undefined) }, [])
  const view = stale && ended(current?.phase) ? undefined : current
  usePutAwayOnClose(bridge, host.id, view, view !== undefined)
  const send = useBootPress(bridge, host.id, setError)
  const press = (action: HostBootAction): Promise<void> => { setStale(false); return send(action) }
  const { name } = host
  const verb = VERB[view?.change ?? change]
  const threads = plural(view?.working ?? 0, 'thread', 'threads')
  const title = !view || view.phase === 'confirm' ? (change === 'install' ? `Start ${name}’s host at boot?` : `Stop starting ${name}’s host at boot?`)
    : view.phase === 'waiting' ? `Waiting for ${name}’s threads`
      : view.phase === 'changing' ? (view.change === 'install' ? `Starting ${name}’s host at boot…` : `Stopping ${name}’s host starting at boot…`)
        : view.phase === 'done' ? (view.change === 'install' ? `${name}’s host starts at boot` : `${name}’s host no longer starts at boot`)
          : view.failure?.kind === 'linger' ? `${name}’s host does not start at boot yet`
            : view.change === 'install' ? `${name}’s host does not start at boot` : `Stop starting at boot did not finish on ${name}`
  const retry = view?.failure?.kind === 'linger' || view?.failure?.kind === 'failed'
  const footer = !view ? <>
      <Button variant="secondary" onClick={onClose}>{change === 'install' ? 'Cancel' : 'Keep starting at boot'}</Button>
      <Button onClick={() => void press(change)}>{verb}</Button>
    </>
    // The busy-host question's answers name their button's words first, then what they leave out (ADR-0040).
    : view.phase === 'confirm' ? <>
      <Button variant="ghost" aria-label={`Cancel, and leave start at boot on ${name} as it is`} onClick={() => { void press('cancel').then(onClose) }}>Cancel</Button>
      <Button variant="secondary" aria-label={`Stop ${threads} now, then ${verb.toLowerCase()} on ${name}`} onClick={() => void press('stop-threads')}>Stop {threads} now</Button>
      <Button data-autofocus aria-label={`Wait until they finish, then ${verb.toLowerCase()} on ${name}`} onClick={() => void press('when-idle')}>Wait until they finish</Button>
    </>
    : view.phase === 'waiting' ? <>
      <Button variant="ghost" aria-label={`Cancel, and leave start at boot on ${name} as it is`} onClick={() => { void press('cancel').then(onClose) }}>Cancel</Button>
      <Button variant="secondary" aria-label={`Stop ${threads} now, then ${verb.toLowerCase()} on ${name}`} onClick={() => void press('stop-threads')}>Stop {threads} now</Button>
      <Button data-autofocus onClick={onClose} aria-label={`Close. Sotto still waits for ${name}’s threads`}>Close</Button>
    </>
    : view.phase === 'changing' ? <Button data-autofocus variant="secondary" onClick={onClose} aria-label={`Close. ${verb} carries on`}>Close</Button>
      : <>
        {retry ? <Button variant="secondary" onClick={onClose}>Close</Button> : null}
        {retry ? <Button data-autofocus onClick={() => void press(view.change)}>{view.failure?.kind === 'linger' ? 'Start at boot' : 'Try again'}</Button> : <Button data-autofocus onClick={onClose}>{view.phase === 'done' ? 'Done' : 'Close'}</Button>}
      </>
  // Each step's own buttons replace the last step's, so focus moves on to the one a press most likely wants next.
  const body = useRef<HTMLDivElement>(null)
  const phase = view?.phase
  useEffect(() => {
    if (phase) body.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [phase])
  return <HostsModal title={title} onClose={onClose} busy={view?.phase === 'changing'} className="host-boot-dialog" footer={footer}>
    <div ref={body} className="host-boot">
      {!view ? (change === 'install' ? <InstallConsent host={host} /> : <RemoveConsent host={host} />)
        : view.phase === 'confirm' || view.phase === 'waiting' ? <BusyQuestion view={view} />
          : view.phase === 'changing' ? <Changing host={host} view={view} onOpenApproval={() => void bridge.command({ type: 'open-approval', id: host.id }).catch(() => undefined)} />
            : <Outcome view={view} />}
      {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div> : null}
    </div>
  </HostsModal>
}

/**
 * Add host's connected card (ADR-0054, "What the owner sees"): one consented press that starts the new host at boot, the
 * card's own words being the consent, then what came of it. A host that cannot start at boot gets the one sentence
 * saying why, and a host whose launch did not say gets nothing.
 */
export function HostBootOffer({ host, view, bridge }: { readonly host: HostStatus; readonly view: HostBootState | undefined; readonly bridge: HostsBridge }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  usePutAwayOnClose(bridge, host.id, view, true)
  const press = useBootPress(bridge, host.id, setError)
  const status = host.bootStart
  if (!status) return null
  const { name } = host
  if (!status.supported) return <div className="host-boot-offer"><p className="host-boot__quiet">{bootUnsupportedSentence(status.reason)}</p></div>
  const user = account(host)
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
  } else if (view?.phase === 'changing') body = <Changing host={host} view={view} onOpenApproval={() => void bridge.command({ type: 'open-approval', id: host.id }).catch(() => undefined)} />
  else if (view?.phase === 'done' && view.change === 'install') body = <Outcome view={view} />
  else if (view?.phase === 'failed' && view.failure) {
    body = <>
      <p className="host-boot__failed" role="alert"><AlertTriangle size={16} aria-hidden="true" />{view.failure.kind === 'linger' ? `Nothing changed on ${name}, and its host is still running as before. ${view.failure.message}` : view.failure.message}</p>
      {view.failure.fix ? <FixCommand fix={view.failure.fix} /> : null}
      {view.failure.kind === 'unsupported' ? null : <div className="host-boot__actions">{start}</div>}
    </>
  } else if (bootStartOn(host)) body = <p className="host-boot__done"><Check size={16} aria-hidden="true" />{name}’s host starts at boot.</p>
  else {
    const restarts = host.owned === true && !status.active
    body = <>
      <p><b>Start {name}’s host at boot</b></p>
      <p className="host-boot__quiet">Then {name}’s threads come back after {name} restarts, without this computer signing in over SSH. Sotto adds a systemd user unit for {user ?? 'your account'} on {name}{status.linger ? '' : ' and turns on linger for that account'}; {restarts
        ? 'the host restarts once now, which stops turns running there.' : `the host running there keeps running, and the unit takes over the next time ${name} starts.`}{status.linger ? '' : ` If ${name} asks for an administrator, nothing changes there, and Sotto shows the command to run.`}</p>
      <div className="host-boot__actions">{start}</div>
    </>
  }
  return <div className="host-boot-offer">
    {body}
    {error ? <p className="host-boot__failed" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</p> : null}
  </div>
}
