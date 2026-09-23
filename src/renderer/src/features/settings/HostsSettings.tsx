import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Laptop, MoreHorizontal, Plus, Server } from 'lucide-react'
import { type HostsBridge, type HostsCommand, type HostsState, type HostStatus } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { HostDialog, HostsModal, type HostDialogMode } from './HostDialog'
import './hosts.css'

/** What a saved host's row says about it, after "SSH forge ·". */
export function hostStatusLabel(host: HostStatus): string {
  if (host.phase === 'connected') return 'Connected'
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

/** A saved host: its name, where it is and how it is, the switch that keeps it connected, and its menu. */
function HostRow({ host, onCommand, onAction }: {
  readonly host: HostStatus
  readonly onCommand: (command: HostsCommand) => Promise<boolean>
  readonly onAction: (host: HostStatus, action: MenuAction) => void
}): ReactNode {
  const route = `SSH ${host.target}${host.sshPort ? `, port ${host.sshPort}` : ''}`
  return <section className="hosts-row" aria-label={host.name} data-phase={host.phase}>
    <span className="hosts-row__icon" aria-hidden="true"><Server size={18} /></span>
    <div className="hosts-row__info">
      <h4>{host.name}</h4>
      <p className="hosts-row__meta">{route} · <span data-phase={host.phase}>{hostStatusLabel(host)}</span></p>
      {host.error ? <p className="hosts-row__error" role="alert">{host.error}</p> : null}
    </div>
    <div className="hosts-row__actions">
      {/* The sentence under a host that needs attention asks for one of these; each is also where it always is. */}
      {host.phase === 'error' && canStop(host) ? <Button variant="secondary" onClick={() => onAction(host, 'stop')}>Stop host</Button> : null}
      {host.phase === 'error' && host.enabled && !canStop(host) ? <Button variant="secondary" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: true })}>Connect again</Button> : null}
      <span className="hosts-switch">
        <span className="hosts-switch__state" aria-hidden="true">{host.enabled ? 'On' : 'Off'}</span>
        <button type="button" role="switch" aria-checked={host.enabled} aria-label={`Keep ${host.name} connected, now and when Sotto starts`}
          className="tt-toggle tt-focusable hosts-switch__control" onClick={() => void onCommand({ type: 'set-enabled', id: host.id, enabled: !host.enabled })}>
          <span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span>
        </button>
      </span>
      <HostMenu host={host} onAction={action => onAction(host, action)} />
    </div>
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
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
      <p className="tt-field__description" id={hintId}>Shown on this row and beside the host's projects and threads. The SSH connection does not change.</p>
    </div></div>
    {error ? <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div> : null}
  </HostsModal>
}

export function HostsSettings({ localHostEnabled, onLocalHostChange, bridge = window.sotto?.hosts }: {
  localHostEnabled: boolean; onLocalHostChange: (enabled: boolean) => Promise<boolean>; bridge?: HostsBridge | undefined
}): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<HostDialogMode | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [forgetId, setForgetId] = useState<string | null>(null)
  const [stopId, setStopId] = useState<string | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
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
      <Toggle label="Run the local host" checked={localHostEnabled} onCheckedChange={enabled => { void onLocalHostChange(enabled) }} />
    </div>
    {state && state.localHostRunning !== localHostEnabled && <div className="hosts-restart"><p>Restart Sotto to apply the local host setting.</p><Button variant="secondary" onClick={() => void run({ type: 'restart' })}>Restart Sotto</Button></div>}
    <p>Dictation and automatic paste always use this computer. They do not paste into a remote host.</p>
    <div className="hosts-heading"><h3>Remote hosts</h3><Button ref={addButton} variant="secondary" disabled={!bridge} onClick={() => setDialog({ kind: 'add' })}><Plus size={16} aria-hidden="true" />Add host</Button></div>
    <p>Connect to machines you reach over SSH. Sotto signs in with your SSH setup, starts the host if needed and pairs this computer. Hosts that are on reconnect when Sotto starts, and a host Sotto started keeps running until you stop it.</p>
    <div className="hosts-list">
      {state?.hosts.map(host => <HostRow key={host.id} host={host} onCommand={run} onAction={act} />)}
      {state && !state.hosts.length ? <p className="hosts-empty">No remote hosts yet.</p> : null}
    </div>
    {error && <p className="hosts-error" role="alert">{error}</p>}
    {dialog && bridge ? <HostDialog key={dialog.kind === 'edit' ? dialog.host.id : 'add'} mode={dialog} bridge={bridge} state={state} onClose={closeDialog} /> : null}
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
