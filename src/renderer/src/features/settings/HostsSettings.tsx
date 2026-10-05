import { isCompositionKey } from '../../agents/composerKeys'
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Laptop, MoreHorizontal, Plus, Server, Smartphone } from 'lucide-react'
import { type HostPhonesView, type HostSetupChoice, type HostSetupState, type HostsBridge, type HostsCommand, type HostsState, type HostStatus } from '../../../../shared/hosts'
import type { HostProviderJobState } from '../../../../shared/hostProviders'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { HostDialog, HostsModal, type HostDialogMode } from './HostDialog'
import { TailscaleRow, useTailscale } from './TailscaleConnect'
import { HostProviders, connectedProvidersLabel } from './HostProviders'
import { HostPhonesDialog, hostPhonesLabel } from './HostPhonesDialog'
import { hostQuestionKey, useHostQuestionDismissals } from './hostQuestionDismissals'
import { useOptionalAgents } from '../../agents/AgentContext'
import type { AgentClientHost, AgentProviderStatus } from '../../../../shared/agents'
import './hosts.css'

/** What a saved host's row says about it, after "SSH forge ·". */
export function hostStatusLabel(host: HostStatus): string {
  if (host.phase === 'connected') return 'Connected'
  if (host.phase === 'connecting' && host.tailscale?.waiting) return 'Waiting for your approval in Tailscale'
  if (host.phase === 'connecting') return host.reconnecting ? 'Reconnecting…' : 'Connecting…'
  if (host.phase === 'error') return 'Needs attention'
  return host.enabled ? 'Not connected' : 'Switched off'
}
/** A host of another version Sotto started is still reached through the SSH session kept for Stop host. */
const reachable = (host: HostStatus): boolean => host.phase === 'connected' || host.phase === 'error' && host.owned === true
/** Stop host is offered only for a host Sotto started that it can still reach. */
const canStop = (host: HostStatus): boolean => host.owned === true && reachable(host)

type MenuAction = 'stop' | 'rename' | 'edit' | 'forget'

/** The row's More menu: arrow keys move through it, Escape and Tab close it, and focus goes back to its button. */
function HostMenu({ host, onAction }: { readonly host: HostStatus; readonly onAction: (action: MenuAction) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const items: { action: MenuAction; label: string; danger?: boolean }[] = [
    ...(canStop(host) ? [{ action: 'stop' as const, label: 'Stop host' }] : []),
    { action: 'rename', label: 'Rename' },
    { action: 'edit', label: 'Edit connection' },
    { action: 'forget', label: `Forget ${host.name}…`, danger: true },
  ]
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (event: PointerEvent): void => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const close = (refocus = true): void => { setOpen(false); if (refocus) button.current?.focus() }
  return <span className="hosts-menu">
    <Button ref={button} variant="ghost" iconOnly aria-label={`More for ${host.name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}><MoreHorizontal size={16} /></Button>
    {open ? <div ref={menu} id={menuId} role="menu" aria-label={`${host.name} actions`} className="hosts-menu__list"
      onKeyDown={event => {
        const entries = [...menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []]
        const index = entries.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        else if (event.key === 'Tab') close(false)
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); entries[(index + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus() }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? entries[0] : entries.at(-1))?.focus() }
      }}>
      {items.map(item => <button key={item.action} type="button" role="menuitem" tabIndex={-1} className="tt-focusable" data-danger={item.danger || undefined}
        onClick={() => { close(); onAction(item.action) }}>{item.label}</button>)}
    </div> : null}
  </span>
}

/**
 * A saved host: its name, where it is and how it is, the switch that keeps it connected, and its menu. A connected host
 * also says how many of its providers are connected, and Show providers opens its tiles (ADR-0037).
 */
function HostRow({ host, onCommand, onAction, onOpenPhones, phones, providers, client, bridge, job, choice }: {
  readonly host: HostStatus
  /** The host's phone access as this computer last read it, and the press that opens its Phones dialog (ADR-0050). */
  readonly phones?: HostPhonesView | undefined
  readonly onOpenPhones: () => void
  readonly onCommand: (command: HostsCommand) => Promise<boolean>
  readonly onAction: (host: HostStatus, action: MenuAction) => void
  readonly providers?: readonly AgentProviderStatus[] | undefined
  /** The host as the window has it: its client updates, only from a host that offers them (#480). */
  readonly client?: Pick<AgentClientHost, 'clientUpdates' | 'clientUpdateRun'> | undefined
  readonly bridge?: HostsBridge | undefined
  readonly job?: HostProviderJobState | undefined
  readonly choice?: HostSetupChoice | undefined
}): ReactNode {
  const { dismissedQuestionKeys, resumeQuestion, registerAnswerTarget } = useHostQuestionDismissals(bridge)
  const rowRef = useRef<HTMLElement>(null)
  const questionKey = hostQuestionKey(host)
  const waitingForAnswer = questionKey !== null && dismissedQuestionKeys.has(questionKey)
  const route = `SSH ${host.target}${host.sshPort ? `, port ${host.sshPort}` : ''}`
  const shown = host.phase === 'connected' && providers?.length ? providers : undefined
  const phonesLabel = hostPhonesLabel(phones)
  return <section ref={rowRef} className="hosts-row" aria-label={host.name} data-phase={host.phase}>
    <span className="hosts-row__icon" aria-hidden="true"><Server size={18} /></span>
    <div className="hosts-row__info">
      <h4>{host.name}</h4>
      <p className="hosts-row__meta">{route} · <span data-phase={host.phase}>{waitingForAnswer ? 'Waiting for your answer' : hostStatusLabel(host)}</span>{shown ? ` · ${connectedProvidersLabel(shown)}` : ''}{phonesLabel ? ` · ${phonesLabel}` : ''}</p>
      {host.error ? <p className="hosts-row__error" role="alert">{host.error}</p> : null}
    </div>
    <div className="hosts-row__actions">
      {waitingForAnswer ? <Button aria-label={`Answer ${host.name}`} ref={button => {
        if (!button) return
        return registerAnswerTarget(questionKey, () => {
          if (button.closest('[hidden]')) return
          rowRef.current?.scrollIntoView?.({ block: 'center', behavior: 'instant' })
          button.focus({ preventScroll: true })
        })
      }}
        onClick={() => resumeQuestion(questionKey)}>Answer</Button> : null}
      {/* Tailscale SSH holds a reconnect until it is approved, and only the browser can approve it. */}
      {host.phase === 'connecting' && host.tailscale?.waiting && host.tailscale.url ? <Button variant="secondary" aria-label={`Open the Tailscale approval page for ${host.name}`}
        onClick={() => void onCommand({ type: 'open-approval', id: host.id })}>Open approval page</Button> : null}
      {/* The sentence under a host that needs attention asks for one of these; each is also where it always is. */}
      {host.phase === 'error' && canStop(host) ? <Button variant="secondary" onClick={() => onAction(host, 'stop')}>Stop host</Button> : null}
      {host.phase === 'error' && host.enabled && !canStop(host) ? <Button variant="secondary" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: true })}>Connect again</Button> : null}
      {host.phase === 'connected' || phones?.state ? <Button variant="secondary" aria-label={`Open phone access for ${host.name}`} onClick={onOpenPhones}><Smartphone size={16} aria-hidden="true" />Phones…</Button> : null}
      <span className="hosts-switch">
        <span className="hosts-switch__state" aria-hidden="true">{host.enabled ? 'On' : 'Off'}</span>
        <button type="button" role="switch" aria-checked={host.enabled} aria-label={`Keep ${host.name} connected, now and when Sotto starts`}
          className="tt-toggle tt-focusable hosts-switch__control" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: !host.enabled })}>
          <span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span>
        </button>
      </span>
      <HostMenu host={host} onAction={action => onAction(host, action)} />
    </div>
    {shown && bridge ? <HostProviders host={host} providers={shown} bridge={bridge} job={job} choice={choice} updates={client?.clientUpdates} run={client?.clientUpdateRun} /> : null}
  </section>
}

function RenameDialog({ host, onRename, onClose }: { readonly host: HostStatus; readonly onRename: (name: string) => Promise<string | null>; readonly onClose: () => void }): ReactNode {
  const [name, setName] = useState(host.name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputId = useId()
  const hintId = useId()
  const save = async (): Promise<void> => {
    if (!name.trim() || saving) return
    setSaving(true)
    const failure = await onRename(name.trim())
    setSaving(false)
    if (failure === null) onClose(); else setError(failure)
  }
  return <HostsModal title={`Rename ${host.name}`} onClose={onClose} busy={saving}
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!name.trim() || saving} onClick={() => void save()}>Save name</Button></>}>
    <div className="hosts-dialog__fields"><div className="tt-field">
      <label className="tt-field__label" htmlFor={inputId}>Host name</label>
      <input id={inputId} className="tt-input tt-focusable" value={name} maxLength={80} aria-describedby={hintId} onChange={event => setName(event.target.value)}
        onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
      <p className="tt-field__description" id={hintId}>Shown on this row and beside the host's projects and threads. The SSH connection does not change.</p>
    </div></div>
    {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div> : null}
  </HostsModal>
}

/** A host setup running without its dialog, or ended and not yet put away (ADR-0035). */
function HostSetupLine({ setup, onShow, onDismiss }: { readonly setup: HostSetupState; readonly onShow: () => void; readonly onDismiss: () => void }): ReactNode {
  const running = setup.phase === 'starting' || setup.phase === 'running'
  return <div className="hosts-setup-line" role="status" data-phase={setup.phase}>
    <p>{running ? <><b>{setup.modelName}</b> is setting up {setup.name} in the thread <b>{setup.threadTitle}</b>.{setup.waiting === 'connection'
      ? setup.attempt?.prompt ? ` SSH is waiting for your answer before it connects to ${setup.name}. Show setup to answer it.` : ` Tailscale is waiting for you to approve the connection to ${setup.name}. Show setup to approve it.`
      : setup.waiting ? ' It is waiting for your answer there.' : ''}</>
      : setup.phase === 'connected' ? <>{setup.name} is set up and connected. <b>{setup.modelName}</b> set it up in the thread <b>{setup.threadTitle}</b>.</>
        : setup.phase === 'stopped' ? <>The setup of {setup.name} stopped. {setup.error ?? 'Nothing was saved as a host.'}</>
          : <>{setup.error ?? `The setup of ${setup.name} could not carry on. Nothing was saved as a host.`}</>}</p>
    <Button variant="secondary" aria-label={`Show setup of ${setup.name}`} onClick={onShow}>Show setup</Button>
    {running ? null : <Button variant="ghost" aria-label={`Dismiss setup of ${setup.name}`} onClick={onDismiss}>Dismiss</Button>}
  </div>
}

export function HostsSettings({ localHostEnabled, onLocalHostChange, bridge = window.sotto?.hosts }: {
  localHostEnabled: boolean; onLocalHostChange: (enabled: boolean) => Promise<boolean>; bridge?: HostsBridge | undefined
}): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localSaveFailed, setLocalSaveFailed] = useState(false)
  const [dialog, setDialog] = useState<HostDialogMode | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [forgetId, setForgetId] = useState<string | null>(null)
  const [stopId, setStopId] = useState<string | null>(null)
  const [phonesId, setPhonesId] = useState<string | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const tailscale = useTailscale(bridge)
  // Each connected host's providers, as that host publishes them (ADR-0037).
  const clientHosts = useOptionalAgents()?.state?.host.clientHosts
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError('Hosts could not be read. Reopen Settings and try again.') })
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const run = async (command: HostsCommand): Promise<boolean> => {
    if (!bridge) return false
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The host could not be updated. Nothing was changed. Try again.'); return false }
  }
  const forget = state?.hosts.find(host => host.id === forgetId)
  const stopping = state?.hosts.find(host => host.id === stopId)
  const renaming = state?.hosts.find(host => host.id === renameId)
  const phonesHost = state?.hosts.find(host => host.id === phonesId)
  const closePhones = useRef(() => setPhonesId(null)).current
  const forgetDescription = (host: HostStatus): string => {
    const stop = reachable(host) && host.owned ? ' It also stops the host Sotto started there.' : ''
    const access = reachable(host)
      ? "This revokes this computer's access on the host and removes the saved connection."
      : `This removes the saved connection. This computer's access on ${host.name} stays until you connect again or revoke it there.`
    return `${access}${stop} Threads stay on the host.`
  }
  const act = (host: HostStatus, action: MenuAction): void => {
    if (action === 'stop') setStopId(host.id)
    else if (action === 'rename') setRenameId(host.id)
    else if (action === 'edit') setDialog({ kind: 'edit', host })
    else setForgetId(host.id)
  }
  const closeDialog = useRef(() => setDialog(null)).current
  return <div className="hosts-settings">
    <div className="hosts-local">
      <span className="hosts-row__icon hosts-row__icon--local" aria-hidden="true"><Laptop size={18} /></span>
      <div className="hosts-local__copy"><h3>This computer</h3><p>Runs threads on this computer beside your remote hosts. A change takes effect after you restart Sotto. Saved data stays.</p></div>
      <div>
        <Toggle label="Run the local host" checked={localHostEnabled} onCheckedChange={enabled => { void onLocalHostChange(enabled).then(saved => setLocalSaveFailed(!saved)) }} />
        {localSaveFailed ? <p className="tt-field__error" role="alert">The local host setting could not be saved. Nothing was changed. Try again.</p> : null}
      </div>
    </div>
    {bridge ? <TailscaleRow control={tailscale} /> : null}
    {state && state.localHostRunning !== localHostEnabled && <div className="hosts-restart"><p>Restart Sotto to apply the local host setting.</p><Button variant="secondary" onClick={() => void run({ type: 'restart' })}>Restart Sotto</Button></div>}
    <p>Dictation and automatic paste always use this computer. They do not paste into a remote host.</p>
    <div className="hosts-heading"><h3>Remote hosts</h3><Button ref={addButton} variant="secondary" disabled={!bridge} onClick={() => setDialog({ kind: 'add' })}><Plus size={16} aria-hidden="true" />Add host</Button></div>
    <p>Connect to machines you reach over SSH. Sotto signs in with your SSH setup, starts the host if needed and pairs this computer. Hosts that are on reconnect when Sotto starts, and a host Sotto started keeps running until you stop it.</p>
    {/* A setup the dialog was closed on carries on in its thread, and one that ended stays until put away: this is the way back to it. */}
    {state?.setup && !dialog ? <HostSetupLine setup={state.setup} onShow={() => setDialog({ kind: 'setup' })} onDismiss={() => void run({ type: 'dismiss-setup', id: state.setup!.id })} /> : null}
    <div className="hosts-list">
      {state?.hosts.map(host => <HostRow key={host.id} host={host} onCommand={run} onAction={act} bridge={bridge} job={state.providerJob} choice={state.setupChoice}
        phones={state.phones?.find(item => item.id === host.id)} onOpenPhones={() => setPhonesId(host.id)}
        providers={host.hostId ? clientHosts?.find(item => item.hostId === host.hostId)?.providers : undefined}
        client={host.hostId ? clientHosts?.find(item => item.hostId === host.hostId) : undefined} />)}
      {state && !state.hosts.length ? <p className="hosts-empty">No remote hosts yet.</p> : null}
    </div>
    {error && <p className="hosts-error" role="alert">{error}</p>}
    {dialog && bridge ? <HostDialog key={dialog.kind === 'edit' ? dialog.host.id : dialog.kind} mode={dialog} bridge={bridge} state={state} tailscale={tailscale} onClose={closeDialog} /> : null}
    {phonesHost && bridge ? <HostPhonesDialog host={phonesHost} view={state?.phones?.find(item => item.id === phonesHost.id)} bridge={bridge} onClose={closePhones} /> : null}
    {renaming ? <RenameDialog host={renaming} onClose={() => setRenameId(null)} onRename={async name => {
      if (!bridge) return 'Hosts are not available in this window.'
      try { setState(await bridge.command({ type: 'rename', id: renaming.id, name })); return null }
      catch (failure) { return failure instanceof Error ? failure.message : 'The name could not be saved. Try again.' }
    }} /> : null}
    {forget && <ConfirmationDialog title={`Forget ${forget.name}?`} confirmLabel="Forget host" cancelLabel="Keep host" onCancel={() => setForgetId(null)} onConfirm={() => run({ type: 'forget', id: forget.id })}
      fallbackFocusRef={addButton} failureMessage={error} description={forgetDescription(forget)} />}
    {stopping && <ConfirmationDialog title={`Stop the host on ${stopping.name}?`} confirmLabel="Stop host" cancelLabel="Keep it running" onCancel={() => setStopId(null)}
      failureMessage={error} onConfirm={() => run({ type: 'stop-host', id: stopping.id })}
      description={`This stops the host Sotto started on ${stopping.name} and switches it off. Turns running there are interrupted; threads and history stay in its data folder. Switch it on to start it again.`} />}
  </div>
}
