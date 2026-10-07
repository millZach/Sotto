import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import type { HostDevice, TailscaleSummary } from '../../../../shared/hostDevices'
import './hostDevices.css'

/** A saved host, as far as the list needs one: its name and the host part of its SSH target. */
export interface SavedHostName { readonly name: string; readonly host: string }

/** "8 days ago", from an ISO time; rounded down, and never less than a minute. */
export function timeAgo(iso: string, now: number): string {
  const minutes = Math.max(1, Math.floor((now - Date.parse(iso)) / 60_000))
  const [count, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 24 * 60 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / (24 * 60)), 'day']
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

/** Why a device is listed under "Can't use now", or undefined when it can be added. */
export function unavailableReason(device: HostDevice, saved: readonly SavedHostName[], now: number): string | undefined {
  const names = new Set(device.names.map(name => name.toLowerCase()))
  const existing = saved.find(item => names.has(item.host.toLowerCase()))
  if (existing) return `Already added as ${existing.name}`
  if (device.unavailable === 'phone') return 'A phone cannot run the host'
  if (device.unavailable === 'this-computer') return 'This computer runs its own local host'
  if (device.unavailable === 'git-service') return 'A Git service, not a computer'
  if (device.unavailable === 'offline') return device.tailscale?.lastSeen ? `Offline, last seen ${timeAgo(device.tailscale.lastSeen, now)}` : 'Offline'
  return undefined
}

/**
 * The line under a device's name: its system, where the SSH configuration sends it, and where Sotto learned
 * of it. A computer without Tailscale SSH may still run its own SSH server, which Sotto has not checked; a
 * phone runs no host either way.
 */
export function deviceDetails(device: HostDevice): string {
  const tailscale = device.tailscale ? device.tailscale.ssh ? 'Tailscale SSH' : device.unavailable === 'phone' ? 'Tailscale' : 'Tailscale, SSH server not checked' : undefined
  return [device.os, device.detail, tailscale, device.sshConfiguration ? 'SSH configuration' : undefined, device.knownHost ? 'Known hosts' : undefined].filter(Boolean).join(' · ')
}

/** The sentence at the foot of the list. */
function footnote(tailscale: TailscaleSummary | null): string | null {
  if (tailscale?.state === 'running') return `Don't see your machine? Install Tailscale on it and sign in as ${tailscale.loginName || tailscale.user}.`
  if (tailscale?.state === 'off') return 'Connect to Tailscale to see the machines on your tailnet here.'
  if (tailscale?.state === 'missing') return 'Get Tailscale to see the machines on your tailnet here.'
  return null
}

type Entry = { readonly kind: 'device'; readonly device: HostDevice; readonly reason?: string | undefined } | { readonly kind: 'other' }
const OTHER: Entry = { kind: 'other' }
const OTHER_LABEL = 'Another SSH host…'
const entryName = (entry: Entry): string => entry.kind === 'other' ? OTHER_LABEL : entry.device.name
const pickable = (entry: Entry | undefined): boolean => entry !== undefined && (entry.kind === 'other' || entry.reason === undefined)
/** Typed letters jump to a device when they come this close together. */
const TYPEAHEAD_MS = 600

function Dot({ device }: { readonly device: HostDevice }): ReactNode {
  return device.tailscale ? <span className="hosts-dot" data-online={device.tailscale.online} aria-hidden="true" /> : <span className="hosts-dot hosts-dot--none" aria-hidden="true" />
}

/**
 * Add host's Device field: a button that opens the list of machines Sotto can see, from this computer's
 * Tailscale and SSH setup. Machines Sotto can add come first; the ones it cannot use now are listed greyed
 * with the reason, and are read out with it. **Another SSH host…** is always last and switches the field to
 * typing a host. From the keyboard: the arrow keys, Home and End move, typed letters jump to a name, Enter
 * or Space picks, and Escape closes the list before it closes the dialog.
 */
export function DevicePicker({ devices, failed = false, tailscale, saved, value, onPick, onOther, disabled, autoFocus = false }: {
  /** Null while the devices are being read. */
  readonly devices: readonly HostDevice[] | null
  /** The devices could not be read; the list still offers Another SSH host. */
  readonly failed?: boolean
  readonly tailscale: TailscaleSummary | null
  readonly saved: readonly SavedHostName[]
  readonly value: HostDevice | null
  readonly onPick: (device: HostDevice) => void
  readonly onOther: () => void
  readonly disabled: boolean
  readonly autoFocus?: boolean
}): ReactNode {
  const labelId = useId(), listId = useId()
  const button = useRef<HTMLButtonElement>(null)
  // The list opens with the dialog, since choosing a machine is what Add host is for.
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState(-1)
  const typed = useRef({ text: '', at: 0 })
  /** When Enter or Space was last handled, so the click a browser adds after it does not act twice. */
  const keyed = useRef(0)
  const now = Date.now()
  const listed = (devices ?? []).map(device => ({ kind: 'device' as const, device, reason: unavailableReason(device, saved, now) }))
  const usable = listed.filter(entry => entry.reason === undefined)
  const greyed = listed.filter(entry => entry.reason !== undefined)
  const entries: Entry[] = [...usable, ...greyed, OTHER]
  const shown = open && !disabled
  const optionId = (index: number): string => `${listId}-${index}`
  const firstChoice = (): number => {
    const current = value ? entries.findIndex(entry => entry.kind === 'device' && entry.device.target === value.target) : -1
    return current >= 0 ? current : entries.findIndex(pickable)
  }
  // A list that fills in while open starts on the first machine Sotto can add.
  useEffect(() => { if (shown && (active < 0 || active >= entries.length)) setActive(firstChoice()) })
  useEffect(() => { if (shown && active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' }) }, [shown, active])
  useEffect(() => { if (autoFocus) button.current?.focus() }, [autoFocus])
  // A press elsewhere closes the list once it is a click, not on the press: the list opens in place, and
  // closing it as the press starts would move what is under the pointer before the click lands.
  const field = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!shown) return
    const outside = (event: MouseEvent): void => { if (!field.current?.contains(event.target as Node)) { setOpen(false); setActive(-1) } }
    // Heard from the next turn, so the click that opened the dialog, still on its way up, does not close the list.
    const listen = window.setTimeout(() => document.addEventListener('click', outside))
    return () => { window.clearTimeout(listen); document.removeEventListener('click', outside) }
  }, [shown])
  const close = (): void => { setOpen(false); setActive(-1) }
  const choose = (index: number): void => {
    const entry = entries[index]
    // A greyed device stays in the list, which already says why it cannot be used.
    if (!pickable(entry)) return
    close()
    if (entry!.kind === 'other') onOther()
    else onPick(entry!.device)
  }
  const jump = (key: string): void => {
    const at = Date.now()
    const text = (at - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLowerCase()
    typed.current = { text, at }
    // A first letter moves on from the highlighted entry; more letters keep refining from it.
    const start = text.length === 1 ? active + 1 : Math.max(active, 0)
    for (let step = 0; step < entries.length; step += 1) {
      const index = (start + step) % entries.length
      if (entryName(entries[index]!).toLowerCase().startsWith(text)) { setActive(index); return }
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') keyed.current = Date.now()
    const letter = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
    if (!shown) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) || letter) {
        event.preventDefault()
        setOpen(true)
        setActive(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : event.key === 'ArrowUp' && !value ? entries.length - 1 : firstChoice())
        if (letter) jump(event.key)
      }
      return
    }
    const last = entries.length - 1
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { close(); return }
    if (letter) { event.preventDefault(); jump(event.key); return }
    const move: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last, PageDown: Math.min(last, active + 10), PageUp: Math.max(0, active - 10) }
    if (event.key === 'ArrowUp' && event.altKey) { event.preventDefault(); choose(active); return }
    if (event.key in move) { event.preventDefault(); setActive(move[event.key]!); return }
    // Space picks too, except while letters are being typed, when it may be part of a name.
    if (event.key === 'Enter' || (event.key === ' ' && Date.now() - typed.current.at >= TYPEAHEAD_MS)) { event.preventDefault(); choose(active) }
  }
  const option = (entry: Entry, index: number): ReactNode => {
    const usableEntry = pickable(entry)
    const common = {
      id: optionId(index), role: 'option', 'aria-selected': index === active, 'aria-disabled': usableEntry ? undefined : true,
      'data-active': index === active || undefined,
      onMouseEnter: () => { if (usableEntry) setActive(index) }, onClick: () => choose(index),
    } as const
    if (entry.kind === 'other') return <li key="other" {...common} className="hosts-devices__other"><span className="hosts-dot hosts-dot--none" aria-hidden="true" /><b>{OTHER_LABEL}</b><small>Type a host name or user@server</small></li>
    const details = deviceDetails(entry.device)
    return <li key={`${entry.device.target}-${index}`} {...common}>
      <Dot device={entry.device} /><b>{entry.device.name}</b>
      <small>{details}{entry.reason ? <>{details ? ' · ' : ''}<span className="hosts-devices__why">{entry.reason}</span></> : null}</small>
    </li>
  }
  const foot = footnote(tailscale)
  return <div ref={field} className="tt-field hosts-devices">
    <span className="tt-field__label" id={labelId}>Device</span>
    <button ref={button} type="button" role="combobox" className="hosts-devices__button tt-focusable" disabled={disabled} data-autofocus
      aria-haspopup="listbox" aria-expanded={shown} aria-controls={listId} aria-labelledby={labelId}
      aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
      onClick={() => {
        // A click a screen reader sends has no key before it; one a browser adds after Enter or Space was handled already.
        if (Date.now() - keyed.current < 500) return
        if (shown) close(); else { setOpen(true); setActive(firstChoice()) }
      }}
      onKeyDown={onKeyDown}>
      {value ? <><Dot device={value} /><span className="hosts-devices__value"><b>{value.name}</b><small>{deviceDetails(value)}</small></span></>
        : <span className="hosts-devices__value hosts-devices__placeholder">{devices === null ? 'Looking for your devices…' : 'Choose a device'}</span>}
      <ChevronDown size={16} aria-hidden="true" className="hosts-devices__chevron" />
    </button>
    {/* Pressing inside the list keeps focus on the button, which owns the keyboard. */}
    <div className="hosts-devices__popup" hidden={!shown} onMouseDown={event => event.preventDefault()}>
      {devices === null ? <p className="hosts-devices__status">Looking for your devices…</p>
        : failed ? <p className="hosts-devices__status" role="status">Sotto could not read the devices on this computer. Nothing was changed. Choose Another SSH host to type one.</p> : null}
      <ul className="hosts-devices__list" id={listId} role="listbox" aria-labelledby={labelId}>
        {usable.length ? <li role="presentation"><ul role="group" aria-label="Can connect"><li role="presentation" className="hosts-devices__group" aria-hidden="true">Can connect</li>
          {usable.map((entry, index) => option(entry, index))}</ul></li> : null}
        {greyed.length ? <li role="presentation"><ul role="group" aria-label="Can't use now"><li role="presentation" className="hosts-devices__group" aria-hidden="true">Can't use now</li>
          {greyed.map((entry, index) => option(entry, usable.length + index))}</ul></li> : null}
        {option(OTHER, entries.length - 1)}
      </ul>
      {foot ? <p className="hosts-devices__foot">{foot}</p> : null}
    </div>
  </div>
}
