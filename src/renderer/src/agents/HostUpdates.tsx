import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, Check, Clock, Copy, LoaderCircle, Server } from 'lucide-react'
import type { HostsBridge } from '../../../shared/hosts'
import { HOST_UPDATE_STEPS, type HostUpdateAction, type HostUpdatePhase, type HostUpdateState, type HostUpdateStep } from '../../../shared/hostUpdates'
import { Button } from '../components/Button'
import { useTransientFlag, writeClipboard } from './richActions'
import './hostUpdates.css'

/** How long a finished update's note stays before it goes by itself, unless the pointer or focus is on it. */
export const HOST_UPDATE_DONE_MS = 8_000
/** Which host the pill speaks for when several need it: the one the user most needs to hear about. */
const PILL_ORDER: readonly HostUpdatePhase[] = ['updating', 'failed', 'waiting', 'confirm', 'done', 'needs']
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
const ipcMessage = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() : 'The host update did not answer. Nothing was changed. Try again.'

/**
 * Reads the host updates from the hosts state, and keeps the last list while nothing about them changes. The setter takes
 * the state a command answered with, so what a press changed is on screen before the next broadcast.
 */
function useHostUpdateList(bridge: HostsBridge | undefined): [readonly HostUpdateState[], (next: readonly HostUpdateState[] | undefined) => void] {
  const [updates, setUpdates] = useState<readonly HostUpdateState[]>([])
  const take = useCallback((next: readonly HostUpdateState[] | undefined): void => {
    setUpdates(current => JSON.stringify(current) === JSON.stringify(next ?? []) ? current : next ?? [])
  }, [])
  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.get().then(state => { if (live) take(state.updates) }, () => undefined)
    const off = bridge.onChanged(state => { if (live) take(state.updates) })
    return () => { live = false; off() }
  }, [bridge, take])
  return [updates, take]
}

/** The pill's words for the host it speaks for, or for all of them. */
export function hostUpdatePillText(updates: readonly HostUpdateState[]): { readonly text: string; readonly phase: HostUpdatePhase } {
  const top = [...updates].sort((a, b) => PILL_ORDER.indexOf(a.phase) - PILL_ORDER.indexOf(b.phase))[0]!
  if (updates.length > 1 && top.phase !== 'updating' && top.phase !== 'failed') return { text: `Updates for ${updates.length} hosts`, phase: 'needs' }
  const text = top.phase === 'waiting' ? `${top.name} waits to update`
    : top.phase === 'updating' ? `Updating ${top.name} · ${HOST_UPDATE_STEPS.indexOf(top.step ?? 'download') + 1} of 4`
      : top.phase === 'done' ? `${top.name} updated`
        : top.phase === 'failed' ? `${top.name} not updated`
          : `Update for ${top.name}`
  return { text, phase: top.phase }
}

function PhaseIcon({ phase, size }: { readonly phase: HostUpdatePhase; readonly size: number }): ReactNode {
  if (phase === 'updating') return <LoaderCircle size={size} aria-hidden="true" className="host-update__spin" />
  if (phase === 'waiting') return <Clock size={size} aria-hidden="true" className="host-update__icon--quiet" />
  if (phase === 'done') return <Check size={size} aria-hidden="true" className="host-update__icon--done" />
  if (phase === 'failed') return <AlertTriangle size={size} aria-hidden="true" className="host-update__icon--failed" />
  return <span className="host-update__dot" aria-hidden="true" />
}

/** The four steps as the panel lists them, each with what it does now or did. */
function Steps({ update }: { readonly update: HostUpdateState }): ReactNode {
  const at = HOST_UPDATE_STEPS.indexOf(update.step ?? 'download')
  const words: Readonly<Record<HostUpdateStep, { readonly title: string; readonly detail: string }>> = {
    download: { title: `Download ${update.to}`, detail: update.route === 'desktop' ? `${update.name} could not reach GitHub, so this computer is copying it over SSH.` : 'From Sotto’s releases on GitHub.' },
    check: { title: 'Check the download', detail: at > 1 ? 'The checksum matches.' : 'Its checksum has to match the release’s.' },
    install: { title: `Install beside ${update.from}`, detail: `${update.from} stays in place until ${update.to} is running.` },
    // A host that starts at boot is restarted by its systemd unit, and still starts at boot after (ADR-0054).
    restart: { title: `Restart ${update.name}’s host`, detail: update.boot ? `Its systemd unit starts ${update.to}, so it still starts at boot. ${update.name}’s threads are unavailable for a few seconds.` : `${update.name}’s threads are unavailable for a few seconds.` },
  }
  return <ol className="host-update__steps" aria-label={`Steps to update ${update.name}`}>
    {HOST_UPDATE_STEPS.map((step, index) => {
      const state = index < at ? 'done' : index === at ? 'now' : 'later'
      return <li key={step} data-state={state}>
        <span className="host-update__step-mark" aria-hidden="true">{state === 'done' ? <Check size={12} /> : state === 'now' ? <LoaderCircle size={12} className="host-update__spin" /> : index + 1}</span>
        <div>
          <div className="host-update__step-title">{words[step].title}<span className="tt-visually-hidden">{state === 'done' ? ', done' : state === 'now' ? ', in progress' : ', not started'}</span></div>
          {state === 'later' ? null : <div className="host-update__step-detail">{words[step].detail}</div>}
        </div>
      </li>
    })}
  </ol>
}

interface HostProps {
  readonly update: HostUpdateState
  readonly showCommands: boolean
  readonly refusal: string | undefined
  /** `focus` is the control that should have focus once the press has landed, by its focus key. */
  readonly onAction: (action: HostUpdateAction, focus?: string) => void
  readonly onToggleCommands: () => void
}
/** One host in the panel: where its update stands, what a press does next, and, when it failed, what to run by hand. */
function HostUpdateSection({ update, showCommands, refusal, onAction, onToggleCommands }: HostProps): ReactNode {
  const id = useId()
  const [copied, showCopied] = useTransientFlag()
  const { name, from, to, working } = update
  const threads = plural(working, 'thread', 'threads')
  const copy = (): void => { void writeClipboard(update.commands).then(() => showCopied('Copied'), () => showCopied('Could not copy')) }
  const key = (action: string): string => `${action}:${update.id}`
  // Each name starts with the button's own words, which is what someone speaking to the app says, and adds what they leave out.
  const button = (action: HostUpdateAction, label: string, variant: 'primary' | 'secondary' | 'ghost', ariaLabel?: string, focus?: string): ReactNode =>
    <Button variant={variant} data-focus-key={key(action)} aria-label={ariaLabel} onClick={() => onAction(action, focus)}>{label}</Button>
  const notNow = button('not-now', 'Not now', 'ghost', 'Not now: hide this until Sotto next starts')
  const commandsButtons = <>
    <Button variant="secondary" aria-label={`Copy commands that update ${name} by hand`} onClick={copy}><Copy size={14} aria-hidden="true" />{copied ?? 'Copy commands'}</Button>
    <Button variant="ghost" data-focus-key={key('commands')} aria-expanded={showCommands} aria-controls={`${id}-commands`} onClick={onToggleCommands}>{showCommands ? 'Hide commands' : 'Show commands'}</Button>
  </>
  let label = `${from} → ${to}`
  let body: ReactNode
  let actions: ReactNode
  if (update.phase === 'needs' && !update.owned) {
    body = <><p>{name} runs Sotto host {from}. This computer runs {to}.</p><p className="host-update__muted">Sotto did not start this host, so it cannot restart it. Update it on {name} with these commands.</p></>
    actions = <>{commandsButtons}{notNow}</>
  } else if (update.phase === 'needs') {
    body = <p className="host-update__muted">{name}’s threads keep working until you update. Updating restarts its host{update.boot ? ' through its systemd unit' : ''}, so they are unavailable for a few seconds.{update.boot ? ' It still starts at boot after.' : ''}</p>
    actions = <>{button('update', `Update ${name}`, 'primary', `Update ${name}’s host to ${to}`, key('when-idle'))}{notNow}</>
  } else if (update.phase === 'confirm') {
    body = <><p>{threads} on {name} {working === 1 ? 'is' : 'are'} working. Updating restarts {name}’s host, which stops {working === 1 ? 'it' : 'them'}.</p>
      <p className="host-update__muted">Only the work in progress on {working === 1 ? 'that turn' : 'those turns'} is lost. Drafts and history stay.</p></>
    actions = <>{button('when-idle', 'Update when they finish', 'primary')}
      {button('stop-threads', `Stop ${threads} and update`, 'secondary', `Stop ${threads} and update ${name} now`)}
      {button('cancel', 'Cancel', 'ghost', `Cancel, and leave ${name} on ${from}`, key('update'))}</>
  } else if (update.phase === 'waiting') {
    label = `${working} working`
    body = <p>{name} updates when its threads finish. {working} still working.</p>
    actions = <>{button('stop-threads', `Stop ${threads} and update now`, 'secondary')}
      {button('cancel', 'Cancel update', 'ghost', `Cancel update, and leave ${name} on ${from}`, key('update'))}</>
  } else if (update.phase === 'updating') {
    label = `Step ${HOST_UPDATE_STEPS.indexOf(update.step ?? 'download') + 1} of 4`
    body = <Steps update={update} />
    actions = update.step === 'download' || update.step === 'check' ? button('cancel', 'Cancel update', 'ghost', `Cancel update, and leave ${name} on ${from}`, key('update')) : null
  } else if (update.phase === 'done') {
    label = to
    body = <p>{name} runs Sotto {to}.</p>
    actions = button('dismiss', 'Dismiss', 'ghost', `Dismiss the note that ${name} was updated`)
  } else {
    label = `Still ${from}`
    body = <>{update.failure ? <><p><strong>{name} was not updated.</strong> {update.failure.message}</p><p>{update.failure.kept}</p><p className="host-update__muted">{update.failure.next}</p></> : <p><strong>{name} was not updated.</strong></p>}</>
    actions = <>{button('update', 'Try again', 'primary', `Try again to update ${name}`, key('when-idle'))}{commandsButtons}{notNow}</>
  }
  const offersCommands = update.phase === 'failed' || (update.phase === 'needs' && !update.owned)
  return <section className="host-update__host" data-phase={update.phase} data-host={update.id} aria-labelledby={`${id}-name`}>
    <div className="host-update__name"><Server size={16} aria-hidden="true" /><strong id={`${id}-name`} tabIndex={-1} data-focus-key={key('name')}>{name}</strong><small>{label}</small></div>
    <div className="host-update__body" aria-live="polite">{body}</div>
    {refusal || update.error ? <p className="host-update__refusal" role="alert">{refusal ?? update.error}</p> : null}
    {offersCommands && showCommands ? <pre id={`${id}-commands`} className="host-update__commands" tabIndex={0} aria-label={`Commands to update ${name} by hand`}>{update.commands}</pre> : null}
    {actions ? <div className="host-update__actions">{actions}</div> : null}
  </section>
}

/**
 * The host update pill and its panel (ADR-0040, variant C of `prototype/host-update`): a pill in the top strip beside
 * the window controls whenever a host runs an older Sotto than this computer, which opens a panel with each such host,
 * its own Update and its steps. It comes before the thread panes in keyboard order, and Escape or a click outside
 * closes the panel. Nothing updates until the user presses Update.
 */
export function HostUpdateControl({ bridge = window.sotto?.hosts, doneMs = HOST_UPDATE_DONE_MS }: { readonly bridge?: HostsBridge | undefined; readonly doneMs?: number }): ReactNode {
  const [updates, take] = useHostUpdateList(bridge)
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<ReadonlySet<string>>(() => new Set())
  const [refusal, setRefusal] = useState<{ readonly id: string; readonly message: string } | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const latest = useRef(updates)
  useEffect(() => { latest.current = updates })

  /** Focus leaves a note that is about to go: to the focused thread's composer, as after any page-level dismissal. */
  const leave = useCallback((): void => {
    if (!container.current?.contains(document.activeElement)) return
    const composer = document.querySelector<HTMLElement>('.thread-pane[data-focused] .thread-prompt textarea') ?? document.querySelector<HTMLElement>('.thread-prompt textarea')
    composer?.focus()
  }, [])
  /** One press. `focus` names the control to focus once it has landed, the host's name by default; null leaves focus alone. */
  const send = useCallback(async (id: string, action: HostUpdateAction, focus?: string | null): Promise<void> => {
    if (!bridge) return
    setRefusal(null)
    const last = latest.current.length === 1 && (action === 'dismiss' || action === 'not-now')
    if (last) leave()
    try {
      take((await bridge.command({ type: 'host-update', id, action })).updates)
      if (!last && focus !== null) setFocusKey(focus ?? `name:${id}`)
    } catch (error) { setRefusal({ id, message: ipcMessage(error) }) }
  }, [bridge, leave, take])

  // Focus follows a press to the control that comes next, or to the host's name when that control is not there.
  useEffect(() => {
    if (focusKey === null || !open) return
    const find = (key: string): HTMLElement | null | undefined => container.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
    const host = focusKey.slice(focusKey.indexOf(':') + 1)
    const target = find(focusKey) ?? find(`name:${host}`)
    setFocusKey(null)
    target?.focus()
  }, [focusKey, open, updates])

  // Nothing left to show: the panel closes with it.
  useEffect(() => { if (!updates.length) setOpen(false) }, [updates.length])

  // A finished update's note goes after a few seconds, but not while the pointer is over it or a control in it has focus.
  const doneIds = updates.filter(update => update.phase === 'done').map(update => update.id).join(',')
  useEffect(() => {
    if (!doneIds) return
    const timers = new Map<string, number>()
    const held = (id: string): boolean => {
      const box = container.current
      if (!box) return false
      const section = box.querySelector(`[data-host="${CSS.escape(id)}"]`)
      const focused = document.activeElement
      const focusHeld = box.contains(focused) && !(focused instanceof HTMLElement && focused.dataset['focusKey']?.startsWith('name:'))
      return (section?.matches(':hover') ?? false) || pill.current?.matches(':hover') === true || focusHeld
    }
    const arm = (id: string): void => {
      timers.set(id, window.setTimeout(() => { if (held(id)) arm(id); else void send(id, 'dismiss') }, doneMs))
    }
    for (const id of doneIds.split(',')) arm(id)
    return () => { for (const timer of timers.values()) window.clearTimeout(timer) }
  }, [doneIds, doneMs, send])

  // A click anywhere else closes the panel, and leaves focus where the click put it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  if (!updates.length) return null
  const close = (): void => {
    setOpen(false)
    // Escape answers a pending question the way Cancel does: the host is left as it is.
    for (const update of updates) if (update.phase === 'confirm') void send(update.id, 'cancel', null)
    pill.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault(); event.stopPropagation()
    close()
  }
  const { text, phase } = hostUpdatePillText(updates)
  return <div ref={container} className="host-update" onKeyDown={onKeyDown}>
    <button ref={pill} type="button" className="host-update__pill tt-focusable" data-phase={phase} aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`${text}. ${open ? 'Hide' : 'Show'} host updates`} title={text} data-focus-key="pill"
      onClick={() => { const next = !open; setOpen(next); if (next) setFocusKey(`name:${[...updates].sort((a, b) => PILL_ORDER.indexOf(a.phase) - PILL_ORDER.indexOf(b.phase))[0]!.id}`) }}>
      <PhaseIcon phase={phase} size={14} /><span className="host-update__pill-text">{text}</span>
    </button>
    {open ? <div id={panelId} className="host-update__panel" role="dialog" aria-label="Host updates">
      <h2 className="host-update__head">Hosts running an older Sotto</h2>
      {updates.map(update => <HostUpdateSection key={update.id} update={update} showCommands={commands.has(update.id)}
        refusal={refusal?.id === update.id ? refusal.message : undefined}
        onAction={(action, focus) => void send(update.id, action, focus)}
        onToggleCommands={() => setCommands(current => { const next = new Set(current); if (next.has(update.id)) next.delete(update.id); else next.add(update.id); return next })} />)}
    </div> : null}
  </div>
}
